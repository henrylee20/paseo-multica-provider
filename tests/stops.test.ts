import { createServer } from "node:http";
import { createRequire } from "node:module";
import { mkdtemp, mkdir, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import type { PaseoApi } from "@getpaseo/client";
import type { DaemonClient } from "@getpaseo/client/internal/daemon-client";
import type { ProviderConnection, ProviderEvent, ProviderTimelineItem } from "@getpaseo/plugin/server/provider";
import { defineRpc } from "@getpaseo/plugin";
import { z } from "zod";
import { hiddenList } from "../shared/hiding.js";
import { workspaceEnable, syncBootstrap } from "../shared/contracts.js";
import { createServerContribution } from "../server/contribute.js";

import { FakeServer } from "./support/fake-server.js";

const cleanup: Array<() => void | Promise<void>> = [];
afterEach(async () => { for (const dispose of cleanup.splice(0).reverse()) await dispose(); });
const stamp = "2026-11-24T10:00:00Z";
const comment = (id: string, parent_id: string | null, content: string, author_id = "member-me", author_type = "member") => ({
  id, parent_id, content, author_id, author_type, source_task_id: undefined as string | null | undefined, issue_id: "issue", type: "comment", created_at: stamp, updated_at: stamp, attachments: [],
});
type Comment = ReturnType<typeof comment>;
function conversationRows(rows: ProviderTimelineItem[] | undefined) {
  return rows?.filter(row => row.type !== "plugin" || !row.data || typeof row.data !== "object" || Array.isArray(row.data) || row.data.category !== "source");
}


type Run = { id: string; issue_id: string; agent_id: string; status: string; trigger_comment_id?: string | null; coalesced_comment_ids?: string[]; delivered_comment_ids?: string[]; supplement_comment_ids?: string[] };
async function fixture(initialRuns: Run[] = []) {
  const home = await mkdtemp(join(tmpdir(), "multica-threads-"));
  cleanup.push(() => rm(home, { recursive: true, force: true }));
  const requests: Array<{ url: string; method: string; slug?: string }> = [];
  const comments: Comment[] = [comment("root", null, "**Root**"), comment("child", "root", "Child", "member-other"), comment("grandchild", "child", "Grandchild", "owned-agent", "agent")];
  const runs = [...initialRuns];
  let cancel: (id: string) => Promise<{status?: number; body: unknown}> = async id => { const run = runs.find(run => run.id === id)!; run.status = "cancelled"; return { body: run }; };
  let beforeAgents: (() => Promise<void>) | undefined;
  let failRuns = false;
  let failDiscovery = false;
  let failHistory = false;
  let paginate = false;
  let truncated = false;
  let discoveryPages: Comment[][] | undefined;
  const http = createServer(async (request, response) => {
    requests.push({ url: request.url!, method: request.method!, slug: request.headers["x-workspace-slug"] as string });
    response.setHeader("Content-Type", "application/json");
    const url = new URL(request.url!, "http://localhost");
    let body: unknown;
    if (request.method === "POST" && url.pathname.endsWith("/cancel")) {
      const result = await cancel(decodeURIComponent(url.pathname.split("/").at(-2)!)); response.statusCode = result.status ?? 200; body = result.body;
    }
    else if (url.pathname === "/api/me") body = { id: "member-me", name: "Lin" };
    else if (url.pathname === "/api/workspaces") body = [{ id: "remote-workspace", name: "Product", slug: "product" }];
    else if (url.pathname === "/api/issues") body = { issues: matching ? [{ id: "issue", workspace_id: "remote-workspace", title: "Task", description: "Task description", status: "todo" }] : [], total: matching ? 1 : 0 };
    else if (url.pathname === "/api/workspaces/remote-workspace/members") body = [{ id: "membership-other", user_id: "member-other", name: "River" }];
    else if (url.pathname === "/api/agents") { await beforeAgents?.(); body = [{ id: "owned-agent", name: "Lin Agent", owner_id: "member-me" }]; }
    else if (url.pathname === "/api/issues/issue/task-runs") {
      if (failRuns) { response.statusCode = 503; body = {}; } else body = runs;
    }
    else if (url.pathname === "/api/issues/issue/comments") {
      if (!url.searchParams.has("thread") && failDiscovery) { response.statusCode = 503; response.end("{}"); return; }
      if (url.searchParams.has("thread")) {
        if (truncated) response.setHeader("X-Comments-Truncated", "true");
        if (failHistory) { response.statusCode = 503; response.end("{}"); return; }
        if (!paginate) body = comments.filter(item => {
          let current: Comment | undefined = item;
          const seen = new Set<string>();
          while (current?.parent_id && !seen.has(current.id)) { seen.add(current.id); current = comments.find(parent => parent.id === current!.parent_id); }
          return current?.id === url.searchParams.get("thread");
        });
        else {
          const root = comments.find(item => item.id === url.searchParams.get("thread"));
          const replies = comments.filter(item => item.parent_id);
          const before = url.searchParams.get("before_id");
          const end = before ? replies.findIndex(item => item.id === before) : replies.length;
          const start = Math.max(0, end - 100);
          const page = replies.slice(start, end);
          if (start > 0) { response.setHeader("X-Multica-Next-Before", stamp); response.setHeader("X-Multica-Next-Before-Id", page[0].id); }
          body = [root, ...page];
        }
      } else if (discoveryPages) {
        const index = Number(url.searchParams.get("before_id") ?? "0");
        if (index + 1 < discoveryPages.length) { response.setHeader("X-Multica-Next-Before", stamp); response.setHeader("X-Multica-Next-Before-Id", String(index + 1)); }
        body = discoveryPages[index];
      } else body = comments.map(item => ({ ...item, content: item.parent_id ? "summary" : item.content, content_truncated: !!item.parent_id }));
    } else { response.statusCode = 404; body = {}; }
    response.end(JSON.stringify(body));
  });
  await new Promise<void>(resolve => http.listen(0, "127.0.0.1", resolve));
  cleanup.push(() => new Promise<void>(resolve => { http.close(() => resolve()); http.closeAllConnections(); }));
  type Socket = { send(data: string): void; close(): void; on(type: "message", callback: (data: { toString(): string }) => void): void };
  const { WebSocketServer } = createRequire(import.meta.url)("ws") as { WebSocketServer: new (options: { server: typeof http }) => {
    on(type: "connection", callback: (socket: Socket) => void): void; clients: Set<Socket>; close(): void;
  } };
  const websocket = new WebSocketServer({ server: http });
  const authenticated = new Set<Socket>();
  websocket.on("connection", socket => socket.on("message", data => {
    if (JSON.parse(data.toString()).type === "auth") authenticated.add(socket);
  }));
  cleanup.push(() => { for (const socket of websocket.clients) socket.close(); websocket.close(); });
  const signal = (type: string, payload = {}) => { for (const socket of authenticated) socket.send(JSON.stringify({ type, payload })); };
  const eventsReady = async () => {
    await expect.poll(() => authenticated.size, { timeout: 2000 }).toBeGreaterThan(0);
    signal("auth_ack");
  };
  await mkdir(join(home, ".multica"));
  await writeFile(join(home, ".multica", "config.json"), JSON.stringify({ server_url: `http://127.0.0.1:${(http.address() as { port: number }).port}`, token: "synthetic-token" }));
  let matching = true;
  const native = { effects: [] as string[], agents: [] as Array<{ id: string; workspaceId: string; cwd: string; labels: Record<string, string>; handle: string; name?: string; archivedAt?: string }> };
  const timelines = new Map<string, ProviderTimelineItem[]>();
  const providerEvents: ProviderEvent[] = [];
  let server: FakeServer;
  let provider: ProviderConnection | undefined;
  async function connect() {
    if (provider) return provider;
    provider = await server.providers.get("multica")!.connect({ versions: [1], capabilities: ["session.persistence", "session.list"] });
    provider.onEvent(event => {
      providerEvents.push(event);
      if (event.type !== "timeline.item") return;
      const rows = timelines.get(event.sessionId) ?? [];
      const existing = rows.findIndex(row => row.id === event.item.id);
      if (existing >= 0) {
        if (event.item.type !== "plugin" || event.item.kind !== "run-summary") throw new Error(`Duplicate native row ${event.item.id}`);
        rows[existing] = event.item;
      } else rows.push(event.item); timelines.set(event.sessionId, rows);
    });
    return provider;
  }
  const host = {
    listHosts: async () => ({ self: { serverId: "owning-daemon" } }),
    addProject: async () => ({ project: { projectId: "project", projectKind: "non_git" } }), renameProject: async () => {},
    fetchWorkspaces: async () => ({ entries: [], pageInfo: { hasMore: false } }),
    createWorkspace: async (input: { workspaceId: string }) => ({ workspace: { id: input.workspaceId } }), setWorkspaceTitle: async () => {},
    fetchAgents: async () => ({ entries: native.agents.map(agent => ({ agent })), pageInfo: { hasMore: false } }),
    importAgent: async (input: { workspaceId: string; cwd: string; labels: Record<string, string>; providerHandleId: string }) => {
      const agent = { id: `native-${native.agents.length}`, workspaceId: input.workspaceId, cwd: input.cwd, labels: input.labels, handle: input.providerHandleId };
      native.agents.push(agent);
      const connection = await connect();
      await connection.send({ type: "session.open", requestId: `import-${agent.id}`, sessionId: agent.id, history: "replay", persistence: JSON.parse(agent.handle.slice(7)),
        config: { cwd: agent.cwd, env: {}, mcpServers: {}, settings: {}, persist: true } });
      return agent;
    },
    updateAgent: async (id: string, updates: { name: string }) => { native.agents.find(agent => agent.id === id)!.name = updates.name; },
    archiveWorkspace: async (id: string) => { for (const agent of native.agents.filter(agent => agent.workspaceId === id)) await archiveAgent(agent.id); await server.hook("workspace.archive.after", { workspace: { id, cwd: native.agents[0].cwd, projectId: "project", name: "Task", archivedAt: stamp } }, paseo); return { error: null }; },
    restoreWorkspace: async () => { native.effects.push("restore"); },
    refreshAgent: async () => { native.effects.push("refresh"); },
    close: async () => {},
  } as unknown as DaemonClient;
  async function archiveAgent(id: string) {
    const agent = native.agents.find(agent => agent.id === id)!;
    agent.archivedAt = stamp;
    await server.hook("agent.archive.after", { agent: { id, workspaceId: agent.workspaceId, cwd: agent.cwd, provider: "multica", parentAgentId: null, title: agent.name ?? null }, archivedAt: stamp }, paseo);
    await (await connect()).send({ type: "session.close", requestId: `close-${id}`, sessionId: id });
  }
  const start = () => {
    provider = undefined;
    server = new FakeServer();
    const dispose = createServerContribution({ homeDirectory: home, workingDirectory: home, environment: { PASEO_HOME: home }, connectHost: async () => host })(server.context);
    cleanup.push(dispose);
    return { server, dispose };
  };
  const started = start();
  cleanup.push(async () => { await provider?.close(); });
  const paseo = { hosts: { list: async () => ({ self: { serverId: "owning-daemon" } }) } } as unknown as PaseoApi;
  await server!.rpc(workspaceEnable, { workspaceId: "remote-workspace", enabled: true }, paseo);
  return { ...started, beforeAgents: (handler: () => Promise<void>) => { beforeAgents = handler; }, matching: (value: boolean) => { matching = value; }, host, archiveAgent, cancel: (handler: typeof cancel) => { cancel = handler; }, native, timelines, comments, requests, paseo, home, start, connect, eventsReady, signal, runs, providerEvents, failRuns: (value: boolean) => { failRuns = value; }, failDiscovery: (value: boolean) => { failDiscovery = value; }, discoveryPages: (pages: Comment[][]) => { discoveryPages = pages; }, truncated: (value: boolean) => { truncated = value; }, paginate: () => { paginate = true; }, failHistory: (value: boolean) => { failHistory = value; } };
}

const stopList = defineRpc({ name: "stop.list", input: z.object({}), output: z.object({ records: z.array(z.object({
  connectionKey: z.string(), issueId: z.string(), rootId: z.string(), runId: z.string(), title: z.string(),
  status: z.string().optional(), cleanup: z.string(), retryable: z.boolean(), message: z.string().optional(),
})) }) });
const stopRetry = defineRpc({ name: "stop.retry", input: z.object({ connectionKey: z.string(), issueId: z.string(), rootId: z.string(), runId: z.string() }),
  output: z.object({ status: z.enum(["ready", "unavailable"]), message: z.string().optional() }) });
const run = (id: string, status: string, root = "root"): Run => ({ id, status, issue_id: "issue", agent_id: "owned-agent", trigger_comment_id: root });

it("native Stop cancels exactly the current tab's five unfinished statuses as whole runs", async () => {
  const f = await fixture([run("queued", "queued"), run("dispatched", "dispatched"), run("running", "running"), run("waiting", "waiting_local_directory"), run("deferred", "deferred"), run("history", "completed"), run("other-tab", "running", "other")]);
  f.comments.push(comment("other", null, "Other"));
  f.runs[2].coalesced_comment_ids = ["other"];
  await f.server.rpc(syncBootstrap, {}, f.paseo);
  const thread = f.native.agents.find(agent => agent.labels["multica.discussion"] === "root")!;
  const provider = await f.connect();
  await provider.send({ type: "session.interrupt", requestId: "stop", sessionId: thread.id });
  expect(f.requests.filter(request => request.method === "POST")).toEqual(["queued", "dispatched", "running", "waiting", "deferred"].map(id => ({ method: "POST", url: `/api/issues/issue/tasks/${id}/cancel`, slug: "product" })));
  expect(f.providerEvents).toContainEqual({ type: "request.completed", requestId: "stop" });
  expect(f.runs.filter(run => run.status === "running").map(run => run.id)).toEqual(["other-tab"]);
});

it("reads actual terminal race outcomes and keeps task status separate from cleanup evidence", async () => {
  const f = await fixture([run("finished", "running"), run("failed", "queued"), run("pending", "running"), run("unknown", "deferred"), run("confirmed", "running"), run("unconfirmed", "running"), run("opaque-result", "running")]);
  f.cancel(async id => ({ body: { ...f.runs.find(run => run.id === id), status: id === "finished" || id === "opaque-result" ? "completed" : id === "failed" ? "failed" : "cancelled",
    ...(id === "pending" ? { result: { process_cleanup_pending: true } } : {}),
    ...(id === "confirmed" ? { result: { process_cleanup_confirmed: true } } : {}),
    ...(id === "unconfirmed" ? { failure_reason: "process_cleanup_unconfirmed" } : {}),
    ...(id === "opaque-result" ? { result: "Arbitrary remote output" } : {}),
  } }));
  const thread = f.native.agents.find(agent => agent.labels["multica.discussion"] === "root")!;
  await (await f.connect()).send({ type: "session.interrupt", requestId: "stop", sessionId: thread.id });
  expect(f.providerEvents).toContainEqual({ type: "request.completed", requestId: "stop" });
  const records = (await f.server.rpc(stopList, {}, f.paseo)).records;
  expect(records.map(record => [record.runId, record.status, record.cleanup, record.retryable])).toEqual([
    ["finished", "completed", "unknown", false], ["failed", "failed", "unknown", false], ["pending", "cancelled", "pending", false],
    ["unknown", "cancelled", "unknown", false], ["confirmed", "cancelled", "confirmed", false], ["unconfirmed", "cancelled", "unconfirmed", false], ["opaque-result", "completed", "unknown", false],
  ]);
  const summaries = f.timelines.get(thread.id)!.filter(row => row.type === "plugin" && row.kind === "run-summary");
  expect(summaries.map(row => row.type === "plugin" ? row.data : null)).toEqual(expect.arrayContaining([
    expect.objectContaining({ runId: "finished", status: "completed" }), expect.objectContaining({ runId: "failed", status: "failed" }),
  ]));
});

it("reports partial failure natively and retains per-run retry after tab closure, restart and offline listing", async () => {
  const f = await fixture([run("ok", "running"), run("unresolved", "queued"), run("still-active", "deferred")]);
  f.cancel(async id => id === "unresolved" ? { status: 503, body: {} } : { body: { ...f.runs.find(run => run.id === id), status: id === "ok" ? "cancelled" : "running" } });
  const thread = f.native.agents.find(agent => agent.labels["multica.discussion"] === "root")!;
  await (await f.connect()).send({ type: "session.interrupt", requestId: "close-running", sessionId: thread.id });
  expect(f.providerEvents).toContainEqual(expect.objectContaining({ type: "request.failed", requestId: "close-running", error: expect.objectContaining({ code: "stop_incomplete" }) }));
  await f.archiveAgent(thread.id);
  await f.dispose();
  const restarted = f.start();
  const records = (await restarted.server.rpc(stopList, {}, f.paseo)).records;
  expect(records.filter(record => record.retryable).map(record => record.runId)).toEqual(["unresolved", "still-active"]);
  const config = await readFile(join(f.home, ".multica", "config.json"), "utf8");
  await writeFile(join(f.home, ".multica", "config.json"), "{}");
  expect((await restarted.server.rpc(stopList, {}, f.paseo)).records).toEqual(records);
  const retry = records.find(record => record.runId === "unresolved")!;
  expect(await restarted.server.rpc(stopRetry, retry, f.paseo)).toMatchObject({ status: "unavailable" });
  expect((await restarted.server.rpc(stopList, {}, f.paseo)).records.find(record => record.runId === "unresolved")?.retryable).toBe(true);
  await writeFile(join(f.home, ".multica", "config.json"), config);
  f.cancel(async id => ({ body: { ...f.runs.find(run => run.id === id), status: "cancelled" } }));
  const before = f.requests.filter(request => request.method === "POST").length;
  expect(await restarted.server.rpc(stopRetry, retry, f.paseo)).toEqual({ status: "ready" });
  expect(f.requests.filter(request => request.method === "POST").slice(before)).toEqual([{ method: "POST", url: "/api/issues/issue/tasks/unresolved/cancel", slug: "product" }]);
  expect(thread.archivedAt).toBeTruthy();
  expect(f.native.effects).toEqual([]);
  expect((await restarted.server.rpc(hiddenList, {}, f.paseo)).objects).toEqual([expect.objectContaining({ rootId: "root", agentId: thread.id, kind: "thread" })]);
  expect((await restarted.server.rpc(stopList, {}, f.paseo)).records.filter(record => record.retryable).map(record => record.runId)).toEqual(["still-active"]);
});

it("fixes the interrupt snapshot before network waits and excludes newly discovered runs", async () => {
  const f = await fixture([run("first", "running"), run("second", "queued")]);
  let release: () => void = () => {};
  const blocked = new Promise<void>(resolve => { release = resolve; });
  f.cancel(async id => {
    if (id === "first") await blocked;
    const record = f.runs.find(run => run.id === id)!;
    record.status = "cancelled";
    return { body: record };
  });
  const thread = f.native.agents.find(agent => agent.labels["multica.discussion"] === "root")!;
  const interrupt = (await f.connect()).send({ type: "session.interrupt", requestId: "fixed", sessionId: thread.id });
  await expect.poll(() => f.requests.some(request => request.url.endsWith("/first/cancel"))).toBe(true);
  f.runs.push(run("later", "running"));
  await f.server.rpc(syncBootstrap, {}, f.paseo);
  release(); await interrupt;
  expect(f.requests.filter(request => request.method === "POST").map(request => request.url)).toEqual(["/api/issues/issue/tasks/first/cancel", "/api/issues/issue/tasks/second/cancel"]);
  expect((await f.server.rpc(stopList, {}, f.paseo)).records.map(record => record.runId)).toEqual(["first", "second"]);
  expect(f.runs.find(run => run.id === "later")?.status).toBe("running");
  expect(f.providerEvents.filter(event => event.type === "session.turn" && event.sessionId === thread.id && event.state === "completed")).toEqual([]);
});

it("never cancels on whole-workspace archive, replay, session lifecycle or connection cleanup", async () => {
  const f = await fixture([run("active", "running")]);
  const provider = await f.connect();
  const thread = f.native.agents.find(agent => agent.labels["multica.discussion"] === "root")!;
  await provider.send({ type: "session.archive", requestId: "archive", persistence: JSON.parse(thread.handle.slice(7)) });
  await provider.send({ type: "session.unarchive", requestId: "unarchive", persistence: JSON.parse(thread.handle.slice(7)) });
  await f.host.archiveWorkspace(thread.workspaceId);
  await provider.close();
  await f.dispose();
  const restarted = f.start();
  await restarted.server.rpc(syncBootstrap, {}, f.paseo);
  expect(f.requests.filter(request => request.method !== "GET")).toEqual([]);
  expect(f.runs[0].status).toBe("running");
  expect((await restarted.server.rpc(stopList, {}, f.paseo)).records).toEqual([]);
});

it("never cancels when filtering a running Issue out or disabling its workspace rule", async () => {
  const f = await fixture([run("active", "running")]);
  f.matching(false);
  await f.server.rpc(syncBootstrap, {}, f.paseo);
  f.matching(true);
  await f.server.rpc(workspaceEnable, { workspaceId: "remote-workspace", enabled: false }, f.paseo);
  await f.dispose();
  expect(f.requests.filter(request => request.method !== "GET")).toEqual([]);
  expect(f.runs[0].status).toBe("running");
});

it("retains unknown or malformed per-run results without preventing cancellation of the rest", async () => {
  const f = await fixture([run("wrong-id", "running"), run("bad-body", "running"), run("ok", "running")]);
  f.cancel(async id => ({ body: id === "bad-body" ? { status: "cancelled" } : { ...f.runs.find(run => run.id === id), id: id === "wrong-id" ? "other-run" : id, status: "cancelled" } }));
  const thread = f.native.agents.find(agent => agent.labels["multica.discussion"] === "root")!;
  await (await f.connect()).send({ type: "session.interrupt", requestId: "invalid", sessionId: thread.id });
  expect(f.providerEvents).toContainEqual(expect.objectContaining({ type: "request.failed", requestId: "invalid" }));
  expect((await f.server.rpc(stopList, {}, f.paseo)).records.map(record => [record.runId, record.status, record.retryable])).toEqual([
    ["wrong-id", "running", true], ["bad-body", "running", true], ["ok", "cancelled", false],
  ]);
  expect(f.requests.filter(request => request.method === "POST")).toHaveLength(3);
});

it("does not reactivate a cancelled run when an older in-flight snapshot finishes later", async () => {
  const f = await fixture([run("active", "running")]);
  let release: () => void = () => {};
  let reached: () => void = () => {};
  const blocked = new Promise<void>(resolve => { release = resolve; });
  const snapshotReached = new Promise<void>(resolve => { reached = resolve; });
  f.beforeAgents(async () => { reached(); await blocked; });
  const staleSnapshot = f.server.rpc(syncBootstrap, {}, f.paseo);
  await snapshotReached;
  const thread = f.native.agents.find(agent => agent.labels["multica.discussion"] === "root")!;
  await (await f.connect()).send({ type: "session.interrupt", requestId: "stop", sessionId: thread.id });
  release(); await staleSnapshot;
  expect(f.timelines.get(thread.id)?.find(row => row.id === "multica:run:active")).toMatchObject({ data: { status: "cancelled" } });
  expect(f.providerEvents.filter(event => event.type === "session.turn" && event.sessionId === thread.id).map(event => event.type === "session.turn" ? event.state : null)).toEqual(["started", "completed"]);
});
