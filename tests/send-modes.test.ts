import { createServer } from "node:http";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import type { PaseoApi } from "@getpaseo/client";
import type { DaemonClient } from "@getpaseo/client/internal/daemon-client";
import type { ProviderConnection, ProviderEvent } from "@getpaseo/plugin/server/provider";
import { workspaceEnable, syncBootstrap } from "../shared/contracts.js";
import { deliveryList } from "../shared/delivery.js";
import { runObserve } from "../shared/runs.js";
import { createServerContribution } from "../server/contribute.js";
import { FakeServer } from "./support/fake-server.js";

const cleanup: Array<() => void | Promise<void>> = [];
afterEach(async () => { for (const dispose of cleanup.splice(0).reverse()) await dispose(); });
const stamp = "2026-11-24T10:00:00Z";
const comment = (id: string, parent_id: string | null, content: string) => ({ id, parent_id, content, author_id: "me", author_type: "member", issue_id: "issue", type: "comment", created_at: stamp, updated_at: stamp, attachments: [] });

// This fixture drives only the public provider/RPC boundary. Host-owned queue
// retention, release and interrupt-before-prompt ordering are source contracts,
// not functionality supplied by this fixture or by the Multica provider.
async function fixture() {
  const home = await mkdtemp(join(tmpdir(), "multica-send-modes-"));
  cleanup.push(() => rm(home, { recursive: true, force: true }));
  const comments = [comment("root", null, "Discussion"), comment("other", null, "Other discussion")];
  const runs = [
    { id: "running", issue_id: "issue", agent_id: "agent-a", status: "running", trigger_comment_id: "root" },
    { id: "queued", issue_id: "issue", agent_id: "agent-a", status: "queued", trigger_comment_id: "root" },
    { id: "other-running", issue_id: "issue", agent_id: "agent-b", status: "running", trigger_comment_id: "other" },
  ];
  const writes: Array<{ path: string; body: unknown }> = [];
  let cancel: (run: typeof runs[number]) => Promise<number> = async run => { run.status = "cancelled"; return 200; };
  let save: (body: { content: string; parent_id?: string }) => Promise<number> = async () => 200;
  const http = createServer(async (request, response) => {
    response.setHeader("Content-Type", "application/json");
    const url = new URL(request.url!, "http://localhost");
    let body: unknown;
    if (request.method === "POST") {
      let text = ""; for await (const part of request) text += part;
      const input = text ? JSON.parse(text) : {};
      writes.push({ path: url.pathname, body: input });
      const run = runs.find(run => url.pathname === `/api/issues/issue/tasks/${run.id}/cancel`);
      if (run) { response.statusCode = await cancel(run); body = run; }
      else {
        response.statusCode = await save(input);
        body = comment(`saved-${writes.length}`, input.parent_id ?? null, input.content);
        if (response.statusCode === 200) comments.push(body as typeof comments[number]);
      }
    } else if (url.pathname === "/api/me") body = { id: "me", name: "Lin" };
    else if (url.pathname === "/api/workspaces") body = [{ id: "workspace", name: "Product", slug: "product" }];
    else if (url.pathname === "/api/issues") body = { issues: [{ id: "issue", workspace_id: "workspace", title: "Task", description: "Goal", status: "todo" }], total: 1 };
    else if (url.pathname === "/api/issues/issue/task-runs") body = runs;
    else if (url.pathname === "/api/agents") body = [{ id: "agent-a", name: "Agent A" }, { id: "agent-b", name: "Agent B" }];
    else if (url.pathname === "/api/issues/issue/comments") body = url.searchParams.has("thread") ? comments.filter(comment => comment.id === url.searchParams.get("thread") || comment.parent_id === url.searchParams.get("thread")) : comments;
    else { response.statusCode = 404; body = {}; }
    response.end(JSON.stringify(body));
  });
  await new Promise<void>(resolve => http.listen(0, "127.0.0.1", resolve));
  cleanup.push(() => new Promise<void>(resolve => { http.close(() => resolve()); http.closeAllConnections(); }));
  await mkdir(join(home, ".multica"));
  await writeFile(join(home, ".multica/config.json"), JSON.stringify({ server_url: `http://127.0.0.1:${(http.address() as { port: number }).port}`, token: "synthetic" }));
  const server = new FakeServer(), events: ProviderEvent[] = [];
  const agents: Array<{ id: string; workspaceId: string; cwd: string; labels: Record<string, string>; handle: string }> = [];
  let provider: ProviderConnection;
  const host = {
    listHosts: async () => ({ self: { serverId: "daemon" } }),
    listProjects: async () => ({ projects: [] }),
    addProject: async () => ({ project: { projectId: "project", projectKind: "non_git" } }), renameProject: async () => {},
    fetchWorkspaces: async () => ({ entries: [], pageInfo: { hasMore: false } }),
    createWorkspace: async (input: { workspaceId: string }) => ({ workspace: { id: input.workspaceId } }), setWorkspaceTitle: async () => {},
    fetchAgents: async () => ({ entries: agents.map(agent => ({ agent: { provider: "multica", ...agent } })), pageInfo: { hasMore: false } }),
    importAgent: async (input: { workspaceId: string; cwd: string; labels: Record<string, string>; providerHandleId: string }) => {
      const agent = { id: `native-${agents.length}`, workspaceId: input.workspaceId, cwd: input.cwd, labels: input.labels, handle: input.providerHandleId }; agents.push(agent);
      await provider.send({ type: "session.open", requestId: agent.id, sessionId: agent.id, history: "replay", persistence: JSON.parse(agent.handle.slice(7)), config: { cwd: agent.cwd, env: {}, mcpServers: {}, settings: {}, persist: true } });
      return agent;
    }, updateAgent: async () => {}, close: async () => {},
  } as unknown as DaemonClient;
  const paseo = { hosts: { list: async () => ({ self: { serverId: "daemon" } }) } } as unknown as PaseoApi;
  const dispose = createServerContribution({ homeDirectory: home, workingDirectory: home, environment: { PASEO_HOME: home }, connectHost: async () => host })(server.context);
  cleanup.push(dispose);
  provider = await server.providers.get("multica")!.connect({ versions: [1], capabilities: ["session.persistence", "prompt.message", "prompt.steer", "timeline.plugin"] });
  provider.onEvent(event => events.push(event));
  cleanup.push(() => provider.close());
  await server.rpc(workspaceEnable, { workspaceId: "workspace", enabled: true }, paseo);
  const thread = agents.find(agent => agent.labels["multica.discussion"] === "root")!;
  const address = { connectionKey: thread.labels["multica.connection"], issueId: "issue", rootId: "root" };
  const prompt = (text: string, clientMessageId: string, delivery: "auto" | "steer") => provider.send({ type: "session.prompt", sessionId: thread.id, prompt: { clientMessageId, delivery, input: { type: "message", content: [{ type: "text", text }] } } });
  const interrupt = (requestId: string) => provider.send({ type: "session.interrupt", requestId, sessionId: thread.id });
  const turnEvents = () => events.filter((event): event is Extract<ProviderEvent, { type: "session.turn" }> => event.type === "session.turn" && event.sessionId === thread.id);
  const records = async () => (await server.rpc(deliveryList, {}, paseo)).records;
  const sync = () => server.rpc(syncBootstrap, {}, paseo);
  const observe = () => server.rpc(runObserve, address, paseo);
  return { server, paseo, events, runs, comments, writes, thread, prompt, interrupt, turnEvents, records, sync, observe,
    cancel: (handler: typeof cancel) => { cancel = handler; }, save: (handler: typeof save) => { save = handler; } };
}

