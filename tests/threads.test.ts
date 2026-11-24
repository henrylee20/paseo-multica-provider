import { createServer } from "node:http";
import { createRequire } from "node:module";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import type { PaseoApi } from "@getpaseo/client";
import type { DaemonClient } from "@getpaseo/client/internal/daemon-client";
import type { ProviderConnection, ProviderEvent, ProviderTimelineItem } from "@getpaseo/plugin/server/provider";
import { workspaceEnable, syncBootstrap } from "../shared/contracts.js";
import { createServerContribution } from "../server/contribute.js";
import { threadOpen, threadResolve, commentEventDetail } from "../shared/threads.js";
import { FakeServer } from "./support/fake-server.js";

const cleanup: Array<() => void | Promise<void>> = [];
afterEach(async () => { for (const dispose of cleanup.splice(0).reverse()) await dispose(); });
const stamp = "2026-11-24T10:00:00Z";
const comment = (id: string, parent_id: string | null, content: string, author_id = "member-me", author_type = "member") => ({
  id, parent_id, content, author_id, author_type, issue_id: "issue", type: "comment", created_at: stamp, updated_at: stamp, attachments: [],
});
type Comment = ReturnType<typeof comment>;
function conversationRows(rows: ProviderTimelineItem[] | undefined) {
  return rows?.filter(row => row.type !== "plugin" || !row.data || typeof row.data !== "object" || Array.isArray(row.data) || row.data.category !== "source");
}


