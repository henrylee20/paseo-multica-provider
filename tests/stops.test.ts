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
import { runObserve, runOpen, runMetadataRead } from "../shared/runs.js";
import { workspaceEnable, syncBootstrap } from "../shared/contracts.js";
import { createServerContribution } from "../server/contribute.js";

import { FakeServer, resync } from "./support/fake-server.js";

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
    listProjects: async () => ({ projects: [] }),
    addProject: async () => ({ project: { projectId: "project", projectKind: "non_git" } }), renameProject: async () => {},
    fetchWorkspaces: async () => ({ entries: [], pageInfo: { hasMore: false } }),
    createWorkspace: async (input: { workspaceId: string }) => ({ workspace: { id: input.workspaceId } }), setWorkspaceTitle: async () => {},
    fetchAgents: async () => ({ entries: native.agents.map(agent => ({ agent: { provider: "multica", ...agent } })), pageInfo: { hasMore: false } }),
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

const run = (id: string, status: string, root = "root"): Run => ({ id, status, issue_id: "issue", agent_id: "owned-agent", trigger_comment_id: root });

it("native Stop cancels exactly the current tab's five unfinished statuses as whole runs", async () => {
  const f = await fixture([run("queued", "queued"), run("dispatched", "dispatched"), run("running", "running"), run("waiting", "waiting_local_directory"), run("deferred", "deferred"), run("history", "completed"), run("other-tab", "running", "other")]);
  f.comments.push(comment("other", null, "Other"));
  f.runs[2].coalesced_comment_ids = ["other"];
  await resync(f.server, f.paseo, "remote-workspace");
  const thread = f.native.agents.find(agent => agent.labels["multica.discussion"] === "root")!;
  const provider = await f.connect();
  await provider.send({ type: "session.interrupt", requestId: "stop", sessionId: thread.id });
  expect(f.requests.filter(request => request.method === "POST")).toEqual(["queued", "dispatched", "running", "waiting", "deferred"].map(id => ({ method: "POST", url: `/api/issues/issue/tasks/${id}/cancel`, slug: "product" })));
  expect(f.providerEvents).toContainEqual({ type: "request.completed", requestId: "stop" });
  expect(f.runs.filter(run => run.status === "running").map(run => run.id)).toEqual(["other-tab"]);
});

it("reads actual terminal race outcomes without tracking cleanup evidence", async () => {
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
  const summaries = f.timelines.get(thread.id)!.filter(row => row.type === "plugin" && row.kind === "run-summary");
  expect(summaries.map(row => row.type === "plugin" ? row.data : null)).toEqual(expect.arrayContaining([
    expect.objectContaining({ runId: "finished", status: "completed" }), expect.objectContaining({ runId: "failed", status: "failed" }),
  ]));
});

it("keeps available failure metadata from a per-Run Stop receipt when execution messages are unavailable", async () => {
  const f = await fixture([run("failed-during-stop", "running")]);
  const metadata = { error: "Runtime failed before streaming", failure_reason: "local_directory_error", work_dir: "/remote/original", relative_work_dir: null };
  f.cancel(async () => ({ body: { ...f.runs[0], status: "failed", ...metadata } }));
  const thread = f.native.agents.find(agent => agent.labels["multica.discussion"] === "root")!;
  await (await f.connect()).send({ type: "session.interrupt", requestId: "failed-receipt", sessionId: thread.id });
  const address = { ...JSON.parse(thread.handle.slice(7)).data, runId: "failed-during-stop" };
  const opened = await f.server.rpc(runOpen, address, f.paseo);
  expect(opened).toMatchObject({ status: "cached", metadataRevision: expect.any(String) });
  const page = await f.server.rpc(runMetadataRead, { ...address, revision: opened.metadataRevision!, offset: 0 }, f.paseo);
  expect(JSON.parse(page.text)).toEqual(metadata);
  expect(f.providerEvents.some(event => event.type === "timeline.item" && event.item.type === "assistant_message")).toBe(false);
});

it("reports partial failures natively without expanding the cancellation set", async () => {
  const f = await fixture([run("ok", "running"), run("unresolved", "queued"), run("still-active", "deferred")]);
  let release: () => void = () => {};
  const blocked = new Promise<void>(resolve => { release = resolve; });
  f.cancel(async id => {
    if (id === "ok") await blocked;
    return id === "unresolved" ? { status: 503, body: {} } : { body: { ...f.runs.find(run => run.id === id), status: id === "ok" ? "cancelled" : "running" } };
  });
  const thread = f.native.agents.find(agent => agent.labels["multica.discussion"] === "root")!;
  const original = f.providerEvents.find(event => event.type === "session.turn" && event.sessionId === thread.id);
  const interrupt = (await f.connect()).send({ type: "session.interrupt", requestId: "close-running", sessionId: thread.id });
  await expect.poll(() => f.requests.some(request => request.url.endsWith("/ok/cancel"))).toBe(true);
  f.runs.push(run("later", "running"));
  await resync(f.server, f.paseo, "remote-workspace");
  release(); await interrupt;
  expect(f.providerEvents).toContainEqual(expect.objectContaining({ type: "request.failed", requestId: "close-running", error: expect.objectContaining({ code: "stop_incomplete" }) }));
  expect(f.providerEvents.filter(event => event.type === "session.turn" && event.sessionId === thread.id)).toEqual([original]);
  expect(f.requests.filter(request => request.method === "POST").map(request => request.url)).toEqual(["ok", "unresolved", "still-active"].map(id => `/api/issues/issue/tasks/${id}/cancel`));
  expect(f.runs.find(run => run.id === "later")?.status).toBe("running");

});