it("ordinary running input posts once without cancelling either owned Run or choosing remote steering", async () => {
  const f = await fixture();
  const turnId = f.turnEvents()[0].turnId;
  await Promise.all([f.prompt("An ordinary comment", "ordinary", "steer"), f.prompt("An ordinary comment", "ordinary", "steer")]);
  await expect.poll(async () => (await f.records())[0]?.status).toBe("saved");
  expect(f.writes).toEqual([{ path: "/api/issues/issue/comments", body: { content: "An ordinary comment", type: "comment", parent_id: "root" } }]);
  expect(f.events).toContainEqual(expect.objectContaining({ type: "session.prompt_result", clientMessageId: "ordinary", result: { type: "steer", turnId } }));
  expect(f.turnEvents().map(event => event.state)).toEqual(["started"]);
  expect(f.runs.map(run => run.status)).toEqual(["running", "queued", "running"]);
});

it("the native interrupt sequence settles its fixed Run set before accepting a replacement comment in the original Thread", async () => {
  const f = await fixture();
  let release: () => void = () => {}, reached: () => void = () => {};
  const blocked = new Promise<void>(resolve => { release = resolve; }), waiting = new Promise<void>(resolve => { reached = resolve; });
  f.cancel(async run => { if (run.id === "running") { reached(); await blocked; } run.status = "cancelled"; return 200; });
  const stop = f.interrupt("explicit-interrupt");
  await waiting;
  f.runs.push({ ...f.runs[0], id: "later", status: "running" });
  await f.sync();
  expect(await f.records()).toEqual([]);
  release(); await stop;
  expect(f.events).toContainEqual({ type: "request.completed", requestId: "explicit-interrupt" });
  const turns = f.turnEvents();
  expect(turns.map(event => event.state)).toEqual(["started", "completed", "started"]);
  expect(turns[2].turnId).not.toBe(turns[0].turnId);
  // The host sends auto only after successful interruption. It cannot tell the
  // provider that this auto prompt originally came from the interrupt control.
  await f.prompt("Replacement comment", "replacement", "auto");
  await f.prompt("Replacement comment", "replacement", "auto");
  await expect.poll(async () => (await f.records())[0]?.status).toBe("saved");
  expect(f.writes).toEqual([
    { path: "/api/issues/issue/tasks/running/cancel", body: {} },
    { path: "/api/issues/issue/tasks/queued/cancel", body: {} },
    { path: "/api/issues/issue/comments", body: { content: "Replacement comment", type: "comment", parent_id: "root" } },
  ]);
  expect(f.runs.map(run => run.status)).toEqual(["cancelled", "cancelled", "running", "running"]);
  expect((await f.records())[0]).toMatchObject({ rootId: "root", threadRootId: "root", body: "Replacement comment" });
  await f.observe();
  expect(f.turnEvents()).toEqual(turns);
});