async function fixture() {
  const home = await mkdtemp(join(tmpdir(), "multica-threads-"));
  cleanup.push(() => rm(home, { recursive: true, force: true }));
  const requests: Array<{ url: string; method: string; slug?: string }> = [];
  const comments: Comment[] = [comment("root", null, "**Root**"), comment("child", "root", "Child", "member-other"), comment("grandchild", "child", "Grandchild", "owned-agent", "agent")];
  let failHistory = false;
  let paginate = false;
  let truncated = false;
  let discoveryPages: Comment[][] | undefined;
  const http = createServer((request, response) => {
    requests.push({ url: request.url!, method: request.method!, slug: request.headers["x-workspace-slug"] as string });
    response.setHeader("Content-Type", "application/json");
    const url = new URL(request.url!, "http://localhost");
    let body: unknown;
    if (url.pathname === "/api/me") body = { id: "member-me", name: "Lin" };
    else if (url.pathname === "/api/workspaces") body = [{ id: "remote-workspace", name: "Product", slug: "product" }];
    else if (url.pathname === "/api/issues") body = { issues: [{ id: "issue", workspace_id: "remote-workspace", title: "Task", description: "Task description", status: "todo" }], total: 1 };
    else if (url.pathname === "/api/workspaces/remote-workspace/members") body = [{ id: "membership-other", user_id: "member-other", name: "River" }];
    else if (url.pathname === "/api/agents") body = [{ id: "owned-agent", name: "Lin Agent", owner_id: "member-me" }];
    else if (url.pathname === "/api/issues/issue/comments") {
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
  const native = { agents: [] as Array<{ id: string; workspaceId: string; cwd: string; labels: Record<string, string>; handle: string; name?: string; archivedAt?: string }> };
  const timelines = new Map<string, ProviderTimelineItem[]>();
  let server: FakeServer;
  let provider: ProviderConnection | undefined;
  async function connect() {
    if (provider) return provider;
    provider = await server.providers.get("multica")!.connect({ versions: [1], capabilities: ["session.persistence", "session.list"] });
    provider.onEvent(event => {
      if (event.type !== "timeline.item") return;
      const rows = timelines.get(event.sessionId) ?? [];
      if (rows.some(row => row.id === event.item.id)) throw new Error(`Duplicate native row ${event.item.id}`);
      rows.push(event.item); timelines.set(event.sessionId, rows);
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
    close: async () => {},
  } as unknown as DaemonClient;
  const start = () => {
    server = new FakeServer();
    const dispose = createServerContribution({ homeDirectory: home, workingDirectory: home, environment: { PASEO_HOME: home }, connectHost: async () => host })(server.context);
    cleanup.push(dispose);
    return { server, dispose };
  };
  const started = start();
  cleanup.push(async () => { await provider?.close(); });
  const paseo = { hosts: { list: async () => ({ self: { serverId: "owning-daemon" } }) } } as unknown as PaseoApi;
  await server!.rpc(workspaceEnable, { workspaceId: "remote-workspace", enabled: true }, paseo);
  return { ...started, native, timelines, comments, requests, paseo, home, start, connect, eventsReady, signal, discoveryPages: (pages: Comment[][]) => { discoveryPages = pages; }, truncated: (value: boolean) => { truncated = value; }, paginate: () => { paginate = true; }, failHistory: (value: boolean) => { failHistory = value; } };
}

it("discovers one stable native tab for a root and recursive replies without loading full background history", async () => {
  const f = await fixture();
  expect(f.native.agents.map(agent => agent.labels["multica.discussion"])).toEqual(["main", "root"]);
  expect(f.native.agents[1].cwd).toBe(f.native.agents[0].cwd);
  expect(f.native.agents[1].handle).not.toBe(f.native.agents[0].handle);
  expect(f.requests.some(request => request.url.includes("thread="))).toBe(false);
  expect(f.timelines.get(f.native.agents[0].id)?.map(row => row.type === "plugin" ? row.kind : row.type)).toEqual(["task-description", "thread"]);
  expect(conversationRows(f.timelines.get(f.native.agents[1].id))).toEqual([expect.objectContaining({ type: "plugin", kind: "thread" })]);
  await f.server.rpc(syncBootstrap, {}, f.paseo);
  expect(f.native.agents).toHaveLength(2);
  expect(f.requests.every(request => request.method === "GET")).toBe(true);
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
  expect(await restarted.server.rpc(syncBootstrap, {}, f.paseo)).toEqual({ status: "ready" });
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
  await f.server.rpc(syncBootstrap, {}, f.paseo);
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
  const address = JSON.parse(f.native.agents[1].handle.slice(7)).data;
  const older = comment("old-root", null, "Old discussion");
  const missing = comment("orphan", "missing-parent", "Unknown ancestry");
  f.discoveryPages([[...f.comments, missing], [older, comment("old-child", "old-root", "Old reply")]]);
  await f.server.rpc(syncBootstrap, {}, f.paseo);
  expect(f.native.agents.map(agent => agent.labels["multica.discussion"])).toEqual(["main", "root", "old-root"]);
  expect(await f.server.rpc(threadResolve, { ...address, commentIds: ["grandchild", "old-child", "orphan", "missing-parent"] }, f.paseo)).toEqual({ comments: [
    { commentId: "grandchild", rootId: "root", status: "resolved" },
    { commentId: "old-child", rootId: "old-root", status: "resolved" },
    { commentId: "orphan", status: "unresolved" }, { commentId: "missing-parent", status: "unresolved" },
  ] });
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


it("exposes each original comment's source date separately from the native ingestion clock", async () => {
  const f = await fixture();
  const thread = f.native.agents[1];
  const address = JSON.parse(thread.handle.slice(7)).data;
  await f.server.rpc(threadOpen, address, f.paseo);
  expect(f.timelines.get(thread.id)).toContainEqual(expect.objectContaining({ type: "plugin", kind: "comment-event", data: expect.objectContaining({ category: "source", commentId: "root", sourceCreatedAt: stamp, sourceUpdatedAt: stamp }) }));
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
  await f.server.rpc(syncBootstrap, {}, f.paseo);
  expect(conversationRows(f.timelines.get(thread.id))).toContainEqual(expect.objectContaining({ type: "plugin", data: expect.objectContaining({ category: "deletion", commentId: "root" }) }));
  await f.server.rpc(syncBootstrap, {}, f.paseo);
  expect(conversationRows(f.timelines.get(thread.id))).toHaveLength(7);
  expect(f.native.agents).toHaveLength(2);
});