it("settles the interrupted native turn and keeps later runs active without expanding cancellation", async () => {
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
  const turns = () => f.providerEvents.filter((event): event is Extract<ProviderEvent, { type: "session.turn" }> => event.type === "session.turn" && event.sessionId === thread.id);
  const original = turns()[0];
  expect(original).toMatchObject({ state: "started" });
  const interrupt = (await f.connect()).send({ type: "session.interrupt", requestId: "fixed", sessionId: thread.id });
  await expect.poll(() => f.requests.some(request => request.url.endsWith("/first/cancel"))).toBe(true);
  f.runs.push(run("later", "running"));
  await resync(f.server, f.paseo, "remote-workspace");
  expect(turns()).toEqual([original]);
  release(); await interrupt;
  expect(f.requests.filter(request => request.method === "POST").map(request => request.url)).toEqual(["/api/issues/issue/tasks/first/cancel", "/api/issues/issue/tasks/second/cancel"]);
  expect(f.runs.find(run => run.id === "later")?.status).toBe("running");
  // The native host captured the original turn's settlement before interrupt.
  // Its terminal event must precede acknowledgement; later activity needs a new ID.
  expect(turns()).toEqual([original, { ...original, state: "completed" }, expect.objectContaining({ state: "started" })]);
  const later = turns()[2];
  expect(later.turnId).not.toBe(original.turnId);
  expect(f.providerEvents.indexOf(later)).toBeLessThan(f.providerEvents.findIndex(event => event.type === "request.completed" && event.requestId === "fixed"));
  await f.server.rpc(runObserve, JSON.parse(thread.handle.slice(7)).data, f.paseo);
  await resync(f.server, f.paseo, "remote-workspace");
  expect(turns()).toEqual([original, { ...original, state: "completed" }, later]);
  f.runs.find(run => run.id === "later")!.status = "completed";
  await resync(f.server, f.paseo, "remote-workspace");
  expect(turns()).toEqual([original, { ...original, state: "completed" }, later, { ...later, state: "completed" }]);
});

it("does not settle a later native turn when the interrupted turn ended before the cancel receipt", async () => {
  const f = await fixture([run("first", "running")]);
  let release: () => void = () => {};
  const blocked = new Promise<void>(resolve => { release = resolve; });
  f.cancel(async id => { await blocked; return { body: { ...f.runs.find(run => run.id === id), status: "cancelled" } }; });
  const thread = f.native.agents.find(agent => agent.labels["multica.discussion"] === "root")!;
  const turns = () => f.providerEvents.filter((event): event is Extract<ProviderEvent, { type: "session.turn" }> => event.type === "session.turn" && event.sessionId === thread.id);
  const original = turns()[0];
  const interrupt = (await f.connect()).send({ type: "session.interrupt", requestId: "completed-race", sessionId: thread.id });
  await expect.poll(() => f.requests.some(request => request.url.endsWith("/first/cancel"))).toBe(true);
  f.runs[0].status = "completed";
  await resync(f.server, f.paseo, "remote-workspace");
  f.runs.push(run("later", "running"));
  await resync(f.server, f.paseo, "remote-workspace");
  const later = turns()[2];
  expect(later).toMatchObject({ state: "started" });
  expect(later.turnId).not.toBe(original.turnId);
  release(); await interrupt;
  expect(f.providerEvents).toContainEqual({ type: "request.completed", requestId: "completed-race" });
  expect(turns()).toEqual([original, { ...original, state: "completed" }, later]);
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
  await resync(restarted.server, f.paseo, "remote-workspace");
  expect(f.requests.filter(request => request.method !== "GET")).toEqual([]);
  expect(f.runs[0].status).toBe("running");
});

it("never cancels when filtering a running Issue out or disabling its workspace rule", async () => {
  const f = await fixture([run("active", "running")]);
  f.matching(false);
  await resync(f.server, f.paseo, "remote-workspace");
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
  expect(f.requests.filter(request => request.method === "POST")).toHaveLength(3);
});

it("does not reactivate a cancelled run when an older in-flight snapshot finishes later", async () => {
  const f = await fixture([run("active", "running")]);
  let release: () => void = () => {};
  let reached: () => void = () => {};
  const blocked = new Promise<void>(resolve => { release = resolve; });
  const snapshotReached = new Promise<void>(resolve => { reached = resolve; });
  f.beforeAgents(async () => { reached(); await blocked; });
  const staleSnapshot = resync(f.server, f.paseo, "remote-workspace");
  await snapshotReached;
  const thread = f.native.agents.find(agent => agent.labels["multica.discussion"] === "root")!;
  await (await f.connect()).send({ type: "session.interrupt", requestId: "stop", sessionId: thread.id });
  release(); await staleSnapshot;
  expect(f.timelines.get(thread.id)?.find(row => row.id === "multica:run:active")).toMatchObject({ data: { status: "cancelled" } });
  expect(f.providerEvents.filter(event => event.type === "session.turn" && event.sessionId === thread.id).map(event => event.type === "session.turn" ? event.state : null)).toEqual(["started", "completed"]);
});
