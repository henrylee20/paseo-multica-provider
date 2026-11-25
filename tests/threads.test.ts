import { createServer } from "node:http";
import { createRequire } from "node:module";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import type { PaseoApi } from "@getpaseo/client";
import type { DaemonClient } from "@getpaseo/client/internal/daemon-client";
import type { ProviderConnection, ProviderEvent, ProviderTimelineItem } from "@getpaseo/plugin/server/provider";
import { runObserve, runOpen, runRead } from "../shared/runs.js";
import { workspaceEnable, syncBootstrap } from "../shared/contracts.js";
import { createServerContribution } from "../server/contribute.js";
import { threadOpen, commentEventDetail } from "../shared/threads.js";
import { FakeServer, resync } from "./support/fake-server.js";
import { metadataHost } from "./support/metadata-host.js";

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


type Run = { id: string; issue_id: string; agent_id: string; status: string; trigger_comment_id?: string | null; coalesced_comment_ids?: string[]; delivered_comment_ids?: string[]; supplement_comment_ids?: string[]; error?: string | null; failure_reason?: string | null; work_dir?: string | null; relative_work_dir?: string | null };
type RunMessage = { task_id: string; issue_id: string; seq: number; type: "text" | "thinking" | "tool_use" | "tool_result" | "error"; call_id?: string; tool?: string; content?: string; input?: Record<string, unknown>; output?: string; output_truncated?: boolean };
async function fixture(initialRuns: Run[] = []) {
  const home = await mkdtemp(join(tmpdir(), "multica-threads-"));
  cleanup.push(() => rm(home, { recursive: true, force: true }));
  const requests: Array<{ url: string; method: string; slug?: string }> = [];
  const comments: Comment[] = [comment("root", null, "**Root**"), comment("child", "root", "Child", "member-other"), comment("grandchild", "child", "Grandchild", "owned-agent", "agent")];
  const runs = [...initialRuns];
  const messages: RunMessage[] = [];
  let failMessages = false;
  let identity = "member-me";
  let failRuns = false;
  let failDiscovery = false;
  let failHistory = false;
  let paginate = false;
  let truncated = false;
  let discoveryPages: Comment[][] | undefined;
  const http = createServer((request, response) => {
    requests.push({ url: request.url!, method: request.method!, slug: request.headers["x-workspace-slug"] as string });
    response.setHeader("Content-Type", "application/json");
    const url = new URL(request.url!, "http://localhost");
    let body: unknown;
    if (url.pathname === "/api/me") body = { id: identity, name: "Lin" };
    else if (url.pathname === "/api/workspaces") body = [{ id: "remote-workspace", name: "Product", slug: "product" }];
    else if (url.pathname === "/api/issues")
      body = { issues: [{ id: "issue", workspace_id: "remote-workspace", title: "Task", description: "Task description", status: "todo" }], total: 1 };
    else if (url.pathname === "/api/workspaces/remote-workspace/members") body = [{ id: "membership-other", user_id: "member-other", name: "River" }];
    else if (url.pathname === "/api/agents") body = [{ id: "owned-agent", name: "Lin Agent", owner_id: "member-me" }];
    else if (url.pathname === "/api/issues/issue/task-runs") {
      if (failRuns) { response.statusCode = 503; body = {}; } else body = runs;
    }
    else if (/^\/api\/tasks\/[^/]+\/messages$/.test(url.pathname)) {
      if (failMessages) { response.statusCode = 503; body = {}; }
      else body = messages.filter(message => message.task_id === decodeURIComponent(url.pathname.split("/")[3]) && (!url.searchParams.has("since") || message.seq > Number(url.searchParams.get("since"))));
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
        if (index + 1 < discoveryPages.length) {
          response.setHeader("X-Multica-Next-Before", stamp);
          response.setHeader("X-Multica-Next-Before-Id", String(index + 1));
        }
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
  const native = { agents: [] as Array<{ id: string; workspaceId: string; cwd: string; labels: Record<string, string>; handle: string; name?: string; archivedAt?: string }> };
  const timelines = new Map<string, ProviderTimelineItem[]>();
  const providerEvents: ProviderEvent[] = [];
  const droppedOriginals = new Set<string>();
  const nativeHistory = { failOlder: false };
  let server: FakeServer;
  let provider: ProviderConnection | undefined;
  async function connect() {
    if (provider) return provider;
    provider = await server.providers.get("multica")!.connect({ versions: [1], capabilities: ["session.persistence", "session.list"] });
    provider.onEvent(event => {
      providerEvents.push(event);
      if (event.type !== "timeline.item") return;
      if ((event.item.type === "user_message" || event.item.type === "assistant_message") && droppedOriginals.has(event.item.messageId ?? "")) return;
      const rows = timelines.get(event.sessionId) ?? [];
      const existing = rows.findIndex(row => row.id === event.item.id);
      if (existing >= 0) {
        if (event.item.type !== "plugin") throw new Error(`Duplicate native row ${event.item.id}`);
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
    fetchAgentTimeline: async (agentId: string, options?: { cursor?: { seq: number }; direction?: string }) => {
      const all = (timelines.get(agentId) ?? []).map((item, index) => ({ seqStart: index + 1, seqEnd: index + 1, item, timestamp: stamp }));
      const available = options?.direction === "before" ? all.filter(entry => entry.seqStart < options.cursor!.seq) : all;
      const entries = available.slice(-2);
      return { agentId, projection: "projected", epoch: "fixture-epoch", error: nativeHistory.failOlder && options?.direction === "before" ? "disconnected older page" : null, reset: false, staleCursor: false, gap: false,
        entries, hasOlder: available.length > entries.length, hasNewer: false,
        startCursor: entries[0] ? { epoch: "fixture-epoch", seq: entries[0].seqStart } : null };
    },
    close: async () => {},
  } as unknown as DaemonClient;
  const reconnect = async () => {
    await provider?.close(); provider = undefined;
    const connection = await connect();
    for (const agent of native.agents)
      await connection.send({ type: "session.open", requestId: `restart-${agent.id}`, sessionId: agent.id, history: "skip", persistence: JSON.parse(agent.handle.slice(7)), config: { cwd: agent.cwd, env: {}, mcpServers: {}, settings: {}, persist: true } });
  };
  const start = () => {
    server = new FakeServer();
    const dispose = createServerContribution({ homeDirectory: home, workingDirectory: home, environment: { PASEO_HOME: home }, connectHost: async () => host })(server.context);
    cleanup.push(dispose);
    return { server, dispose };
  };
  const started = start();
  cleanup.push(async () => { await provider?.close(); });
  const paseo = { hosts: { list: async () => ({ self: { serverId: "owning-daemon" } }) } } as unknown as PaseoApi;
  await server!.syncRpc(workspaceEnable, { workspaceId: "remote-workspace", enabled: true }, paseo);
  return { ...started, native, timelines, droppedOriginals, nativeHistory, reconnect, comments, requests, paseo, home, start, connect, eventsReady, signal, runs, messages, providerEvents, failMessages: (value: boolean) => {
    failMessages = value;
  }, identity: async (value: string) => {
    identity = value;
    await writeFile(join(home, ".multica/config.json"), JSON.stringify({ server_url: `http://127.0.0.1:${(http.address() as { port: number }).port}`, token: `synthetic-${value}` }));
  }, failRuns: (value: boolean) => {
    failRuns = value;
  }, failDiscovery: (value: boolean) => {
    failDiscovery = value;
  }, discoveryPages: (pages: Comment[][]) => {
    discoveryPages = pages;
  }, truncated: (value: boolean) => {
    truncated = value;
  }, paginate: () => {
    paginate = true;
  }, failHistory: (value: boolean) => {
    failHistory = value;
  } };
}

it("discovers one stable native tab for a root and recursive replies without loading full background history", async () => {
  const f = await fixture();
  expect(f.native.agents.map(agent => agent.labels["multica.discussion"])).toEqual(["main", "root"]);
  expect(f.native.agents[1].cwd).toBe(f.native.agents[0].cwd);
  expect(f.native.agents[1].handle).not.toBe(f.native.agents[0].handle);
  expect(f.requests.some(request => request.url.includes("thread="))).toBe(false);
  expect(f.timelines.get(f.native.agents[0].id)?.map(row => row.type === "plugin" ? row.kind : row.type)).toEqual(["task-description", "thread"]);
  expect(conversationRows(f.timelines.get(f.native.agents[1].id))).toEqual([expect.objectContaining({ type: "plugin", kind: "thread" })]);
  await resync(f.server, f.paseo, "remote-workspace");
  expect(f.native.agents).toHaveLength(2);
  expect(f.requests.every(request => request.method === "GET")).toBe(true);
});

it("bootstrap copies the task into every discussion tab's metadata, Thread tabs included, for the composer's agent picker", async () => {
  const f = await fixture();
  const host = metadataHost(f.native.agents);
  expect(await f.server.syncRpc(syncBootstrap, {}, host.paseo)).toEqual({ status: "ready" });
  await vi.waitFor(() => expect(host.writes.map(write => write.agentId)).toEqual(f.native.agents.map(agent => agent.id)));
  expect(host.writes.map(write => write.patch)).toEqual(f.native.agents.map(agent => ({ "multica.connection": agent.labels["multica.connection"], "multica.issue": "issue" })));
});


it("opening a native Thread imports recursive descendants with connected-member roles, named authors and separate system rows", async () => {
  const f = await fixture();
  f.comments.push({ ...comment("status", "root", "Task is in progress", "system", "system"), type: "status_change" });
  f.comments[1] = { ...f.comments[1], attachments: [{ id: "attachment", filename: "spec.pdf", url: "/api/attachments/attachment/download" }] } as unknown as Comment;
  const thread = f.native.agents[1];
  const address = JSON.parse(thread.handle.slice(7)).data;
  expect(await f.server.rpc(threadOpen, address, f.paseo)).toEqual({ status: "ready" });
  expect(conversationRows(f.timelines.get(thread.id))).toMatchObject([
    { type: "plugin", kind: "thread" },
    { type: "user_message", text: "**Root**" },
    { type: "assistant_message", text: expect.stringContaining("River: \n\nChild") },
    { type: "assistant_message", text: "Lin Agent: \n\nGrandchild" },
    { type: "plugin", kind: "comment-event", data: { category: "system", text: "Task is in progress", sourceCreatedAt: stamp } },
  ]);
  expect(conversationRows(f.timelines.get(thread.id))?.[2]).toMatchObject({ text: expect.stringContaining("[spec.pdf](http://127.0.0.1:") });
  await f.server.rpc(threadOpen, address, f.paseo);
  expect(conversationRows(f.timelines.get(thread.id))).toHaveLength(5);
  expect(f.requests.filter(request => request.url.includes("/comments?") && request.url.includes("thread=")).every(request => request.slug === "product")).toBe(true);
});


it("loads every page beyond the default 2000 comment cap and deduplicates the repeated root", async () => {
  const f = await fixture();
  f.comments.splice(1, 2, ...Array.from({ length: 2205 }, (_, index) => comment(`reply-${String(index).padStart(4, "0")}`, index ? `reply-${String(index - 1).padStart(4, "0")}` : "root", `Reply ${index}`)));
  f.paginate();
  const thread = f.native.agents[1];
  const address = JSON.parse(thread.handle.slice(7)).data;
  expect(await f.server.rpc(threadOpen, address, f.paseo)).toEqual({ status: "ready" });
  expect(conversationRows(f.timelines.get(thread.id))).toHaveLength(2207);
  expect(conversationRows(f.timelines.get(thread.id))?.at(-1)).toMatchObject({ type: "user_message", text: "Reply 2204" });
  const reads = f.requests.filter(request => request.url.includes("thread=root"));
  expect(reads).toHaveLength(23);
  expect(reads.slice(1).every(request => new URL(request.url, "http://fixture").searchParams.has("before") && new URL(request.url, "http://fixture").searchParams.has("before_id"))).toBe(true);
  expect(f.requests.some(request => request.url.endsWith("/comments"))).toBe(false);
});

it("preserves the first obtainable snapshot and appends stable edit and deletion records through repeated opens", async () => {
  const f = await fixture();
  const thread = f.native.agents[1];
  const address = JSON.parse(thread.handle.slice(7)).data;
  f.comments[0].content = "Edited before first reading";
  await f.server.rpc(threadOpen, address, f.paseo);
  const original = conversationRows(f.timelines.get(thread.id))?.[1];
  expect(original).toMatchObject({ type: "user_message", text: "Edited before first reading" });
  f.comments[0].content = "Correction after reading";
  f.comments[0].updated_at = "2026-11-24T11:00:00Z";
  await Promise.all([f.server.rpc(threadOpen, address, f.paseo), f.server.rpc(threadOpen, address, f.paseo)]);
  expect(conversationRows(f.timelines.get(thread.id))?.filter(row => row.type === "user_message")).toEqual([original]);
  expect(conversationRows(f.timelines.get(thread.id))?.at(-1)).toMatchObject({ type: "plugin", data: { category: "correction", text: "Correction after reading", sourceUpdatedAt: "2026-11-24T11:00:00Z" } });
  f.comments.splice(2, 1);
  f.failHistory(true);
  expect(await f.server.rpc(threadOpen, address, f.paseo)).toMatchObject({ status: "cached" });
  expect(conversationRows(f.timelines.get(thread.id))?.some(row => row.type === "plugin" && row.data && typeof row.data === "object" && !Array.isArray(row.data) && row.data.category === "deletion")).toBe(false);
  f.failHistory(false);
  await f.server.rpc(threadOpen, address, f.paseo);
  await f.server.rpc(threadOpen, address, f.paseo);
  expect(conversationRows(f.timelines.get(thread.id))).toHaveLength(6);
  expect(conversationRows(f.timelines.get(thread.id))?.at(-1)).toMatchObject({ type: "plugin", data: { category: "deletion", commentId: "grandchild" } });
  await f.dispose();
  const restarted = f.start();
  expect(await resync(restarted.server, f.paseo, "remote-workspace")).toEqual({ status: "ready" });
  expect(f.native.agents).toHaveLength(2);
  const connection = await restarted.server.providers.get("multica")!.connect({ versions: [1], capabilities: ["session.persistence"] });
  const replay: ProviderEvent[] = [];
  connection.onEvent(event => replay.push(event));
  await connection.send({ type: "session.open", requestId: "restore", sessionId: "restored", history: "replay", persistence: JSON.parse(thread.handle.slice(7)),
    config: { cwd: thread.cwd, env: {}, mcpServers: {}, settings: {}, persist: true } });
  expect(conversationRows(replay.filter(event => event.type === "timeline.item").map(event => event.item))).toEqual(conversationRows(f.timelines.get(thread.id)));
  await connection.send({ type: "session.close", requestId: "close", sessionId: "restored" });
  await connection.close();
  expect(f.requests.every(request => request.method === "GET")).toBe(true);
});


it("keeps issue-level system changes in the main discussion without creating discussion tabs", async () => {
  const f = await fixture();
  f.comments.push({ ...comment("issue-status", null, "Issue completed", "system", "system"), type: "status_change" });
  await resync(f.server, f.paseo, "remote-workspace");
  expect(f.native.agents.map(agent => agent.labels["multica.discussion"])).toEqual(["main", "root"]);
  const main = f.native.agents[0];
  const { connectionKey, issueId } = JSON.parse(main.handle.slice(7)).data;
  expect(await f.server.rpc(threadOpen, { connectionKey, issueId, rootId: "main" }, f.paseo)).toEqual({ status: "ready" });
  expect(conversationRows(f.timelines.get(main.id))?.at(-1)).toMatchObject({ type: "plugin", kind: "comment-event", data: { category: "system", text: "Issue completed" } });
  expect(conversationRows(f.timelines.get(main.id))?.some(row => row.type === "user_message" || row.type === "assistant_message")).toBe(false);
});

it("retains cached messages when a cursorless response explicitly reports truncation", async () => {
  const f = await fixture();
  const thread = f.native.agents[1];
  const address = JSON.parse(thread.handle.slice(7)).data;
  await f.server.rpc(threadOpen, address, f.paseo);
  f.comments.splice(2, 1);
  f.truncated(true);
  expect(await f.server.rpc(threadOpen, address, f.paseo)).toMatchObject({ status: "cached" });
  expect(conversationRows(f.timelines.get(thread.id))).toHaveLength(4);
});


it("discovers older activity pages, resolves arbitrary descendants and leaves missing parents unresolved", async () => {
  const f = await fixture();
  const older = comment("old-root", null, "Old discussion");
  const missing = comment("orphan", "missing-parent", "Unknown ancestry");
  f.discoveryPages([[...f.comments, missing], [older, comment("old-child", "old-root", "Old reply")]]);
  await resync(f.server, f.paseo, "remote-workspace");
  expect(f.native.agents.map(agent => agent.labels["multica.discussion"])).toEqual(["main", "root", "old-root"]);
  expect(f.requests.filter(request => request.url.includes("recent=100")).some(request => request.url.includes("before=") && request.url.includes("before_id=1"))).toBe(true);
  expect(f.requests.some(request => request.url.includes("thread="))).toBe(false);
});

it("opens a deleted root tombstone without inventing its previous native message", async () => {
  const f = await fixture();
  const thread = f.native.agents[1];
  const address = JSON.parse(thread.handle.slice(7)).data;
  f.comments[0] = { ...f.comments[0], content: "", deleted_at: "2026-11-24T11:00:00Z" } as Comment;
  expect(await f.server.rpc(threadOpen, address, f.paseo)).toEqual({ status: "ready" });
  expect(conversationRows(f.timelines.get(thread.id))?.filter(row => row.type === "user_message")).toEqual([]);
  expect(conversationRows(f.timelines.get(thread.id))).toMatchObject([
    { type: "plugin", kind: "thread" }, { type: "plugin", data: { category: "deletion", commentId: "root" } },
    { type: "assistant_message", text: expect.stringContaining("Child") }, { type: "assistant_message", text: expect.stringContaining("Grandchild") },
  ]);
  await f.server.rpc(threadOpen, address, f.paseo);
  expect(conversationRows(f.timelines.get(thread.id))).toHaveLength(4);
});

it("keeps large correction records bounded in native rows with their full content available on demand", async () => {
  const f = await fixture();
  const thread = f.native.agents[1];
  const address = JSON.parse(thread.handle.slice(7)).data;
  await f.server.rpc(threadOpen, address, f.paseo);
  f.comments[0].content = "修正内容".repeat(24000);
  await f.server.rpc(threadOpen, address, f.paseo);
  const row = conversationRows(f.timelines.get(thread.id))?.at(-1);
  expect(Buffer.byteLength(JSON.stringify(row))).toBeLessThan(64 * 1024);
  expect(row).toMatchObject({ type: "plugin", data: { category: "correction", truncated: true } });
  expect(await f.server.rpc(commentEventDetail, { ...address, recordId: row!.id }, f.paseo)).toEqual({ text: f.comments[0].content });
});


it("duplicate authenticated comment events append one correction and discover new tabs without opening their history", async () => {
  const f = await fixture();
  const thread = f.native.agents[1];
  const address = JSON.parse(thread.handle.slice(7)).data;
  await f.server.rpc(threadOpen, address, f.paseo);
  await f.eventsReady();
  f.comments[0].content = "Updated by WebSocket invalidation";
  for (let index = 0; index < 3; index++) f.signal("comment:updated", { comment: f.comments[0] });
  await expect.poll(() => conversationRows(f.timelines.get(thread.id))?.filter(row => row.type === "plugin" && row.data && typeof row.data === "object" && !Array.isArray(row.data) && row.data.category === "correction").length, { timeout: 3000 }).toBe(1);
  f.comments.push(comment("new-thread", null, "New background discussion"));
  f.signal("comment:created", { comment: f.comments.at(-1) });
  await expect.poll(() => f.native.agents.length, { timeout: 3000 }).toBe(3);
  expect(f.native.agents[2].labels["multica.discussion"]).toBe("new-thread");
  expect(f.requests.some(request => request.url.includes("thread=new-thread"))).toBe(false);
  expect(f.requests.every(request => request.method === "GET")).toBe(true);
});

it("appends deletion records when a fully deleted Thread vanishes from a complete issue snapshot", async () => {
  const f = await fixture();
  const thread = f.native.agents[1];
  const address = JSON.parse(thread.handle.slice(7)).data;
  await f.server.rpc(threadOpen, address, f.paseo);
  f.comments.splice(0);
  await resync(f.server, f.paseo, "remote-workspace");
  expect(conversationRows(f.timelines.get(thread.id))).toContainEqual(expect.objectContaining({ type: "plugin", data: expect.objectContaining({ category: "deletion", commentId: "root" }) }));
  await resync(f.server, f.paseo, "remote-workspace");
  expect(conversationRows(f.timelines.get(thread.id))).toHaveLength(7);
  expect(f.native.agents).toHaveLength(2);
});


it("shows one stable run summary only in its trigger Thread and replaces its status without assistant log messages", async () => {
  const f = await fixture([{ id: "run-one", issue_id: "issue", agent_id: "owned-agent", status: "queued", trigger_comment_id: "grandchild", coalesced_comment_ids: ["root"] }]);
  const main = f.native.agents[0];
  const thread = f.native.agents[1];
  const summaries = (id: string) => f.timelines.get(id)?.filter(row => row.type === "plugin" && row.kind === "run-summary");
  expect(summaries(thread.id)).toMatchObject([{ id: "multica:run:run-one", data: { runId: "run-one", agentId: "owned-agent", agentName: "Lin Agent", status: "queued" } }]);
  expect(summaries(main.id)).toEqual([]);
  f.runs[0].status = "running";
  await resync(f.server, f.paseo, "remote-workspace");
  await resync(f.server, f.paseo, "remote-workspace");
  expect(summaries(thread.id)).toMatchObject([{ id: "multica:run:run-one", data: { status: "running" } }]);
  expect(f.timelines.get(thread.id)?.some(row => row.type === "assistant_message")).toBe(false);
  expect(f.requests.filter(request => request.url.includes("task-runs")).every(request => request.url === "/api/issues/issue/task-runs?view=timeline" && request.slug === "product")).toBe(true);
  expect(f.requests.some(request => request.url.includes("/messages"))).toBe(false);
});

it("aggregates parallel and queued runs into one native turn and gives every later activity cycle a new identity", async () => {
  const f = await fixture([
    { id: "run-first", issue_id: "issue", agent_id: "owned-agent", status: "running", trigger_comment_id: "root" },
    { id: "run-next", issue_id: "issue", agent_id: "second-agent", status: "queued", trigger_comment_id: "child" },
  ]);
  const thread = f.native.agents[1];
  const turns = () => f.providerEvents.filter((event): event is Extract<ProviderEvent, { type: "session.turn" }> => event.type === "session.turn" && event.sessionId === thread.id);
  expect(turns()).toMatchObject([{ state: "started" }]);
  f.runs[0].status = "completed";
  await resync(f.server, f.paseo, "remote-workspace");
  expect(turns()).toHaveLength(1);
  f.runs[1].status = "waiting_local_directory";
  await resync(f.server, f.paseo, "remote-workspace");
  f.runs[1].status = "deferred";
  await resync(f.server, f.paseo, "remote-workspace");
  f.runs[1].status = "dispatched";
  await resync(f.server, f.paseo, "remote-workspace");
  expect(turns()).toHaveLength(1);
  f.runs[1].status = "failed";
  await resync(f.server, f.paseo, "remote-workspace");
  expect(turns()).toMatchObject([{ state: "started" }, { state: "completed" }]);
  expect(turns()[1].turnId).toBe(turns()[0].turnId);
  f.runs.push({ id: "run-third", issue_id: "issue", agent_id: "second-agent", status: "queued", trigger_comment_id: "root" });
  await resync(f.server, f.paseo, "remote-workspace");
  expect(turns()).toMatchObject([{ state: "started" }, { state: "completed" }, { state: "started" }]);
  expect(turns()[2].turnId).not.toBe(turns()[0].turnId);
  f.runs[2].status = "cancelled";
  await resync(f.server, f.paseo, "remote-workspace");
  await resync(f.server, f.paseo, "remote-workspace");
  expect(turns()).toMatchObject([{ state: "started" }, { state: "completed" }, { state: "started" }, { state: "completed" }]);
  expect(turns()[3].turnId).toBe(turns()[2].turnId);
});

it("fixes first ownership across cross-Thread coalescing, later associations and restart, using actual comment creation order", async () => {
  const f = await fixture();
  f.comments.push({ ...comment("z-earliest", null, "Earlier Thread"), created_at: "2020-01-01T00:00:00Z" }, { ...comment("a-later", null, "Later Thread"), created_at: "2025-01-01T00:00:00Z" });
  f.runs.push(
    { id: "earliest", issue_id: "issue", agent_id: "owned-agent", status: "completed", coalesced_comment_ids: ["a-later", "z-earliest"] },
    { id: "unanchored", issue_id: "issue", agent_id: "owned-agent", status: "completed", delivered_comment_ids: [] },
    { id: "trigger", issue_id: "issue", agent_id: "owned-agent", status: "completed", trigger_comment_id: "a-later", coalesced_comment_ids: ["z-earliest"] },
  );
  await resync(f.server, f.paseo, "remote-workspace");
  const ownerOf = (id: string) => f.native.agents.filter(agent => f.timelines.get(agent.id)?.some(row => row.id === `multica:run:${id}`)).map(agent => agent.labels["multica.discussion"]);
  expect(ownerOf("earliest")).toEqual(["z-earliest"]);
  expect(ownerOf("unanchored")).toEqual(["main"]);
  expect(ownerOf("trigger")).toEqual(["a-later"]);
  f.runs[0].trigger_comment_id = "a-later";
  f.runs[1].trigger_comment_id = "z-earliest";
  f.runs[2].trigger_comment_id = "root";
  await resync(f.server, f.paseo, "remote-workspace");
  await f.dispose();
  const restarted = f.start();
  await resync(restarted.server, f.paseo, "remote-workspace");
  const provider = await restarted.server.providers.get("multica")!.connect({ versions: [1], capabilities: ["session.persistence"] });
  const replay: ProviderEvent[] = [];
  provider.onEvent(event => replay.push(event));
  for (const agent of f.native.agents)
    await provider.send({ type: "session.open", requestId: `replay-${agent.id}`, sessionId: agent.id, history: "replay", persistence: JSON.parse(agent.handle.slice(7)), config: { cwd: agent.cwd, env: {}, mcpServers: {}, settings: {}, persist: true } });
  const owners = (runId: string) => replay.flatMap(event => event.type === "timeline.item" && event.item.id === `multica:run:${runId}` ? [f.native.agents.find(agent => agent.id === event.sessionId)!.labels["multica.discussion"]] : []);
  expect(owners("earliest")).toEqual(["z-earliest"]);
  expect(owners("unanchored")).toEqual(["main"]);
  expect(owners("trigger")).toEqual(["a-later"]);
  await provider.close();
});

it("does not invent main-discussion ownership from failed association reads or unresolved parents, and preserves activity on run-read failure", async () => {
  const f = await fixture();
  const hasRun = () => [...f.timelines.values()].flat().filter(row => row.type === "plugin" && row.kind === "run-summary");
  f.runs.push({ id: "uncertain", issue_id: "issue", agent_id: "owned-agent", status: "running", coalesced_comment_ids: ["orphan"] });
  f.failDiscovery(true);
  expect(await resync(f.server, f.paseo, "remote-workspace")).toMatchObject({ status: "unavailable" });
  expect(hasRun()).toEqual([]);
  f.failDiscovery(false);
  f.comments.push(comment("orphan", "missing-parent", "Unresolved"));
  await resync(f.server, f.paseo, "remote-workspace");
  expect(hasRun()).toEqual([]);
  f.comments.push(comment("missing-parent", null, "Recovered parent"));
  await resync(f.server, f.paseo, "remote-workspace");
  const owner = f.native.agents.find(agent => agent.labels["multica.discussion"] === "missing-parent")!;
  expect(hasRun()).toMatchObject([{ data: { rootId: "missing-parent", status: "running" } }]);
  f.runs[0].status = "completed";
  f.failRuns(true);
  await resync(f.server, f.paseo, "remote-workspace");
  expect(hasRun()).toMatchObject([{ data: { status: "running" } }]);
  expect(f.providerEvents.filter(event => event.type === "session.turn" && event.sessionId === owner.id)).toMatchObject([{ state: "started" }]);
  f.failRuns(false);
  await resync(f.server, f.paseo, "remote-workspace");
  expect(hasRun()).toMatchObject([{ data: { status: "completed" } }]);
  expect(f.providerEvents.filter(event => event.type === "session.turn" && event.sessionId === owner.id)).toMatchObject([{ state: "started" }, { state: "completed" }]);
});

it("uses source timestamps including sub-millisecond precision and timezone offsets for earliest associated ownership", async () => {
  const f = await fixture();
  f.comments.push({ ...comment("early", null, "Early"), created_at: "2020-01-01T01:00:00.000000001+01:00" }, { ...comment("later", null, "Later"), created_at: "2020-01-01T00:00:00.000000002Z" });
  f.runs.push({ id: "precise", issue_id: "issue", agent_id: "owned-agent", status: "completed", delivered_comment_ids: ["later", "early"] });
  await resync(f.server, f.paseo, "remote-workspace");
  const summaries = [...f.timelines.values()].flat().filter(row => row.id === "multica:run:precise");
  expect(summaries).toMatchObject([{ data: { rootId: "early" } }]);
});

it("handles real duplicate task WebSocket invalidations without duplicating bounded summaries or loading run output", async () => {
  const f = await fixture([{ id: "live", issue_id: "issue", agent_id: "owned-agent", status: "queued", trigger_comment_id: "root", result: { output: "日志".repeat(100000) } } as Run]);
  const thread = f.native.agents[1];
  const row = () => f.timelines.get(thread.id)?.find(row => row.id === "multica:run:live");
  await f.eventsReady();
  f.runs[0].status = "running";
  f.signal("task:running", { task_id: "live", issue_id: "issue" });
  f.signal("task:running", { task_id: "live", issue_id: "issue" });
  await expect.poll(() => row(), { timeout: 3000 }).toMatchObject({ data: { status: "running" } });
  await resync(f.server, f.paseo, "remote-workspace");
  expect(f.timelines.get(thread.id)?.filter(row => row.id === "multica:run:live")).toHaveLength(1);
  expect(f.providerEvents.filter(event => event.type === "timeline.item" && event.item.id === "multica:run:live")).toHaveLength(2);
  expect(Buffer.byteLength(JSON.stringify(row()), "utf8")).toBeLessThan(64 * 1024);
  expect(JSON.stringify(row())).not.toContain("日志");
  expect(f.requests.some(request => request.url.includes("/messages"))).toBe(false);
});

it("restores cached summaries and activity after native attachment while close, archive and unarchive remain local", async () => {
  const f = await fixture([{ id: "active", issue_id: "issue", agent_id: "owned-agent", status: "running", trigger_comment_id: "root" }]);
  const native = f.native.agents[1];
  const address = JSON.parse(native.handle.slice(7)).data;
  const originalTurn = f.providerEvents.find(event => event.type === "session.turn" && event.sessionId === native.id);
  const connection = await f.connect();
  await connection.send({ type: "session.close", requestId: "local-close", sessionId: native.id });
  await connection.send({ type: "session.open", requestId: "restore-active", sessionId: "reopened", history: "replay", persistence: JSON.parse(native.handle.slice(7)), config: { cwd: native.cwd, env: {}, mcpServers: {}, settings: {}, persist: true } });
  const turns = () => f.providerEvents.filter((event): event is Extract<ProviderEvent, { type: "session.turn" }> => event.type === "session.turn" && event.sessionId === "reopened");
  expect(f.providerEvents.filter(event => event.type === "timeline.item" && event.sessionId === "reopened" && event.item.id === "multica:run:active")).toHaveLength(1);
  expect(turns()).toEqual([]);
  await f.server.rpc(runObserve, address, f.paseo);
  await f.server.rpc(runObserve, address, f.paseo);
  expect(turns()).toMatchObject([{ state: "started" }]);
  expect(turns()[0].turnId).not.toBe(originalTurn?.type === "session.turn" ? originalTurn.turnId : undefined);
  await connection.send({ type: "session.archive", requestId: "archive", persistence: JSON.parse(native.handle.slice(7)) });
  await connection.send({ type: "session.unarchive", requestId: "unarchive", persistence: JSON.parse(native.handle.slice(7)) });
  expect(turns()).toHaveLength(1);
  expect(f.requests.every(request => request.method === "GET")).toBe(true);
  f.runs[0].status = "completed";
  await resync(f.server, f.paseo, "remote-workspace");
  expect(turns()).toMatchObject([{ state: "started" }, { state: "completed" }]);
});

it("uses generated-comment provenance as first-discovery associations but never moves an already fixed main owner", async () => {
  const f = await fixture([{ id: "fixed-main", issue_id: "issue", agent_id: "owned-agent", status: "completed" }]);
  f.comments.push(
    { ...comment("generated-early", null, "Earlier generated output", "owned-agent", "agent"), source_task_id: "generated-only", created_at: "2020-01-01T00:00:00Z" },
    { ...comment("generated-later", null, "Later generated output", "owned-agent", "agent"), source_task_id: "generated-only", created_at: "2025-01-01T00:00:00Z" },
    { ...comment("late-for-main", "root", "Late generated output", "owned-agent", "agent"), source_task_id: "fixed-main" },
    { ...comment("generated-for-trigger", "generated-early", "Triggered output", "owned-agent", "agent"), source_task_id: "trigger-priority" },
  );
  f.runs.push(
    { id: "generated-only", issue_id: "issue", agent_id: "owned-agent", status: "completed" },
    { id: "trigger-priority", issue_id: "issue", agent_id: "owned-agent", status: "completed", trigger_comment_id: "root" },
  );
  await resync(f.server, f.paseo, "remote-workspace");
  const owners = (id: string) => f.native.agents.filter(agent => f.timelines.get(agent.id)?.some(row => row.id === `multica:run:${id}`)).map(agent => agent.labels["multica.discussion"]);
  expect(owners("generated-only")).toEqual(["generated-early"]);
  expect(owners("fixed-main")).toEqual(["main"]);
  expect(owners("trigger-priority")).toEqual(["root"]);
  expect(f.requests.some(request => request.url.includes("thread="))).toBe(false);
  expect([...f.timelines.values()].flat().some(row => row.type === "assistant_message")).toBe(false);
});

it("shows task failure metadata and exact remote paths even when a Run failed before streaming", async () => {
  const metadata = { error: "Runtime failed before streaming", failure_reason: "local_directory_error", work_dir: "/remote/agent/../checkout with spaces", relative_work_dir: "../checkout with spaces" };
  const f = await fixture([{ id: "failed", issue_id: "issue", agent_id: "owned-agent", status: "failed", trigger_comment_id: "root", ...metadata }]);
  const address = { ...JSON.parse(f.native.agents[1].handle.slice(7)).data, runId: "failed" };
  const opened = await f.server.rpc(runOpen, address, f.paseo) as { revision?: string; metadataRevision?: string };
  expect(opened.metadataRevision).toEqual(expect.any(String));
  const page = await f.server.rpc(runRead, { kind: "metadata", ...address, revision: opened.metadataRevision!, offset: 0 }, f.paseo);
  expect(JSON.parse(page.text)).toEqual(metadata);
  expect(JSON.parse((await f.server.rpc(runRead, { kind: "messages", ...address, revision: opened.revision!, offset: 0 }, f.paseo)).text)).toEqual([]);
  expect(f.native.agents.every(agent => agent.cwd !== metadata.work_dir && agent.cwd !== metadata.relative_work_dir)).toBe(true);
  expect(f.timelines.get(f.native.agents[1].id)?.some(row => row.type === "assistant_message")).toBe(false);
  f.failMessages(true);
  expect(await f.server.rpc(runOpen, address, f.paseo)).toMatchObject({ metadataRevision: opened.metadataRevision });
});

it("retains full versioned task metadata without message access across restart and old-identity cache reads", async () => {
  const metadata = { error: "Failed😀\n".repeat(20000), failure_reason: "local_directory_error", work_dir: "/remote/" + "深い/".repeat(30000), relative_work_dir: null };
  const f = await fixture([{ id: "failed", issue_id: "issue", agent_id: "owned-agent", status: "failed", trigger_comment_id: "root", ...metadata }]);
  const address = { ...JSON.parse(f.native.agents[1].handle.slice(7)).data, runId: "failed" };
  f.failMessages(true);
  const opened = await f.server.rpc(runOpen, address, f.paseo);
  expect(opened).toMatchObject({ status: "cached", metadataRevision: expect.any(String) });
  expect(opened.revision).toBeUndefined();
  let text = "", offset: number | null = 0;
  while (offset !== null) {
    const page: { text: string; nextOffset: number | null } = await f.server.rpc(runRead, { kind: "metadata", ...address, revision: opened.metadataRevision!, offset }, f.paseo);
    expect(Buffer.byteLength(JSON.stringify(page))).toBeLessThan(64 * 1024);
    text += page.text; offset = page.nextOffset;
  }
  expect(JSON.parse(text)).toEqual(metadata);
  const summary = f.timelines.get(f.native.agents[1].id)?.find(row => row.id === "multica:run:failed");
  expect(Buffer.byteLength(JSON.stringify(summary))).toBeLessThan(64 * 1024);
  expect(JSON.stringify(summary)).not.toContain("Failed");

  // Omission carries no replacement evidence; explicit null and empty do.
  f.runs[0].error = null; delete f.runs[0].failure_reason; f.runs[0].relative_work_dir = "";
  await resync(f.server, f.paseo, "remote-workspace");
  const changed = await f.server.rpc(runOpen, address, f.paseo);
  await expect(f.server.rpc(runRead, { kind: "metadata", ...address, revision: opened.metadataRevision!, offset: 8192 }, f.paseo)).rejects.toThrow("changed");
  f.runs[0].status = "running"; f.runs[0].error = "Stale active snapshot";
  await resync(f.server, f.paseo, "remote-workspace");
  expect(await f.server.rpc(runOpen, address, f.paseo)).toMatchObject({ metadataRevision: changed.metadataRevision });
  await f.identity("other-user");
  const messageReads = f.requests.filter(request => request.url.includes("/messages")).length;
  expect(await f.server.rpc(runOpen, address, f.paseo)).toMatchObject({ status: "cached", metadataRevision: changed.metadataRevision });
  expect(f.requests.filter(request => request.url.includes("/messages"))).toHaveLength(messageReads);
  await f.dispose();
  await writeFile(join(f.home, ".multica", "config.json"), "{}");
  const restarted = f.start();
  const requests = f.requests.length;
  const cached = await restarted.server.rpc(runOpen, address, f.paseo);
  expect(cached).toMatchObject({ status: "cached", metadataRevision: changed.metadataRevision });
  const first = await restarted.server.rpc(runRead, { kind: "metadata", ...address, revision: cached.metadataRevision!, offset: 0 }, f.paseo);
  expect(first.text).toContain('"error":null,"failure_reason":"local_directory_error"');
  expect(f.requests).toHaveLength(requests);
});

it("loads complete run details only on expansion and chunks large ordered source messages without making assistant replies", async () => {
  const f = await fixture([{ id: "detail", issue_id: "issue", agent_id: "owned-agent", status: "running", trigger_comment_id: "root" }]);
  const address = { ...JSON.parse(f.native.agents[1].handle.slice(7)).data, runId: "detail" };
  const input = { task_id: "detail", issue_id: "issue" };
  const huge = "结果😀".repeat(30000);
  f.messages.push(
    { ...input, seq: 1, type: "text", content: "Starting" },
    { ...input, seq: 2, type: "thinking", content: "Plan" },
    { ...input, seq: 3, type: "tool_use", call_id: "call", tool: "read", input: { file: "code.ts" } },
    { ...input, seq: 4, type: "tool_result", call_id: "call", output: huge, output_truncated: false },
    { ...input, seq: 5, type: "error", content: "Retry failed" },
    ...Array.from({ length: 205 }, (_, i): RunMessage => ({ ...input, seq: i + 6, type: "text", content: `Step ${i}` })),
  );
  await resync(f.server, f.paseo, "remote-workspace");
  expect(f.requests.some(request => request.url.includes("/messages"))).toBe(false);
  const opened = await f.server.rpc(runOpen, address, f.paseo);
  expect(opened).toMatchObject({ status: "ready", revision: expect.any(String) });
  let offset: number | null = 0;
  let text = "";
  while (offset !== null) {
    const page: { text: string; nextOffset: number | null } = await f.server.rpc(runRead, { kind: "messages", ...address, revision: opened.revision!, offset }, f.paseo);
    expect(Buffer.byteLength(JSON.stringify(page))).toBeLessThan(64 * 1024);
    text += page.text;
    offset = page.nextOffset;
  }
  expect(JSON.parse(text)).toEqual(f.messages);
  expect(f.requests.filter(request => request.url.includes("/messages"))).toEqual([{ method: "GET", url: "/api/tasks/detail/messages", slug: "product" }]);
  expect(f.timelines.get(f.native.agents[1].id)?.some(row => row.type === "assistant_message")).toBe(false);
  expect(Buffer.byteLength(JSON.stringify(f.timelines.get(f.native.agents[1].id)?.find(row => row.id === "multica:run:detail")))).toBeLessThan(64 * 1024);
});

it("fills delayed sequence gaps, deduplicates repeated run messages and retains every cached detail across summary refreshes", async () => {
  const f = await fixture([{ id: "detail", issue_id: "issue", agent_id: "owned-agent", status: "running", trigger_comment_id: "root" }]);
  const address = { ...JSON.parse(f.native.agents[1].handle.slice(7)).data, runId: "detail" };
  const input = { task_id: "detail", issue_id: "issue" };
  f.messages.push({ ...input, seq: 3, type: "tool_result", output: "Unpaired output" }, { ...input, seq: 1, type: "text", content: "First" }, { ...input, seq: 1, type: "text", content: "First" });
  await f.server.rpc(runOpen, address, f.paseo);
  await resync(f.server, f.paseo, "remote-workspace");
  // The HTTP service can initially omit a delayed message. A greatest-seen
  // cursor would skip this permanently because seq 3 arrived before seq 2.
  f.messages.push({ ...input, seq: 2, type: "thinking", content: "Delayed thought" });
  const next = await f.server.rpc(runOpen, address, f.paseo);
  const read = await f.server.rpc(runRead, { kind: "messages", ...address, revision: next.revision!, offset: 0 }, f.paseo);
  expect(JSON.parse(read.text)).toEqual([
    { ...input, seq: 1, type: "text", content: "First" },
    { ...input, seq: 2, type: "thinking", content: "Delayed thought" },
    { ...input, seq: 3, type: "tool_result", output: "Unpaired output" },
  ]);
  expect(f.requests.filter(request => request.url.includes("/messages")).at(-1)?.url).toBe("/api/tasks/detail/messages?since=1");
  f.messages.push({ ...input, seq: 4, type: "error", content: "New error" });
  const live = await f.server.rpc(runOpen, address, f.paseo);
  expect(JSON.parse((await f.server.rpc(runRead, { kind: "messages", ...address, revision: live.revision!, offset: 0 }, f.paseo)).text).map((message: RunMessage) => message.seq)).toEqual([1, 2, 3, 4]);
  expect(f.requests.filter(request => request.url.includes("/messages")).at(-1)?.url).toBe("/api/tasks/detail/messages?since=3");
  await expect(f.server.rpc(runRead, { kind: "messages", ...address, revision: next.revision!, offset: 0 }, f.paseo)).rejects.toThrow("changed");
  const before = f.requests.filter(request => request.url.includes("/messages")).length;
  const repeated = await Promise.all([f.server.rpc(runOpen, address, f.paseo), f.server.rpc(runOpen, address, f.paseo)]);
  expect(repeated).toEqual([live, live]);
  expect(f.requests.filter(request => request.url.includes("/messages"))).toHaveLength(before + 1);
});

it("keeps cached run details readable after restart, remote failures, logout and identity change without refreshing through the wrong login", async () => {
  const f = await fixture([{ id: "cache", issue_id: "issue", agent_id: "owned-agent", status: "running", trigger_comment_id: "root" }]);
  const address = { ...JSON.parse(f.native.agents[1].handle.slice(7)).data, runId: "cache" };
  f.messages.push({ task_id: "cache", issue_id: "issue", seq: 1, type: "tool_result", output: "Read while authorized", output_truncated: true });
  const opened = await f.server.rpc(runOpen, address, f.paseo);
  const original = await f.server.rpc(runRead, { kind: "messages", ...address, revision: opened.revision!, offset: 0 }, f.paseo);
  f.failMessages(true);
  expect(await f.server.rpc(runOpen, address, f.paseo)).toMatchObject({ status: "cached", revision: opened.revision });
  f.failMessages(false);
  // A malformed or cross-Issue response is never merged into previously read history.
  f.messages.push({ task_id: "cache", issue_id: "other-issue", seq: 2, type: "text", content: "Wrong issue" });
  expect(await f.server.rpc(runOpen, address, f.paseo)).toMatchObject({ status: "cached", revision: opened.revision });
  f.messages.pop();
  await f.identity("another-user");
  const beforeSwitch = f.requests.filter(request => request.url.includes("/messages")).length;
  expect(await f.server.rpc(runOpen, address, f.paseo)).toMatchObject({ status: "cached", revision: opened.revision });
  expect(await f.server.rpc(runRead, { kind: "messages", ...address, revision: opened.revision!, offset: 0 }, f.paseo)).toEqual(original);
  expect(f.requests.filter(request => request.url.includes("/messages"))).toHaveLength(beforeSwitch);
  await f.dispose();
  await writeFile(join(f.home, ".multica", "config.json"), "{}");
  const restarted = f.start();
  expect(await restarted.server.rpc(runOpen, address, f.paseo)).toMatchObject({ status: "cached", revision: opened.revision });
  expect(await restarted.server.rpc(runRead, { kind: "messages", ...address, revision: opened.revision!, offset: 0 }, f.paseo)).toEqual(original);
  expect(f.requests.filter(request => request.url.includes("/messages"))).toHaveLength(beforeSwitch);
  expect(await restarted.server.rpc(runOpen, { ...address, rootId: "main" }, f.paseo)).toMatchObject({ status: "unavailable" });
  await expect(restarted.server.rpc(runRead, { kind: "messages", ...address, rootId: "main", revision: opened.revision!, offset: 0 }, f.paseo)).rejects.toThrow("does not belong");
});

it("catches real task-message invalidations through incremental reads without duplicating details, moving ownership or copying final comments", async () => {
  const f = await fixture([{ id: "stream", issue_id: "issue", agent_id: "owned-agent", status: "running", trigger_comment_id: "root" }, { id: "other", issue_id: "issue", agent_id: "owned-agent", status: "running" }]);
  const address = { ...JSON.parse(f.native.agents[1].handle.slice(7)).data, runId: "stream" };
  f.messages.push({ task_id: "stream", issue_id: "issue", seq: 1, type: "tool_use", call_id: "same-id", tool: "read", input: { file: "a" } });
  await f.server.rpc(runOpen, address, f.paseo);
  await f.server.rpc(threadOpen, address, f.paseo);
  await f.eventsReady();
  const result: RunMessage = { task_id: "stream", issue_id: "issue", seq: 3, type: "tool_result", call_id: "same-id", output: "Live result" };
  f.messages.push(result, { ...result });
  f.signal("task:message", result);
  f.signal("task:message", result);
  f.runs[0].trigger_comment_id = "some-later-root";
  f.runs[0].status = "completed";
  f.comments.push({ ...comment("final-comment", "root", "Final comment", "owned-agent", "agent"), source_task_id: "stream" });
  f.signal("comment:created", { issue_id: "issue", comment_id: "final-comment" });
  await expect.poll(() => f.timelines.get(f.native.agents[1].id)?.find(row => row.id === "multica:run:stream"), { timeout: 3000 }).toMatchObject({ data: { status: "completed", rootId: "root" } });
  const opened = await f.server.rpc(runOpen, address, f.paseo);
  const records = JSON.parse((await f.server.rpc(runRead, { kind: "messages", ...address, revision: opened.revision!, offset: 0 }, f.paseo)).text);
  expect(records.map((record: RunMessage) => record.seq)).toEqual([1, 3]);
  expect(f.requests.filter(request => request.url.includes("/messages")).at(-1)?.url).toBe("/api/tasks/stream/messages?since=1");
  expect(f.timelines.get(f.native.agents[1].id)?.filter(row => row.type === "assistant_message").map(row => row.text)).toEqual(["River: \n\nChild", "Lin Agent: \n\nGrandchild", "Lin Agent: \n\nFinal comment"]);
  expect(f.timelines.get(f.native.agents[0].id)?.some(row => row.id === "multica:run:stream")).toBe(false);
  expect(f.requests.some(request => request.url.includes("/tasks/other/messages"))).toBe(false);
});


it("reconciles a cached original missing after process loss against complete native source IDs", async () => {
  const f = await fixture();
  const thread = f.native.agents[1];
  const address = JSON.parse(thread.handle.slice(7)).data;
  f.droppedOriginals.add("root");
  await f.server.rpc(threadOpen, address, f.paseo);
  expect(f.timelines.get(thread.id)?.some(row => row.type === "user_message" && row.messageId === "root")).toBe(false);
  expect(f.timelines.get(thread.id)?.some(row => row.type === "plugin" && row.id.startsWith("multica:comment-source:"))).toBe(false);
  await f.dispose();
  const restarted = f.start();
  f.droppedOriginals.clear();
  await f.reconnect();
  // Recover cached originals even while remote reads fail. No history replay.
  f.failDiscovery(true);
  await resync(restarted.server, f.paseo, "remote-workspace");
  expect(f.timelines.get(thread.id)?.filter(row => row.type === "user_message" && row.messageId === "root")).toHaveLength(1);
  await Promise.all([resync(restarted.server, f.paseo, "remote-workspace"), resync(restarted.server, f.paseo, "remote-workspace")]);
  expect(f.timelines.get(thread.id)?.filter(row => row.type === "assistant_message")).toHaveLength(2);
  expect(f.native.agents).toHaveLength(2);
});

it("restores cached discussions and out-of-order run gaps without fetching every previously read body after restart", async () => {
  const f = await fixture([{ id: "recovery-run", issue_id: "issue", agent_id: "owned-agent", status: "running", trigger_comment_id: "root" }]);
  const thread = f.native.agents[1];
  const address = JSON.parse(thread.handle.slice(7)).data;
  const runAddress = { ...address, runId: "recovery-run" };
  await f.server.rpc(threadOpen, address, f.paseo);
  const identity = { task_id: "recovery-run", issue_id: "issue" };
  f.messages.push({ ...identity, seq: 3, type: "text", content: "Third arrived first" }, { ...identity, seq: 1, type: "text", content: "First" });
  await f.server.rpc(runOpen, runAddress, f.paseo);
  await f.dispose();
  const bodies = f.requests.filter(request => request.url.includes("thread=") || request.url.includes("/messages")).length;
  const restarted = f.start();
  await f.reconnect();
  await resync(restarted.server, f.paseo, "remote-workspace");
  expect(f.requests.filter(request => request.url.includes("thread=") || request.url.includes("/messages"))).toHaveLength(bodies);
  f.messages.push({ ...identity, seq: 2, type: "thinking", content: "Delayed across restart" });
  const opened = await restarted.server.rpc(runOpen, runAddress, f.paseo);
  expect(f.requests.filter(request => request.url.includes("/messages")).at(-1)?.url).toBe("/api/tasks/recovery-run/messages?since=1");
  expect(JSON.parse((await restarted.server.rpc(runRead, { kind: "messages", ...runAddress, revision: opened.revision!, offset: 0 }, f.paseo)).text).map((message: RunMessage) => message.seq)).toEqual([1, 2, 3]);
  expect(f.native.agents).toHaveLength(2);
});


it("never treats a failed older native page as proof that cached originals are missing", async () => {
  const f = await fixture();
  const thread = f.native.agents[1];
  const address = JSON.parse(thread.handle.slice(7)).data;
  await f.server.rpc(threadOpen, address, f.paseo);
  await f.dispose();
  const restarted = f.start();
  await f.reconnect();
  f.nativeHistory.failOlder = true;
  const before = f.timelines.get(thread.id)?.filter(row => row.type !== "plugin");
  expect(await resync(restarted.server, f.paseo, "remote-workspace")).toMatchObject({ status: "unavailable" });
  expect(f.timelines.get(thread.id)?.filter(row => row.type !== "plugin")).toEqual(before);
  f.nativeHistory.failOlder = false;
  expect(await resync(restarted.server, f.paseo, "remote-workspace")).toMatchObject({ status: "ready" });
  expect(f.timelines.get(thread.id)?.filter(row => row.type !== "plugin")).toEqual(before);
});

it("shares agent and member reads across an opened Thread and Run summaries in one sync only", async () => {
  const f = await fixture([{ id: "run", issue_id: "issue", agent_id: "owned-agent", status: "running", trigger_comment_id: "root" }]);
  const address = JSON.parse(f.native.agents[1].handle.slice(7)).data;
  await f.server.rpc(threadOpen, address, f.paseo);
  const before = f.requests.length;
  await resync(f.server, f.paseo, "remote-workspace");
  const round = f.requests.slice(before);
  expect(round.filter(request => request.url.startsWith("/api/agents?"))).toHaveLength(1);
  expect(round.filter(request => request.url.endsWith("/members"))).toHaveLength(1);
  const next = f.requests.length;
  await f.server.rpc(threadOpen, address, f.paseo);
  expect(f.requests.slice(next).filter(request => request.url.startsWith("/api/agents?"))).toHaveLength(1);
});
