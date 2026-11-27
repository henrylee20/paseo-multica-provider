import { createServer } from "node:http";
import { createRequire } from "node:module";
import { mkdtemp, mkdir, writeFile, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import type { PaseoApi } from "@getpaseo/client";
import type { DaemonClient } from "@getpaseo/client/internal/daemon-client";
import type { ProviderConnection, ProviderEvent, ProviderTimelineItem } from "@getpaseo/plugin/server/provider";
import { workspaceEnable, syncBootstrap } from "../shared/contracts.js";
import { createServerContribution } from "../server/contribute.js";
import { threadOpen, commentEventDetail, discussionList } from "../shared/threads.js";
import { StateStore, connectionState, issueSchema } from "../server/state.js";
import { runStatusSchema } from "../shared/runs.js";
import { FakeServer, resync } from "./support/fake-server.js";
import { metadataHost } from "./support/metadata-host.js";
import { readTaskDescription } from "../shared/description.js";
import { textRevision } from "../server/chunked-text.js";

const cleanup: Array<() => void | Promise<void>> = [];
afterEach(async () => { for (const dispose of cleanup.splice(0).reverse()) await dispose(); });
const stamp = "2026-11-24T10:00:00Z";
const comment = (id: string, parent_id: string | null, content: string, author_id = "member-me", author_type = "member") => ({
  id, parent_id, content, author_id, author_type, source_task_id: undefined as string | null | undefined, issue_id: "issue", type: "comment", created_at: stamp, updated_at: stamp, attachments: [],
});
type Comment = ReturnType<typeof comment>;
function conversationRows(rows: ProviderTimelineItem[] | undefined) {
  return rows?.filter(row => row.type !== "plugin" || (row.kind !== "comment-divider" && (!row.data || typeof row.data !== "object" || Array.isArray(row.data) || row.data.category !== "source")));
}

function discussionOrder(rows: ProviderTimelineItem[] = []) {
  return rows.filter(row => /^multica:(comment:|divider:|run-marker:)/.test(row.id)).map(row => row.id.replace("multica:", ""));
}


type Run = { created_at?: string; id: string; issue_id: string; agent_id: string; status: string; trigger_comment_id?: string | null; coalesced_comment_ids?: string[]; delivered_comment_ids?: string[]; supplement_comment_ids?: string[]; error?: string | null; failure_reason?: string | null; work_dir?: string | null; relative_work_dir?: string | null };
type RunMessage = { task_id: string; issue_id: string; seq: number; type: "text" | "thinking" | "tool_use" | "tool_result" | "error"; call_id?: string; tool?: string; content?: string; input?: Record<string, unknown>; output?: string; output_truncated?: boolean };
async function fixture(initialRuns: Run[] = [], openOnImport = true, initialMessages: RunMessage[] = [], subsessions = true) {
  const home = await mkdtemp(join(tmpdir(), "multica-threads-"));
  cleanup.push(() => rm(home, { recursive: true, force: true }));
  const requests: Array<{ url: string; method: string; slug?: string }> = [];
  const comments: Comment[] = [comment("root", null, "**Root**"), comment("child", "root", "Child", "member-other"), comment("grandchild", "child", "Grandchild", "owned-agent", "agent")];
  const runs = [...initialRuns];
  const messages: RunMessage[] = [...initialMessages];
  let failMessages = false;
  let beforeMessages: (() => Promise<void>) | undefined;
  let beforeHistory: (() => Promise<void>) | undefined;
  let identity = "member-me";
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
      await beforeMessages?.();
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
        await beforeHistory?.();
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
    provider = await server.providers.get("multica")!.connect({ versions: [1], capabilities: ["session.persistence", ...(subsessions ? ["session.subsession"] : []), "session.list"] });
    provider.onEvent(event => {
      providerEvents.push(event);
      if (event.type === "session.opened" && event.parentSessionId) timelines.set(event.sessionId, []);
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
      if (openOnImport) await connection.send({ type: "session.open", requestId: `import-${agent.id}`, sessionId: agent.id, history: "replay", persistence: JSON.parse(agent.handle.slice(7)),
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
  cleanup.push(async () => {
    await provider?.close();
    // A cached RPC read drains pending marker writes before the fixture directory is removed.
    if (native.agents[0]) await server.rpc(readTaskDescription, { connectionKey: native.agents[0].labels["multica.connection"], issueId: "issue", revision: textRevision("Task description"), offset: 0 }, paseo);
  });
  const paseo = { hosts: { list: async () => ({ self: { serverId: "owning-daemon" } }) } } as unknown as PaseoApi;
  await server!.syncRpc(workspaceEnable, { workspaceId: "remote-workspace", enabled: true }, paseo);
  return { blockHistory: (handler?: () => Promise<void>) => { beforeHistory = handler; }, blockMessages: (handler?: () => Promise<void>) => { beforeMessages = handler; }, ...started, native, timelines, droppedOriginals, nativeHistory, reconnect, comments, requests, paseo, home, start, connect, eventsReady, signal, runs, messages, providerEvents, failMessages: (value: boolean) => {
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

async function loadDiscussion(f: Awaited<ReturnType<typeof fixture>>, rootId = "root") {
  const parent = f.native.agents.find(agent => agent.labels["multica.discussion"] === rootId)!;
  return f.server.rpc(threadOpen, { ...JSON.parse(parent.handle.slice(7)).data, rootId }, f.paseo);
}

it("lists only cached visible Threads by activity and title, with ownership flags, even without a CLI connection", async () => {
  const home = await mkdtemp(join(tmpdir(), "multica-discussions-"));
  cleanup.push(() => rm(home, { recursive: true, force: true }));
  const directory = join(home, "state"), store = new StateStore(directory);
  const statuses = runStatusSchema.options;
  await store.update(state => {
    state.owner = { profile: "" };
    const saved = connectionState(state, "cached-account");
    saved.issues.issue = issueSchema.parse({ remoteWorkspaceId: "remote", workspaceId: "native", cwd: home, title: "Task", description: "Goal",
      overview: { identifier: "PRD-1" }, mainAgentId: "main-agent", manualHidden: { workspace: false, discussions: ["main", "hidden", "not-mapped"] },
      threads: { main: { title: "主讨论" }, hidden: { title: "Hidden", agentId: "hidden-agent" }, newest: { title: "Z latest", agentId: "newest-agent" },
        beta: { title: "Beta", agentId: "beta-agent" }, alpha: { title: "Alpha", agentId: "alpha-agent" }, missingB: { title: "Delta" }, missingA: { title: "Charlie" },
        ...Object.fromEntries(statuses.map(status => [status, { title: `Run ${status}` }])),
      },
      commentRoots: { first: "newest", last: "newest", beta: "beta", alpha: "alpha", hidden: "hidden", invalid: "missingB", main: "main" },
      commentCreatedAt: { first: stamp, last: "2026-11-24T10:00:00.100000002Z", beta: "2026-11-24T10:00:00.100000001Z", alpha: "2026-11-24T10:00:00.100000001Z",
        hidden: "2027-01-01T00:00:00Z", invalid: "not-a-time", main: "2028-01-01T00:00:00Z", unrelated: "2029-01-01T00:00:00Z" },
      runs: Object.fromEntries([...statuses.map(status => [status, { agentId: "remote-agent", agentName: "Agent", status, ownerRootId: status,
        coalescedCommentIds: [], supplementCommentIds: [] }]), ["latest", { agentId: "remote-agent", agentName: "Agent", status: "queued", ownerRootId: "newest",
        coalescedCommentIds: ["alpha"], supplementCommentIds: [] }]]),
      askuserCards: { pending: { commentId: "card", attachmentId: "file", rootId: "beta", status: "pending", collapsed: true },
        deleted: { commentId: "deleted", attachmentId: "file", rootId: "alpha", status: "pending", deleted: true },
        answered: { commentId: "answered", attachmentId: "file", rootId: "alpha", status: "answered" },
        main: { commentId: "main-card", attachmentId: "file", rootId: "main", status: "pending" } },
    });
    connectionState(state, "another-account").issues.issue = issueSchema.parse({ remoteWorkspaceId: "remote", workspaceId: "other-native", cwd: home, title: "Other", description: "" });
  });
  const server = new FakeServer(), connectHost = vi.fn();
  const dispose = createServerContribution({ homeDirectory: home, workingDirectory: home, stateDirectory: directory, environment: {}, connectHost })(server.context);
  cleanup.push(dispose);
  const remote = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("Cached RPC must not read Multica"));
  try {
    const before = await stat(join(directory, "state.json")), contents = await readFile(join(directory, "state.json"), "utf8");
    const result = await server.rpc(discussionList, { workspaceId: "native" }, {} as PaseoApi);
    expect(result).toMatchObject({ identifier: "PRD-1", hiddenCount: 2 });
    expect(result!.threads.slice(0, 5).map(thread => thread.rootId)).toEqual(["newest", "alpha", "beta", "missingA", "missingB"]);
    expect(result!.threads[0]).toMatchObject({ agentId: "newest-agent", lastActivityAt: "2026-11-24T10:00:00.100000002Z", running: true, pendingAskuser: false });
    expect(result!.threads.find(thread => thread.rootId === "alpha")).toMatchObject({ running: false, pendingAskuser: false });
    expect(result!.threads.find(thread => thread.rootId === "beta")).toMatchObject({ running: false, pendingAskuser: true });
    expect(result!.threads.find(thread => thread.rootId === "missingA")?.agentId).toBeUndefined();
    expect(result!.threads.find(thread => thread.rootId === "missingB")?.lastActivityAt).toBeUndefined();
    expect(result!.threads.some(thread => ["main", "hidden"].includes(thread.rootId))).toBe(false);
    for (const status of statuses) expect(result!.threads.find(thread => thread.rootId === status)?.running).toBe(!["completed", "failed", "cancelled"].includes(status));
    expect(await server.rpc(discussionList, { workspaceId: "other-native" }, {} as PaseoApi)).toMatchObject({ threads: [], hiddenCount: 0 });
    expect(await server.rpc(discussionList, { workspaceId: "unknown" }, {} as PaseoApi)).toBeNull();
    expect(remote).not.toHaveBeenCalled(); expect(connectHost).not.toHaveBeenCalled();
    expect((await stat(join(directory, "state.json"))).ino).toBe(before.ino);
    expect(await readFile(join(directory, "state.json"), "utf8")).toBe(contents);
  } finally { remote.mockRestore(); }
});

it.each(["empty", "cached"])("interleaves cached Run markers and children with %s comment history on replay", async cache => {
  const f = await fixture([
    { id: "b", issue_id: "issue", agent_id: "owned-agent", status: "completed", trigger_comment_id: "grandchild", created_at: "2026-11-24T10:00:02.5Z" },
    { id: "a", issue_id: "issue", agent_id: "owned-agent", status: "completed", trigger_comment_id: "child", created_at: "2026-11-24T10:00:01.5Z" },
  ], false, [{ task_id: "a", issue_id: "issue", seq: 1, type: "text", content: "Cached execution" }]);
  f.comments[1].created_at = "2026-11-24T10:00:01Z";
  f.comments[2].created_at = "2026-11-24T10:00:02Z";
  await resync(f.server, f.paseo, "remote-workspace");
  const parent = f.native.agents[1], address = JSON.parse(parent.handle.slice(7)).data;
  if (cache === "cached") await f.server.rpc(threadOpen, address, f.paseo);
  const sessionId = `ordered-${cache}`, provider = await f.connect();
  await provider.send({ type: "session.open", requestId: sessionId, sessionId, history: "replay", persistence: JSON.parse(parent.handle.slice(7)), config: { cwd: parent.cwd, env: {}, mcpServers: {}, settings: {}, persist: true } });
  if (cache === "empty") {
    await expect.poll(() => f.requests.some(request => request.url.includes("/tasks/a/messages"))).toBe(true);
    expect(f.providerEvents.some(event => event.type === "session.opened" && event.parentSessionId === sessionId)).toBe(false);
    expect(discussionOrder(f.timelines.get(sessionId))).toEqual([]);
    await f.server.rpc(threadOpen, address, f.paseo);
  }
  expect(discussionOrder(f.timelines.get(sessionId))).toEqual([
    "comment:root", "divider:child", "comment:child", "run-marker:a", "divider:grandchild", "comment:grandchild", "run-marker:b",
  ]);
  await expect.poll(() => f.timelines.get(`${sessionId}:run:a`)?.some(row => row.type === "assistant_message" && row.text === "Cached execution")).toBe(true);
  const marker = f.providerEvents.findIndex(event => event.type === "timeline.item" && event.sessionId === sessionId && event.item.id === "multica:run-marker:a");
  const child = f.providerEvents.findIndex(event => event.type === "session.opened" && event.sessionId === `${sessionId}:run:a`);
  expect(marker).toBeLessThan(child);
  expect(f.providerEvents).toContainEqual({ type: "session.turn", sessionId: `${sessionId}:run:a`, turnId: "a", state: "completed" });
});

it("orders Runs sharing a trigger by nanosecond creation time then ID and places a later rerun after intervening comments", async () => {
  const base = { issue_id: "issue", agent_id: "owned-agent", status: "completed", trigger_comment_id: "root" };
  const f = await fixture([
    { ...base, id: "rerun", created_at: "2026-11-24T10:00:01.5Z" },
    { ...base, id: "b", created_at: "2026-11-24T11:00:00.000000002+01:00" },
    { ...base, id: "z", created_at: "2026-11-24T10:00:00.000000001Z" },
    { ...base, id: "a", created_at: "2026-11-24T10:00:00.000000002Z" },
    { ...base, id: "untimed", created_at: "invalid" },
  ], false);
  f.comments[1].created_at = "2026-11-24T10:00:00.000000002Z";
  f.comments[2].created_at = "2026-11-24T10:00:02Z";
  const parent = f.native.agents[1], provider = await f.connect();
  await provider.send({ type: "session.open", requestId: "ordered", sessionId: parent.id, history: "replay", persistence: JSON.parse(parent.handle.slice(7)), config: { cwd: parent.cwd, env: {}, mcpServers: {}, settings: {}, persist: true } });
  await f.server.rpc(threadOpen, JSON.parse(parent.handle.slice(7)).data, f.paseo);
  expect(discussionOrder(f.timelines.get(parent.id))).toEqual([
    "comment:root", "run-marker:untimed", "run-marker:z", "divider:child", "comment:child", "run-marker:a", "run-marker:b", "run-marker:rerun", "divider:grandchild", "comment:grandchild",
  ]);
});

it.each(["missing", "deleted"])("releases a Run with a %s trigger once the complete comment baseline is delivered", async mode => {
  const f = await fixture([{ id: "orphan", issue_id: "issue", agent_id: "owned-agent", status: "completed", trigger_comment_id: "child", created_at: "2026-11-24T10:00:01.5Z" }], false);
  f.comments[1].created_at = "2026-11-24T10:00:01Z"; f.comments[2].created_at = "2026-11-24T10:00:02Z";
  if (mode === "deleted") Object.assign(f.comments[1], { deleted_at: stamp });
  else { f.comments.splice(1, 1); f.comments[1].parent_id = "root"; }
  const parent = f.native.agents[1], provider = await f.connect();
  await provider.send({ type: "session.open", requestId: "orphan", sessionId: parent.id, history: "replay", persistence: JSON.parse(parent.handle.slice(7)), config: { cwd: parent.cwd, env: {}, mcpServers: {}, settings: {}, persist: true } });
  expect(discussionOrder(f.timelines.get(parent.id))).toEqual([]);
  await f.server.rpc(threadOpen, JSON.parse(parent.handle.slice(7)).data, f.paseo);
  expect(discussionOrder(f.timelines.get(parent.id))).toEqual(mode === "missing"
    ? ["comment:root", "divider:grandchild", "comment:grandchild", "run-marker:orphan"]
    : ["comment:root", "run-marker:orphan", "divider:grandchild", "comment:grandchild"]);
  if (mode === "deleted") {
    const rows = f.timelines.get(parent.id)!;
    expect(rows.findIndex(row => row.id.startsWith("multica:deletion:child:"))).toBeLessThan(rows.findIndex(row => row.id === "multica:run-marker:orphan"));
  }
  await resync(f.server, f.paseo, "remote-workspace");
  expect(f.providerEvents.filter(event => event.type === "timeline.item" && event.sessionId === parent.id && event.item.id === "multica:run-marker:orphan")).toHaveLength(1);
});

it("places a task-level Run between system comments by source time without using generated output as an anchor", async () => {
  const f = await fixture([{ id: "task", issue_id: "issue", agent_id: "owned-agent", status: "completed", created_at: "2026-11-24T10:00:00.5Z" }], false);
  f.comments.push(comment("system-root", null, "System", "system", "system"),
    { ...comment("system-later", "system-root", "Generated", "system", "system"), created_at: "2026-11-24T10:00:01Z", source_task_id: "task" });
  await resync(f.server, f.paseo, "remote-workspace");
  const parent = f.native.agents[0];
  await (await f.connect()).send({ type: "session.open", requestId: "task-order", sessionId: parent.id, history: "replay", persistence: JSON.parse(parent.handle.slice(7)), config: { cwd: parent.cwd, env: {}, mcpServers: {}, settings: {}, persist: true } });
  expect(discussionOrder(f.timelines.get(parent.id))).toEqual([]);
  await f.server.rpc(threadOpen, { ...JSON.parse(parent.handle.slice(7)).data, rootId: "main" }, f.paseo);
  expect(discussionOrder(f.timelines.get(parent.id))).toEqual(["comment:system-root", "run-marker:task", "comment:system-later"]);
});

it("anchors an untriggered Run to the earliest input association in its fixed discussion", async () => {
  const f = await fixture([{ id: "associated", issue_id: "issue", agent_id: "owned-agent", status: "completed", trigger_comment_id: "root", created_at: stamp }], false);
  f.comments[1].created_at = "2026-11-24T10:00:01Z";
  f.comments[2].created_at = "2026-11-24T10:00:02Z";
  f.comments.push({ ...comment("other", null, "Other discussion"), created_at: "2020-01-01T00:00:00Z" });
  f.runs[0].trigger_comment_id = undefined;
  f.runs[0].coalesced_comment_ids = ["other", "grandchild"];
  f.runs[0].delivered_comment_ids = ["child"];
  f.runs[0].supplement_comment_ids = ["grandchild"];
  await resync(f.server, f.paseo, "remote-workspace");
  const parent = f.native.agents[1];
  await (await f.connect()).send({ type: "session.open", requestId: "associated", sessionId: parent.id, history: "replay", persistence: JSON.parse(parent.handle.slice(7)), config: { cwd: parent.cwd, env: {}, mcpServers: {}, settings: {}, persist: true } });
  await f.server.rpc(threadOpen, JSON.parse(parent.handle.slice(7)).data, f.paseo);
  expect(discussionOrder(f.timelines.get(parent.id))).toEqual(["comment:root", "divider:child", "comment:child", "run-marker:associated", "divider:grandchild", "comment:grandchild"]);
});

it.each([true, false])("ignores a trigger in another discussion and uses local inputs when available: %s", async associated => {
  const f = await fixture([{ id: "cross-thread", issue_id: "issue", agent_id: "owned-agent", status: "completed", trigger_comment_id: "root", created_at: "2026-11-24T10:00:00.5Z" }], false);
  f.comments[1].created_at = "2026-11-24T10:00:01Z"; f.comments[2].created_at = "2026-11-24T10:00:02Z";
  f.comments.push(comment("other", null, "Other discussion"));
  f.runs[0].trigger_comment_id = "other";
  f.runs[0].delivered_comment_ids = associated ? ["grandchild", "child"] : [];
  await resync(f.server, f.paseo, "remote-workspace");
  await loadDiscussion(f);
  const parent = f.native.agents[1], reads = f.requests.filter(request => request.url.includes("thread=")).length;
  await (await f.connect()).send({ type: "session.open", requestId: "cross-thread", sessionId: parent.id, history: "replay", persistence: JSON.parse(parent.handle.slice(7)), config: { cwd: parent.cwd, env: {}, mcpServers: {}, settings: {}, persist: true } });
  expect(f.requests.filter(request => request.url.includes("thread="))).toHaveLength(reads);
  expect(discussionOrder(f.timelines.get(parent.id))).toEqual(associated
    ? ["comment:root", "divider:child", "comment:child", "run-marker:cross-thread", "divider:grandchild", "comment:grandchild"]
    : ["comment:root", "run-marker:cross-thread", "divider:child", "comment:child", "divider:grandchild", "comment:grandchild"]);
});

it("defers a newly discovered skip marker until its trigger is confirmed and restores existing children immediately", async () => {
  const f = await fixture([{ id: "old", issue_id: "issue", agent_id: "owned-agent", status: "completed", trigger_comment_id: "root" }]);
  const parent = f.native.agents[1], address = JSON.parse(parent.handle.slice(7)).data, provider = await f.connect();
  await f.server.rpc(threadOpen, address, f.paseo);
  await provider.send({ type: "session.close", requestId: "close", sessionId: parent.id });
  f.comments.push(comment("new-input", "root", "While closed"));
  f.runs.push({ id: "new", issue_id: "issue", agent_id: "owned-agent", status: "completed", trigger_comment_id: "new-input" });
  await resync(f.server, f.paseo, "remote-workspace");
  await provider.send({ type: "session.open", requestId: "skip", sessionId: "skip", history: "skip", persistence: JSON.parse(parent.handle.slice(7)), config: { cwd: parent.cwd, env: {}, mcpServers: {}, settings: {}, persist: true } });
  expect(f.providerEvents).toContainEqual(expect.objectContaining({ type: "session.opened", sessionId: "skip:run:old" }));
  expect(discussionOrder(f.timelines.get("skip"))).toEqual([]);
  await resync(f.server, f.paseo, "remote-workspace");
  const order = discussionOrder(f.timelines.get("skip"));
  expect(order).toEqual(["divider:new-input", "comment:new-input", "run-marker:new"]);
  await f.reconnect();
  expect(f.providerEvents.filter(event => event.type === "timeline.item" && event.item.id === "multica:run-marker:new")).toHaveLength(1);
});

it("does not mistake an old complete cache for proof that a newly discovered trigger is missing", async () => {
  const f = await fixture(); await loadDiscussion(f);
  await f.dispose(); const restarted = f.start(); await f.reconnect();
  await resync(restarted.server, f.paseo, "remote-workspace");
  f.comments.push(comment("unread", "root", "Not loaded in this process"));
  f.runs.push({ id: "unread", issue_id: "issue", agent_id: "owned-agent", status: "completed", trigger_comment_id: "unread" });
  const reads = f.requests.filter(request => request.url.includes("thread=")).length;
  await resync(restarted.server, f.paseo, "remote-workspace");
  expect(f.requests.filter(request => request.url.includes("thread="))).toHaveLength(reads);
  expect(f.providerEvents.some(event => event.type === "timeline.item" && event.item.id === "multica:run-marker:unread")).toBe(false);
  const parent = f.native.agents[1];
  await restarted.server.rpc(threadOpen, JSON.parse(parent.handle.slice(7)).data, f.paseo);
  expect(discussionOrder(f.timelines.get(parent.id)).slice(-3)).toEqual(["divider:unread", "comment:unread", "run-marker:unread"]);
});

it("requires a refresh started after a Run begins waiting before declaring its trigger missing", async () => {
  const f = await fixture([], false);
  f.comments.push(comment("future", "root", "Discovered input"));
  await resync(f.server, f.paseo, "remote-workspace");
  f.comments.pop();
  const parent = f.native.agents[1];
  await (await f.connect()).send({ type: "session.open", requestId: "waiting", sessionId: parent.id, history: "replay", persistence: JSON.parse(parent.handle.slice(7)), config: { cwd: parent.cwd, env: {}, mcpServers: {}, settings: {}, persist: true } });
  let entered!: () => void, release!: () => void;
  const arrived = new Promise<void>(resolve => { entered = resolve; }), blocked = new Promise<void>(resolve => { release = resolve; });
  f.blockHistory(async () => { entered(); await blocked; });
  const reading = loadDiscussion(f);
  try {
    await arrived;
    f.runs.push({ id: "waiting", issue_id: "issue", agent_id: "owned-agent", status: "completed", trigger_comment_id: "future" });
    await resync(f.server, f.paseo, "remote-workspace");
  } finally { release(); }
  await reading; f.blockHistory();
  expect(f.providerEvents.some(event => event.type === "timeline.item" && event.item.id === "multica:run-marker:waiting")).toBe(false);
  await loadDiscussion(f);
  expect(discussionOrder(f.timelines.get(parent.id)).at(-1)).toBe("run-marker:waiting");
  expect(f.providerEvents.filter(event => event.type === "timeline.item" && event.item.id === "multica:run-marker:waiting")).toHaveLength(1);
});

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
  const restored = conversationRows(replay.filter(event => event.type === "timeline.item").map(event => event.item));
  expect(restored?.[0]).toMatchObject({ type: "plugin", data: { title: "Correction after reading" } });
  expect(restored?.slice(1)).toEqual(conversationRows(f.timelines.get(thread.id))?.slice(1));
  await connection.send({ type: "session.close", requestId: "close", sessionId: "restored" });
  await connection.close();
  expect(f.requests.every(request => request.method === "GET")).toBe(true);
});


it.each([
  { type: "status_change", id: "issue-status", text: "Issue completed" },
  { type: "comment", id: "runtime-unusable", text: "运行时当前不可用，任务已排队等待其恢复。" },
])("keeps a top-level $id system comment in the main discussion without creating discussion tabs", async ({ type, id, text }) => {
  const f = await fixture();
  f.comments.push({ ...comment(id, null, text, "system", "system"), type });
  await resync(f.server, f.paseo, "remote-workspace");
  expect(f.native.agents.map(agent => agent.labels["multica.discussion"])).toEqual(["main", "root"]);
  const main = f.native.agents[0];
  const { connectionKey, issueId } = JSON.parse(main.handle.slice(7)).data;
  expect(await f.server.rpc(threadOpen, { connectionKey, issueId, rootId: "main" }, f.paseo)).toEqual({ status: "ready" });
  expect(conversationRows(f.timelines.get(main.id))?.at(-1)).toMatchObject({ type: "plugin", kind: "comment-event", data: { category: "system", text } });
  expect(conversationRows(f.timelines.get(main.id))?.some(row => row.type === "user_message" || row.type === "assistant_message")).toBe(false);
});

it("uses the same brief Thread description when opening and listing sessions", async () => {
  const f = await fixture();
  const thread = f.native.agents[1];
  expect(f.providerEvents).toContainEqual(expect.objectContaining({ type: "session.opened", sessionId: thread.id, description: "Thread · Task" }));
  await (await f.connect()).send({ type: "sessions", requestId: "thread-descriptions", cwd: thread.cwd });
  expect(f.providerEvents).toContainEqual(expect.objectContaining({ type: "sessions", requestId: "thread-descriptions", sessions: expect.arrayContaining([
    expect.objectContaining({ title: "**Root**", description: "Thread · Task" }),
  ]) }));
});

it("names unavailable and unmapped main discussion history without calling it a Thread", async () => {
  const f = await fixture();
  const main = f.native.agents[0];
  const address = { ...JSON.parse(main.handle.slice(7)).data, rootId: "main" };
  expect(await f.server.rpc(threadOpen, { ...address, issueId: "missing" }, f.paseo)).toEqual({ status: "unavailable", message: "此主讨论尚未映射。" });
  await f.identity("another-user");
  expect(await f.server.rpc(threadOpen, address, f.paseo)).toMatchObject({ message: "无法完整读取主讨论；保留已读的本地历史。" });
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
  const ownerOf = (id: string) => f.native.agents.filter(agent => f.timelines.get(agent.id)?.some(row => row.id === `multica:run-marker:${id}`)).map(agent => agent.labels["multica.discussion"]);
  for (const agent of f.native.agents) await loadDiscussion(f, agent.labels["multica.discussion"]);
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
  const provider = await restarted.server.providers.get("multica")!.connect({ versions: [1], capabilities: ["session.persistence", "session.subsession"] });
  const replay: ProviderEvent[] = [];
  provider.onEvent(event => replay.push(event));
  for (const agent of f.native.agents) {
    await provider.send({ type: "session.open", requestId: `replay-${agent.id}`, sessionId: agent.id, history: "replay", persistence: JSON.parse(agent.handle.slice(7)), config: { cwd: agent.cwd, env: {}, mcpServers: {}, settings: {}, persist: true } });
    await restarted.server.rpc(threadOpen, { ...JSON.parse(agent.handle.slice(7)).data, rootId: agent.labels["multica.discussion"] }, f.paseo);
  }
  const owners = (runId: string) => replay.flatMap(event => event.type === "timeline.item" && event.item.id === `multica:run-marker:${runId}` ? [f.native.agents.find(agent => agent.id === event.sessionId)!.labels["multica.discussion"]] : []);
  expect(owners("earliest")).toEqual(["z-earliest"]);
  expect(owners("unanchored")).toEqual(["main"]);
  expect(owners("trigger")).toEqual(["a-later"]);
  await provider.close();
});

it("uses source timestamps including sub-millisecond precision and timezone offsets for earliest associated ownership", async () => {
  const f = await fixture();
  f.comments.push({ ...comment("early", null, "Early"), created_at: "2020-01-01T01:00:00.000000001+01:00" }, { ...comment("later", null, "Later"), created_at: "2020-01-01T00:00:00.000000002Z" });
  f.runs.push({ id: "precise", issue_id: "issue", agent_id: "owned-agent", status: "completed", delivered_comment_ids: ["later", "early"] });
  await resync(f.server, f.paseo, "remote-workspace");
  await loadDiscussion(f, "early");
  const summaries = [...f.timelines.values()].flat().filter(row => row.id === "multica:run-marker:precise");
  expect(summaries).toHaveLength(1);
  expect(f.timelines.get(f.native.agents.find(agent => agent.labels["multica.discussion"] === "early")!.id)).toContain(summaries[0]);
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
  expect(f.requests.some(request => request.url.includes("thread="))).toBe(false);
  for (const agent of f.native.agents) await loadDiscussion(f, agent.labels["multica.discussion"]);
  const owners = (id: string) => f.native.agents.filter(agent => f.timelines.get(agent.id)?.some(row => row.id === `multica:run-marker:${id}`)).map(agent => agent.labels["multica.discussion"]);
  expect(owners("generated-only")).toEqual(["generated-early"]);
  expect(owners("fixed-main")).toEqual(["main"]);
  expect(owners("trigger-priority")).toEqual(["root"]);
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

it("negotiates read-only Run children and static completed markers, appending granular active states", async () => {
  const f = await fixture([{ id: "one", issue_id: "issue", agent_id: "owned-agent", status: "queued", trigger_comment_id: "child" }]);
  await loadDiscussion(f);
  const parent = f.native.agents[1].id, child = `${parent}:run:one`;
  expect((await f.connect()).capabilities).toContain("session.subsession");
  expect(f.providerEvents).toContainEqual(expect.objectContaining({ type: "session.opened", sessionId: child, parentSessionId: parent, toolCallId: "multica:run-marker:one", restoration: "parent", title: "Lin Agent", description: "由 River 的评论触发", capabilities: [] }));
  const marker = f.timelines.get(parent)!.find(row => row.id === "multica:run-marker:one");
  expect(marker).toMatchObject({ type: "tool_call", name: "Lin Agent", status: "completed", detail: { type: "sub_agent", description: "由 River 的评论触发" } });
  for (const status of ["dispatched", "running", "waiting_local_directory", "deferred", "completed"]) {
    f.runs[0].status = status; await resync(f.server, f.paseo, "remote-workspace");
  }
  expect(f.timelines.get(child)!.filter(row => row.type === "notification").map(row => row.message)).toEqual(["排队中", "已分派", "执行中", "等待远端目录", "延后执行"]);
  expect(f.providerEvents.filter(event => event.type === "timeline.item" && event.sessionId === parent && event.item.id === marker!.id)).toHaveLength(1);
  expect(f.providerEvents.filter(event => event.type === "session.turn" && event.sessionId === child)).toMatchObject([{ state: "started" }, { state: "completed" }]);
  f.runs.push({ ...f.runs[0], id: "rerun", status: "running" }); await resync(f.server, f.paseo, "remote-workspace");
  expect(f.providerEvents).toContainEqual(expect.objectContaining({ type: "session.opened", sessionId: `${parent}:run:rerun` }));
  const connection = await f.connect();
  await connection.send({ type: "session.prompt", sessionId: child, prompt: { clientMessageId: "readonly", delivery: "auto", input: { type: "message", content: [{ type: "text", text: "No" }] } } });
  expect(f.providerEvents).toContainEqual(expect.objectContaining({ type: "session.prompt_result", sessionId: child, result: expect.objectContaining({ type: "failed" }) }));
  expect(f.requests.every(request => request.method === "GET")).toBe(true);
  expect([...f.timelines.values()].flat().some(row => row.type === "plugin" && row.kind === "run-summary")).toBe(false);
  expect([...f.timelines.values()].flat().some(row => row.id.startsWith("multica:run:"))).toBe(false);
});

it("pushes ordered text, reasoning, tool input/results and full failure/remote metadata only into the Run child", async () => {
  const input = { task_id: "detail", issue_id: "issue" };
  const huge = "结果😀".repeat(30000);
  const messages: RunMessage[] = [
    { ...input, seq: 1, type: "text", content: "Starting" },
    { ...input, seq: 2, type: "thinking", content: "Plan" },
    { ...input, seq: 3, type: "tool_use", call_id: "call", tool: "read", input: { file: "code.ts" } },
    { ...input, seq: 4, type: "tool_result", call_id: "call", output: huge, output_truncated: true },
    { ...input, seq: 5, type: "error", content: "Source error" },
  ];
  const f = await fixture([{ id: "detail", issue_id: "issue", agent_id: "owned-agent", status: "failed", trigger_comment_id: "root", error: "Pre-stream error", failure_reason: "directory_error", work_dir: "/remote/path", relative_work_dir: "../code" }], true, messages);
  await loadDiscussion(f);
  const parent = f.native.agents[1].id, child = `${parent}:run:detail`;
  const rows = f.timelines.get(child)!;
  const messagesOnly = rows.filter(row => row.id.startsWith("run-message:"));
  expect(messagesOnly.slice(0, 4)).toMatchObject([{ type: "assistant_message", text: "Starting" }, { type: "reasoning", text: "Plan" }, { type: "tool_call", name: "read", detail: { text: expect.stringContaining("code.ts") } }, { type: "tool_call", detail: { label: "工具结果" } }]);
  expect(rows.filter(row => row.type === "tool_call" && row.detail.type === "plain_text" && row.detail.label === "工具结果").map(row => row.type === "tool_call" && row.detail.type === "plain_text" ? row.detail.text : "").join("")).toBe(huge + "\n源端已截断：缺失内容无法恢复。");
  expect(rows).toContainEqual(expect.objectContaining({ type: "error", message: "Source error" }));
  expect(rows).toContainEqual(expect.objectContaining({ type: "error", message: "任务错误：Pre-stream error" }));
  expect(rows).toContainEqual(expect.objectContaining({ type: "notification", message: "远端目录：/remote/path" }));
  expect(rows.every(row => Buffer.byteLength(JSON.stringify(row)) < 64 * 1024)).toBe(true);
  expect(f.native.agents.every(agent => agent.cwd !== "/remote/path")).toBe(true);
  expect(f.timelines.get(parent)!.some(row => row.id.startsWith("run-message:") || row.id.startsWith("run-metadata:"))).toBe(false);
  const count = f.requests.filter(request => request.url.includes("/messages")).length;
  await resync(f.server, f.paseo, "remote-workspace");
  expect(f.requests.filter(request => request.url.includes("/messages"))).toHaveLength(count);
});

it("reads details only for discussions opened in this process, refreshes active Runs periodically and stops after terminal fill", async () => {
  const f = await fixture([{ id: "live", issue_id: "issue", agent_id: "owned-agent", status: "running", trigger_comment_id: "root" }, { id: "unopened", issue_id: "issue", agent_id: "owned-agent", status: "completed" }], false);
  expect(f.requests.some(request => request.url.includes("/messages"))).toBe(false);
  const agent = f.native.agents[1], provider = await f.connect();
  await provider.send({ type: "session.open", requestId: "open", sessionId: agent.id, history: "replay", persistence: JSON.parse(agent.handle.slice(7)), config: { cwd: agent.cwd, env: {}, mcpServers: {}, settings: {}, persist: true } });
  await loadDiscussion(f);
  await expect.poll(() => f.requests.filter(request => request.url.includes("/tasks/live/messages")).length).toBe(1);
  f.messages.push({ task_id: "live", issue_id: "issue", seq: 1, type: "text", content: "Periodic output" });
  await expect.poll(() => f.timelines.get(`${agent.id}:run:live`)?.some(row => row.type === "assistant_message" && row.text === "Periodic output"), { timeout: 4000 }).toBe(true);
  expect(f.requests.some(request => request.url.includes("/tasks/unopened/messages"))).toBe(false);
  f.runs[0].status = "completed";
  await resync(f.server, f.paseo, "remote-workspace");
  const count = f.requests.filter(request => request.url.includes("/tasks/live/messages")).length;
  await new Promise(resolve => setTimeout(resolve, 2200));
  expect(f.requests.filter(request => request.url.includes("/tasks/live/messages"))).toHaveLength(count);
  await provider.send({ type: "session.close", requestId: "close", sessionId: agent.id });
  await provider.send({ type: "session.open", requestId: "reopen", sessionId: "again", history: "skip", persistence: JSON.parse(agent.handle.slice(7)), config: { cwd: agent.cwd, env: {}, mcpServers: {}, settings: {}, persist: true } });
  expect(f.timelines.get("again:run:live")).toContainEqual(expect.objectContaining({ type: "assistant_message", text: "Periodic output" }));
  expect(f.timelines.get("again")?.some(row => row.id.startsWith("multica:run-marker:"))).toBe(false);
}, 10_000);

it("fills delayed source gaps without reordering projected messages and retains cached children offline", async () => {
  const f = await fixture([{ id: "gap", issue_id: "issue", agent_id: "owned-agent", status: "running", trigger_comment_id: "root" }]);
  await loadDiscussion(f);
  const base = { task_id: "gap", issue_id: "issue" };
  f.messages.push({ ...base, seq: 3, type: "text", content: "Third" }, { ...base, seq: 1, type: "text", content: "First" });
  await resync(f.server, f.paseo, "remote-workspace");
  const child = `${f.native.agents[1].id}:run:gap`;
  expect(f.timelines.get(child)!.filter(row => row.type === "assistant_message").map(row => row.text)).toEqual(["First"]);
  f.messages.push({ ...base, seq: 2, type: "text", content: "Second" });
  await resync(f.server, f.paseo, "remote-workspace");
  expect(f.timelines.get(child)!.filter(row => row.type === "assistant_message").map(row => row.text)).toEqual(["First", "Second", "Third"]);
  expect(f.requests.filter(request => request.url.includes("/messages")).at(-1)?.url).toBe("/api/tasks/gap/messages?since=1");
  await f.identity("other-user");
  const before = f.requests.filter(request => request.url.includes("/messages")).length;
  await f.dispose();
  f.start();
  await f.reconnect();
  await new Promise(resolve => setImmediate(resolve));
  expect(f.requests.filter(request => request.url.includes("/messages"))).toHaveLength(before);
  expect(f.timelines.get(child)!.filter(row => row.type === "assistant_message").map(row => row.text)).toEqual(["First", "Second", "Third"]);
});

it("describes comment-triggered children with creation time and unassociated Runs as task-level executions", async () => {
  const created_at = "2026-11-25T06:03:00Z", date = new Date(created_at);
  const stamp = `${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")} ${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`;
  const f = await fixture([{ id: "triggered", issue_id: "issue", agent_id: "owned-agent", status: "completed", trigger_comment_id: "child", created_at }, { id: "task", issue_id: "issue", agent_id: "owned-agent", status: "failed" }]);
  await loadDiscussion(f); await loadDiscussion(f, "main");
  expect(f.providerEvents).toContainEqual(expect.objectContaining({ type: "session.opened", parentSessionId: f.native.agents[1].id, description: `由 River 的评论触发 · ${stamp}` }));
  expect(f.providerEvents).toContainEqual(expect.objectContaining({ type: "session.opened", parentSessionId: f.native.agents[0].id, description: "任务级执行" }));
  const address = JSON.parse(f.native.agents[1].handle.slice(7)).data;
  for (const name of ["run.read", "run.open", "run.observe"]) await expect(f.server.rpc({ ...threadOpen, name }, address, f.paseo)).rejects.toThrow("RPC not registered");
});

it("rejects cross-Issue execution messages and keeps previously cached child content", async () => {
  const f = await fixture([{ id: "safe", issue_id: "issue", agent_id: "owned-agent", status: "running", trigger_comment_id: "root" }], true, [{ task_id: "safe", issue_id: "issue", seq: 1, type: "text", content: "Authorized" }]);
  await loadDiscussion(f);
  f.messages.push({ task_id: "safe", issue_id: "other-issue", seq: 2, type: "text", content: "Wrong Issue" });
  await resync(f.server, f.paseo, "remote-workspace");
  const rows = f.timelines.get(`${f.native.agents[1].id}:run:safe`)!;
  expect(rows.filter(row => row.type === "assistant_message").map(row => row.text)).toEqual(["Authorized"]);
});

it("does not render null or empty Run metadata as errors or paths", async () => {
  const f = await fixture([{ id: "healthy", issue_id: "issue", agent_id: "owned-agent", status: "completed", trigger_comment_id: "root", error: null, failure_reason: null, work_dir: null, relative_work_dir: "" }]);
  await loadDiscussion(f);
  const rows = f.timelines.get(`${f.native.agents[1].id}:run:healthy`)!;
  expect(rows.filter(row => row.id.startsWith("run-metadata:"))).toEqual([]);
  expect(rows.filter(row => row.type === "error")).toEqual([]);
});

it("leaves running child teardown to the host when its parent closes", async () => {
  const f = await fixture([{ id: "live-close", issue_id: "issue", agent_id: "owned-agent", status: "running", trigger_comment_id: "root" }]);
  await loadDiscussion(f);
  const parent = f.native.agents[1].id, child = `${parent}:run:live-close`;
  const start = f.providerEvents.length;
  await (await f.connect()).send({ type: "session.close", requestId: "close-parent", sessionId: parent });
  expect(f.providerEvents.slice(start)).toContainEqual({ type: "session.closed", sessionId: parent });
  expect(f.providerEvents.slice(start).some(event => "sessionId" in event && event.sessionId === child)).toBe(false);
  expect(f.requests.every(request => request.method === "GET")).toBe(true);
});

it("skip restoration emits markers discovered while closed exactly once and preserves them across restart", async () => {
  const f = await fixture([{ id: "old", issue_id: "issue", agent_id: "owned-agent", status: "completed", trigger_comment_id: "root" }]);
  await loadDiscussion(f);
  const parent = f.native.agents[1], provider = await f.connect();
  await provider.send({ type: "session.close", requestId: "close", sessionId: parent.id });
  f.runs.push({ id: "while-closed", issue_id: "issue", agent_id: "owned-agent", status: "completed", trigger_comment_id: "root" });
  await resync(f.server, f.paseo, "remote-workspace");
  const open = (sessionId: string) => provider.send({ type: "session.open", requestId: sessionId, sessionId, history: "skip", persistence: JSON.parse(parent.handle.slice(7)), config: { cwd: parent.cwd, env: {}, mcpServers: {}, settings: {}, persist: true } });
  await open("skip-first");
  await resync(f.server, f.paseo, "remote-workspace"); // Recovery confirms the host's existing trigger before releasing the new marker.
  expect(f.timelines.get("skip-first")!.filter(row => row.type === "tool_call").map(row => row.id)).toEqual(["multica:run-marker:while-closed"]);
  await resync(f.server, f.paseo, "remote-workspace");
  await provider.send({ type: "session.close", requestId: "close-again", sessionId: "skip-first" });
  await f.dispose(); f.start(); await f.reconnect();
  const replayed = f.providerEvents.filter(event => event.type === "timeline.item" && event.sessionId === parent.id && event.item.id === "multica:run-marker:while-closed");
  expect(replayed).toHaveLength(0);
  expect(f.providerEvents.filter(event => event.type === "timeline.item" && event.item.id === "multica:run-marker:while-closed")).toHaveLength(1);
});

it("does not poll execution details when subsessions are not negotiated", async () => {
  const f = await fixture([{ id: "unsupported", issue_id: "issue", agent_id: "owned-agent", status: "running", trigger_comment_id: "root" }], true, [], false);
  expect((await f.connect()).capabilities).not.toContain("session.subsession");
  await resync(f.server, f.paseo, "remote-workspace");
  await new Promise(resolve => setTimeout(resolve, 2200));
  expect(f.requests.some(request => request.url.includes("/messages"))).toBe(false);
  expect(f.providerEvents.some(event => event.type === "session.opened" && event.parentSessionId)).toBe(false);
});

it("ends a terminal child immediately while deferring messages behind a missing prefix until final fill", async () => {
  const base = { task_id: "gap-end", issue_id: "issue" };
  const f = await fixture([{ id: "gap-end", issue_id: "issue", agent_id: "owned-agent", status: "running", trigger_comment_id: "root" }], true, [{ ...base, seq: 3, type: "text", content: "Third" }]);
  await loadDiscussion(f);
  const child = `${f.native.agents[1].id}:run:gap-end`;
  expect(f.timelines.get(child)!.some(row => row.type === "assistant_message")).toBe(false);
  let release!: () => void, entered!: () => void;
  const blocked = new Promise<void>(resolve => { release = resolve; }), arrived = new Promise<void>(resolve => { entered = resolve; });
  f.blockMessages(async () => { entered(); await blocked; });
  f.runs[0].status = "completed";
  const syncing = resync(f.server, f.paseo, "remote-workspace");
  try {
    await arrived;
    expect(f.timelines.get(child)!.some(row => row.type === "assistant_message")).toBe(false);
    expect(f.providerEvents.filter(event => event.type === "session.turn" && event.sessionId === child)).toMatchObject([{ state: "started" }, { state: "completed" }]);
    f.messages.push({ ...base, seq: 1, type: "text", content: "First" }, { ...base, seq: 2, type: "text", content: "Second" });
  } finally { release(); }
  await syncing;
  expect(f.timelines.get(child)!.filter(row => row.type === "assistant_message").map(row => row.text)).toEqual(["First", "Second", "Third"]);
  const events = f.providerEvents.filter(event => "sessionId" in event && event.sessionId === child);
  expect(events.at(-1)).toMatchObject({ type: "timeline.item", item: { type: "assistant_message", text: "Third" } });
  expect(events.filter(event => event.type === "session.turn")).toMatchObject([{ state: "started" }, { state: "completed" }]);
  const reads = f.requests.filter(request => request.url.includes("/messages")).length;
  await resync(f.server, f.paseo, "remote-workspace");
  expect(f.requests.filter(request => request.url.includes("/messages"))).toHaveLength(reads);
});

it("labels system triggers and never treats a Run's own generated comment as its trigger", async () => {
  const f = await fixture();
  f.comments.push({ ...comment("system-trigger", null, "System", "system-id", "system"), type: "system" }, { ...comment("own-output", null, "Output", "owned-agent", "agent"), source_task_id: "generated" });
  f.runs.push({ id: "system-run", issue_id: "issue", agent_id: "owned-agent", status: "completed", trigger_comment_id: "system-trigger" }, { id: "generated", issue_id: "issue", agent_id: "owned-agent", status: "completed", created_at: stamp });
  await resync(f.server, f.paseo, "remote-workspace");
  await loadDiscussion(f, "main"); await loadDiscussion(f, "own-output");
  expect(f.providerEvents).toContainEqual(expect.objectContaining({ type: "session.opened", description: "由 系统 的评论触发" }));
  const generated = f.providerEvents.find(event => event.type === "session.opened" && event.sessionId.endsWith(":run:generated"));
  expect(generated).toMatchObject({ description: expect.stringMatching(/^任务级执行 · 11-24 /) });
});

it("shows a historical Run's terminal state when its execution messages cannot be fetched", async () => {
  const f = await fixture([{ id: "offline", issue_id: "issue", agent_id: "owned-agent", status: "completed", trigger_comment_id: "root" }], false);
  f.failMessages(true);
  const parent = f.native.agents[1], provider = await f.connect();
  await provider.send({ type: "session.open", requestId: "offline-open", sessionId: parent.id, history: "skip", persistence: JSON.parse(parent.handle.slice(7)), config: { cwd: parent.cwd, env: {}, mcpServers: {}, settings: {}, persist: true } });
  await loadDiscussion(f);
  await expect.poll(() => f.requests.some(request => request.url.includes("/tasks/offline/messages"))).toBe(true);
  expect(f.providerEvents.filter(event => event.type === "session.turn" && event.sessionId === `${parent.id}:run:offline`)).toMatchObject([{ state: "started" }, { state: "completed" }]);
});

it("places dividers only between native comments during live import and replay, preserving exact originals", async () => {
  const f = await fixture();
  f.comments.push({ ...comment("event", "root", "Status changed", "system", "system"), type: "status_change" });
  const parent = f.native.agents[1], address = JSON.parse(parent.handle.slice(7)).data;
  const visible = (rows: ProviderTimelineItem[]) => rows.filter(row => row.type === "user_message" || row.type === "assistant_message" || (row.type === "plugin" && row.kind === "comment-divider"));
  await f.server.rpc(threadOpen, address, f.paseo);
  const rows = visible(f.timelines.get(parent.id)!);
  expect(rows).toEqual([
    expect.objectContaining({ type: "user_message", text: "**Root**", messageId: "root" }),
    { type: "plugin", id: "multica:divider:child", pluginId: "multica", kind: "comment-divider", version: 1, data: {} },
    expect.objectContaining({ type: "assistant_message", text: "River: \n\nChild", messageId: "child" }),
    { type: "plugin", id: "multica:divider:grandchild", pluginId: "multica", kind: "comment-divider", version: 1, data: {} },
    expect.objectContaining({ type: "assistant_message", text: "Lin Agent: \n\nGrandchild", messageId: "grandchild" }),
  ]);
  const connection = await f.server.providers.get("multica")!.connect({ versions: [1], capabilities: ["session.persistence", "timeline.plugin"] });
  cleanup.push(() => connection.close());
  const replay: ProviderTimelineItem[] = [];
  connection.onEvent(event => { if (event.type === "timeline.item") replay.push(event.item); });
  await connection.send({ type: "session.open", requestId: "replay-dividers", sessionId: "replay-dividers", history: "replay", persistence: JSON.parse(parent.handle.slice(7)), config: { cwd: parent.cwd, env: {}, mcpServers: {}, settings: {}, persist: true } });
  expect(visible(replay)).toEqual(rows);
});

it("does not put a divider before a lone comment or around system events", async () => {
  const f = await fixture();
  f.comments.splice(1);
  f.comments.push({ ...comment("event", "root", "Status changed", "system", "system"), type: "status_change" });
  const parent = f.native.agents[1];
  await f.server.rpc(threadOpen, JSON.parse(parent.handle.slice(7)).data, f.paseo);
  expect(f.timelines.get(parent.id)!.filter(row => row.type === "plugin" && row.kind === "comment-divider")).toEqual([]);
});

it("skip restoration acknowledges existing comments without retroactive dividers and separates a new comment once", async () => {
  const f = await fixture();
  const parent = f.native.agents[1];
  await f.server.rpc(threadOpen, JSON.parse(parent.handle.slice(7)).data, f.paseo);
  await f.dispose(); const restarted = f.start();
  const boundary = f.providerEvents.length;
  await f.reconnect();
  expect(await resync(restarted.server, f.paseo, "remote-workspace")).toMatchObject({ status: "ready" });
  const dividers = () => f.providerEvents.slice(boundary).filter(event => event.type === "timeline.item" && event.sessionId === parent.id && event.item.type === "plugin" && event.item.kind === "comment-divider");
  expect(dividers()).toEqual([]);
  await restarted.server.rpc(threadOpen, JSON.parse(parent.handle.slice(7)).data, f.paseo);
  expect(dividers()).toEqual([]);
  f.comments.push(comment("late", "root", "New comment", "member-other"));
  await resync(restarted.server, f.paseo, "remote-workspace");
  await resync(restarted.server, f.paseo, "remote-workspace");
  expect(dividers()).toMatchObject([{ item: { id: "multica:divider:late" } }]);
  const rows = f.timelines.get(parent.id)!;
  expect(rows.slice(-2)).toMatchObject([{ type: "plugin", kind: "comment-divider" }, { type: "assistant_message", text: "River: \n\nNew comment" }]);
});

it("separates a new comment immediately after skip restart before native history reconciliation", async () => {
  const f = await fixture();
  const parent = f.native.agents[1], address = JSON.parse(parent.handle.slice(7)).data;
  await f.server.rpc(threadOpen, address, f.paseo);
  await f.dispose(); const restarted = f.start();
  const boundary = f.providerEvents.length;
  await f.reconnect();
  f.comments.push(comment("immediate", "root", "Before reconciliation", "member-other"));
  await restarted.server.rpc(threadOpen, address, f.paseo);
  const dividers = f.providerEvents.slice(boundary).filter(event => event.type === "timeline.item" && event.sessionId === parent.id && event.item.type === "plugin" && event.item.kind === "comment-divider");
  expect(dividers).toMatchObject([{ item: { id: "multica:divider:immediate" } }]);
  expect(f.timelines.get(parent.id)!.slice(-2)).toMatchObject([{ type: "plugin", kind: "comment-divider" }, { type: "assistant_message", text: "River: \n\nBefore reconciliation" }]);
});

it("an opened Thread has no idle state writes or renames, preserves a manual name and follows source title changes", async () => {
  const f = await fixture();
  await loadDiscussion(f);
  const agent = f.native.agents[1], file = join(f.home, "multica-provider", "state.json");
  agent.name = "My thread";
  const before = await stat(file);
  await resync(f.server, f.paseo, "remote-workspace");
  expect((await stat(file)).ino).toBe(before.ino);
  expect(agent.name).toBe("My thread");
  f.comments.find(comment => comment.id === "root")!.content = "Updated source title";
  await resync(f.server, f.paseo, "remote-workspace");
  expect(agent.name).toBe("Updated source title");
  await (await f.connect()).send({ type: "session.close", requestId: "idle-recycle", sessionId: agent.id });
  await f.reconnect();
  expect(f.timelines.get(agent.id)?.some(row => row.type === "user_message" || row.type === "assistant_message")).toBe(true);
});