it.each([503, 200])("partial native cancellation (HTTP %s) fails before any replacement admission and keeps unresolved activity", async status => {
  const f = await fixture();
  f.cancel(async run => { if (run.id === "running") { run.status = "completed"; return 200; } return status; });
  await f.interrupt("partial-interrupt");
  expect(f.events).toContainEqual(expect.objectContaining({ type: "request.failed", requestId: "partial-interrupt", error: expect.objectContaining({ code: "stop_incomplete" }) }));
  expect(await f.records()).toEqual([]);
  expect(f.writes.map(write => write.path)).toEqual(["/api/issues/issue/tasks/running/cancel", "/api/issues/issue/tasks/queued/cancel"]);
  expect(f.turnEvents().map(event => event.state)).toEqual(["started"]);
  expect(f.runs.map(run => run.status)).toEqual(["completed", "queued", "running"]);
});

it("a host-released queued input after all owned Runs end posts one ordinary reply without waiting for other tabs", async () => {
  const f = await fixture();
  f.runs[0].status = "completed";
  await f.sync();
  expect(f.turnEvents().map(event => event.state)).toEqual(["started"]);
  expect(f.writes).toEqual([]);
  f.runs[1].status = "completed";
  await f.sync();
  expect(f.turnEvents().map(event => event.state)).toEqual(["started", "completed"]);
  // Native queue drain sends steer through the SDK; when idle, the daemon
  // opens a regular prompt, so the provider receives auto at this seam.
  await f.prompt("Queued comment", "released", "auto");
  await f.prompt("Queued comment", "released", "auto");
  await expect.poll(async () => (await f.records())[0]?.status).toBe("saved");
  expect(f.writes).toEqual([{ path: "/api/issues/issue/comments", body: { content: "Queued comment", type: "comment", parent_id: "root" } }]);
  expect(f.events).toContainEqual(expect.objectContaining({ type: "session.prompt_result", clientMessageId: "released", result: { type: "completed" } }));
  expect(f.runs[2].status).toBe("running");
  expect(f.turnEvents().map(event => event.state)).toEqual(["started", "completed"]);
});

it("a released queue input steers only native admission when a new aggregate starts before dispatch, even if saving fails", async () => {
  const f = await fixture();
  f.runs[0].status = "completed"; f.runs[1].status = "completed";
  await f.sync();
  f.runs.push({ ...f.runs[0], id: "wake-up", status: "running" });
  await f.sync();
  const nextTurnId = f.turnEvents()[2].turnId;
  f.save(async () => 503);
  await f.prompt("Released during wake-up", "release-race", "steer");
  await expect.poll(async () => (await f.records())[0]?.status).toBe("pending_verification");
  expect(f.events).toContainEqual(expect.objectContaining({ type: "session.prompt_result", clientMessageId: "release-race", result: { type: "steer", turnId: nextTurnId } }));
  expect(f.writes).toEqual([{ path: "/api/issues/issue/comments", body: { content: "Released during wake-up", type: "comment", parent_id: "root" } }]);
  expect(f.runs[3].status).toBe("running");
  expect(f.turnEvents().map(event => event.state)).toEqual(["started", "completed", "started"]);
});
