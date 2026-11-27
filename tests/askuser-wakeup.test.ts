import { createServer } from "node:http";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import type { PaseoApi } from "@getpaseo/client";
import type { ProviderConnection, ProviderEvent } from "@getpaseo/plugin/server/provider";
import type { AgentTimelineItem } from "@getpaseo/protocol/agent-types";
import { workspaceEnable, workspaceRule } from "../shared/contracts.js";
import { askuserReopen } from "../shared/askuser.js";
import { hiddenRestore } from "../shared/hiding.js";
import { threadOpen } from "../shared/threads.js";
import { createServerContribution } from "../server/contribute.js";
import type { NativeHost } from "../server/native-host.js";
import { FakeServer, resync } from "./support/fake-server.js";

const cleanup: Array<() => void | Promise<void>> = [];
afterEach(async () => { for (const dispose of cleanup.splice(0).reverse()) await dispose(); });
const stamp = "2026-11-24T10:00:00Z";
const card = { version: "1", title: "发布确认", description: "此操作会影响生产环境。", questions: [{ id: "reason", type: "text", title: "理由" }] };
const attachment = (id: string) => ({ id, filename: "askuser.json", content_type: "application/json", download_url: `/api/attachments/${id}/download` });
const comment = (issueId: string, id: string, attachments: unknown[] = []) => ({ id, parent_id: null, issue_id: issueId, type: "comment", author_type: "member", author_id: "me", content: `Comment ${id}`, created_at: stamp, attachments });
type Agent = { id: string; workspaceId: string; cwd: string; labels: Record<string, string>; handle: string; archivedAt: string | null; status: string; activeTurn: null };

/** Native import persists a handle; listCommands performs full interactive loading. */
async function fixture(subsessions = false) {
  const home = await mkdtemp(join(tmpdir(), "multica-askuser-wake-"));
  cleanup.push(() => rm(home, { recursive: true, force: true }));
  const issues = [{ id: "issue", workspace_id: "workspace", title: "Task", description: "Description", status: "todo" }];
  const comments = new Map<string, ReturnType<typeof comment>[]>([["issue", [comment("issue", "root")]]]);
  const timelines = new Map<string, unknown[]>();
  const runs = new Map<string, Array<Record<string, unknown>>>();
  const documents = new Map<string, unknown>();
  const messages: Array<{ task_id: string; issue_id: string; seq: number; type: string; content: string }> = [];
  const requests: Array<{ method: string; path: string }> = [];
  const remote = { issueStatus: 200, timelineStatus: 200 };
  let clock = new Date(stamp);
  const http = createServer((request, response) => {
    requests.push({ method: request.method!, path: request.url! });
    const url = new URL(request.url!, "http://localhost");
    const [, , resource, id, nested] = url.pathname.split("/");
    response.setHeader("Content-Type", "application/json");
    let body: unknown;
    if (url.pathname === "/api/me") body = { id: "me", name: "Lin" };
    else if (url.pathname === "/api/workspaces") body = [{ id: "workspace", name: "Product", slug: "product" }];
    else if (url.pathname === "/api/agents") body = [{ id: "agent", name: "Builder" }];
    else if (url.pathname === "/api/issues") body = { issues, total: issues.length };
    else if (resource === "issues" && nested === "comments") body = comments.get(id) ?? [];
    else if (resource === "issues" && nested === "timeline") { response.statusCode = remote.timelineStatus; body = timelines.get(id) ?? []; }
    else if (resource === "issues" && nested === "task-runs") body = runs.get(id) ?? [];
    else if (resource === "tasks" && nested === "messages") body = messages.filter(message => message.task_id === id && (!url.searchParams.has("since") || message.seq > Number(url.searchParams.get("since"))));
    else if (resource === "issues" && !nested) { response.statusCode = remote.issueStatus; body = remote.issueStatus === 403 ? { error: "Issue forbidden" } : { id, workspace_id: "workspace", title: "Task", status: "todo" }; }
    else if (resource === "attachments") body = documents.get(id);
    else { response.statusCode = 404; body = {}; }
    response.end(JSON.stringify(body));
  });
  await new Promise<void>(resolve => http.listen(0, "127.0.0.1", resolve));
  cleanup.push(() => new Promise<void>(resolve => { http.close(() => resolve()); http.closeAllConnections(); }));
  await mkdir(join(home, ".multica"));
  await writeFile(join(home, ".multica/config.json"), JSON.stringify({ server_url: `http://127.0.0.1:${(http.address() as { port: number }).port}`, token: "synthetic" }));
  const agents: Agent[] = [];
  const workspaces: Array<{ id: string; cwd: string; projectId: string; archivedAt: string | null }> = [];
  const events: ProviderEvent[] = [];
  const registrationOrder: string[] = [];
  const wakes: string[] = [];
  const refreshes: string[] = [];
  const opened = new Set<string>();
  const registered = new Set<string>();
  const loading = new Map<string, Promise<void>>();
  const subagents = new Map<string, { id: string; parentAgentId: string; status: string; items: AgentTimelineItem[] }>();
  const wakeControl = { fail: new Set<string>(), before: undefined as (() => Promise<void>) | undefined, load: true };
  const nativeControl = { beforeRegister: undefined as (() => Promise<void>) | undefined, autoOpenImport: false, beforeFetchAgent: undefined as ((id: string) => Promise<void>) | undefined };
  const hostPlan: Array<{ serverId: string; commandError?: "throw" | "response" }> = [];
  const nativeConnections: Array<{ serverId: string; closed: boolean; closeCalls: number; commandAttempts: number }> = [];
  let server: FakeServer;
  let provider: ProviderConnection | undefined;
  async function connect() {
    if (!provider) {
      provider = await server.providers.get("multica")!.connect({ versions: [1], capabilities: ["session.persistence", "timeline.plugin", "permission", ...(subsessions ? ["session.subsession"] : [])] });
      provider.onEvent(event => {
        events.push(event); registrationOrder.push(event.type);
        if (event.type === "session.opened") {
          opened.add(event.sessionId);
          // A resumed parent has no provider history hydration. Native child
          // registration only sees live events after subscribeToSession.
          if (event.parentSessionId && registered.has(event.parentSessionId)) {
            const old = subagents.get(event.sessionId);
            subagents.set(event.sessionId, { id: event.sessionId, parentAgentId: event.parentSessionId, status: "running", items: old?.items ?? [] });
          }
        }
        if (event.type === "session.closed") opened.delete(event.sessionId);
        const child = "sessionId" in event ? subagents.get(event.sessionId) : undefined;
        if (!child) return;
        if (event.type === "session.turn") child.status = event.state === "started" ? "running" : event.state;
        if (event.type !== "timeline.item") return;
        const { id: _id, ...item } = event.item;
        const previous = child.items.at(-1);
        if (item.type === "assistant_message" && previous?.type === item.type && previous.messageId === item.messageId || item.type === "reasoning" && previous?.type === item.type) {
          (previous as { text: string }).text += item.text;
        } else child.items.push(item as AgentTimelineItem);
      });
    }
    return provider;
  }
  async function open(agent: Agent) {
    const pending = loading.get(agent.id); if (pending) return pending;
    if (opened.has(agent.id)) return;
    const operation = (async () => {
      await (await connect()).send({ type: "session.open", requestId: `open-${agent.id}`, sessionId: agent.id, history: "replay", persistence: JSON.parse(agent.handle.slice(7)),
        config: { cwd: agent.cwd, env: {}, mcpServers: {}, settings: {}, persist: true } });
      await nativeControl.beforeRegister?.();
      registered.add(agent.id); registrationOrder.push(`registered:${agent.id}`);
    })();
    loading.set(agent.id, operation);
    try { await operation; } finally { loading.delete(agent.id); }
  }
  const listCommands: NativeHost["listCommands"] = async input => {
    const id = typeof input === "string" ? input : input.agentId;
    wakes.push(id);
    await wakeControl.before?.();
    if (wakeControl.fail.has(id)) throw new Error("Native load unavailable");
    if (wakeControl.load) await open(agents.find(agent => agent.id === id)!);
    return { agentId: id, commands: [], error: null, requestId: "commands" };
  };
  const host = {
    listHosts: async () => ({ self: { serverId: "daemon" } }), listProjects: async () => ({ projects: [] }),
    addProject: async () => ({ project: { projectId: "project", projectKind: "non_git" } }), renameProject: async () => {}, removeProject: async () => {},
    fetchWorkspaces: async () => ({ entries: workspaces.filter(w => !w.archivedAt), pageInfo: { hasMore: false } }),
    createWorkspace: async (input: { workspaceId: string; source: { path: string; projectId: string } }) => {
      const workspace = { id: input.workspaceId, cwd: input.source.path, projectId: input.source.projectId, archivedAt: null }; workspaces.push(workspace); return { workspace };
    }, setWorkspaceTitle: async () => {},
    fetchAgents: async () => ({ entries: agents.map(agent => ({ agent: { provider: "multica", ...agent } })), pageInfo: { hasMore: false } }),
    importAgent: async (input: { workspaceId: string; cwd: string; labels: Record<string, string>; providerHandleId: string }) => {
      const agent = { id: `native-${agents.length}`, workspaceId: input.workspaceId, cwd: input.cwd, labels: input.labels, handle: input.providerHandleId, archivedAt: null, status: "idle", activeTurn: null };
      agents.push(agent); if (nativeControl.autoOpenImport) await open(agent); return agent;
    }, updateAgent: async () => {}, close: async () => {},
    fetchAgent: async (id: string) => { await nativeControl.beforeFetchAgent?.(id); return { agent: { provider: "multica", ...agents.find(agent => agent.id === id)! } }; },
    refreshAgent: async (id: string) => { refreshes.push(id); throw new Error("Wake must not refresh"); },
    archiveAgent: async (id: string) => { agents.find(agent => agent.id === id)!.archivedAt = stamp; },
    archiveWorkspace: async (id: string) => { workspaces.find(w => w.id === id)!.archivedAt = stamp; for (const agent of agents.filter(a => a.workspaceId === id)) agent.archivedAt = stamp; return {}; },
    restoreWorkspace: async () => {}, listCommands,
    listProviderSubagents: async (parentAgentId: string) => ({ parentAgentId, subagents: [...subagents.values()].filter(child => child.parentAgentId === parentAgentId), error: null }),
    fetchProviderSubagentTimeline: async (parentAgentId: string, subagentId: string) => ({ parentAgentId, subagentId, epoch: "epoch", rows: subagents.get(subagentId)!.items.map(item => ({ item })), hasOlder: false, hasNewer: false, error: null }),
    fetchAgentTimeline: async () => ({ agentId: "unused", epoch: "epoch", entries: [], hasOlder: false, hasNewer: false }),
  } as unknown as NativeHost;
  const paseo = { hosts: { list: async () => ({ self: { serverId: "daemon" } }) } } as unknown as PaseoApi;
  const start = () => {
    server = new FakeServer();
    const dispose = createServerContribution({ homeDirectory: home, workingDirectory: home, environment: { PASEO_HOME: home }, syncIntervalMs: 1_000_000, now: () => clock,
      connectHost: async () => {
        const plan = hostPlan.shift() ?? { serverId: "daemon" };
        const record = { serverId: plan.serverId, closed: false, closeCalls: 0, commandAttempts: 0 };
        nativeConnections.push(record);
        return { ...host,
          listHosts: async () => {
            if (record.closed) throw new Error("Disconnected native client");
            return { self: { serverId: record.serverId } };
          },
          listCommands: async input => {
            record.commandAttempts++;
            if (record.closed || plan.commandError === "throw") throw new Error("Disconnected native client");
            if (plan.commandError === "response") return { agentId: typeof input === "string" ? input : input.agentId, commands: [], error: "Native load failed", requestId: "commands" };
            return typeof input === "string" ? listCommands(input) : listCommands(input);
          },
          close: async () => { record.closed = true; record.closeCalls++; },
        } as NativeHost;
      } })(server.context);
    cleanup.push(dispose); return { server, dispose };
  };
  const started = start();
  cleanup.push(async () => { await provider?.close(); });
  await server!.syncRpc(workspaceEnable, { workspaceId: "workspace", enabled: true }, paseo);
  const thread = (root = "root", issueId = "issue") => agents.find(a => a.labels["multica.discussion"] === root && a.labels["multica.issue"] === issueId)!;
  const question = (root = "root", issueId = "issue", document: unknown = card) => {
    const source = comments.get(issueId)!.find(c => c.id === root)!; source.attachments = [attachment(root)]; documents.set(root, document);
  };
  return { ...started, start, connect, open, agents, workspaces, thread, question, events, registrationOrder, wakes, refreshes, requests, comments, timelines, runs, issues, documents, messages, subagents, remote, wakeControl, nativeControl, hostPlan, nativeConnections, paseo,
    setClock: (value: Date) => { clock = value; }, sync: () => resync(server, paseo, "workspace"),
    disconnect: async () => {
      await provider?.close(); provider = undefined; opened.clear(); registered.clear();
      for (const child of subagents.values()) if (child.status === "running") child.status = "failed";
    } };
}

it.each(["running", "completed", "failed", "cancelled"])("recovers main and Thread Run subagents after reload to %s without duplicate output or markers", async status => {
  const f = await fixture(true);
  for (const root of ["main", "root"]) {
    const agent = f.thread(root);
    await f.server.rpc(threadOpen, { connectionKey: agent.labels["multica.connection"], issueId: "issue", rootId: root }, f.paseo);
  }
  const runs = [
    { id: "main-run", issue_id: "issue", agent_id: "agent", status: "running" },
    { id: "thread-run", issue_id: "issue", agent_id: "agent", status: "running", trigger_comment_id: "root" },
  ];
  f.runs.set("issue", runs);
  for (const run of runs) f.messages.push({ task_id: run.id, issue_id: "issue", seq: 1, type: "text", content: "Before reload" });
  await f.sync();
  await expect.poll(() => f.subagents.size).toBe(2);
  for (const child of f.subagents.values()) expect(child.items.filter(row => row.type === "assistant_message")).toMatchObject([{ text: "Before reload" }]);
  await f.disconnect(); await f.dispose(); f.start();
  for (const child of f.subagents.values()) expect(child.status).toBe("failed");
  for (const run of runs) { run.status = status; f.messages.push({ task_id: run.id, issue_id: "issue", seq: 2, type: "text", content: " + after reload" }); }
  f.events.length = 0;
  let release!: () => void, reached!: () => void;
  const blocked = new Promise<void>(resolve => { release = resolve; }), entering = new Promise<void>(resolve => { reached = resolve; });
  f.nativeControl.beforeRegister = async () => { reached(); await blocked; };
  const syncing = f.sync(); await entering;
  expect(f.events.some(event => event.type === "session.ready")).toBe(true);
  expect(f.events.some(event => event.type === "session.opened" && event.parentSessionId)).toBe(false);
  expect(f.events.some(event => event.type === "session.turn")).toBe(false);
  release(); expect(await syncing).toEqual({ status: "ready" });
  await expect.poll(() => [...f.subagents.values()].map(child => child.status)).toEqual([status === "cancelled" ? "canceled" : status, status === "cancelled" ? "canceled" : status]);
  await expect.poll(() => [...f.subagents.values()].map(child => child.items.filter(row => row.type === "assistant_message").map(row => row.text).join(""))).toEqual(["Before reload + after reload", "Before reload + after reload"]);
  expect([...f.subagents.keys()]).toEqual(["multica:run:main-run", "multica:run:thread-run"]);
  expect(f.events.some(event => event.type === "timeline.item" && event.item.id.startsWith("multica:run-marker:"))).toBe(false);
  expect(f.refreshes).toEqual([]); expect(f.requests.filter(request => request.method !== "GET")).toEqual([]);
  expect(f.nativeConnections).toHaveLength(2); // One shared connection per plugin lifetime.
});

it("confirms native registration on a user-opened persisted Run owner and closes/reopens its stable child on the same connection", async () => {
  const f = await fixture(true), agent = f.thread();
  await f.server.rpc(threadOpen, { connectionKey: agent.labels["multica.connection"], issueId: "issue", rootId: "root" }, f.paseo);
  f.runs.set("issue", [{ id: "run", issue_id: "issue", agent_id: "agent", status: "running", trigger_comment_id: "root" }]);
  await f.sync(); await expect.poll(() => f.subagents.get("multica:run:run")?.status).toBe("running");
  await f.disconnect(); await f.dispose(); f.start(); f.wakes.length = 0; f.events.length = 0;
  expect(f.nativeConnections[0]).toMatchObject({ closed: true, closeCalls: 1 });
  await f.open(agent); // No background sync/wakeup has run in the new process.
  await expect.poll(() => f.subagents.get("multica:run:run")?.status).toBe("running");
  expect(f.wakes).toEqual([agent.id]);
  const provider = await f.connect();
  await provider.send({ type: "session.close", requestId: "child-close", sessionId: "multica:run:run" });
  expect(f.events).toContainEqual({ type: "session.closed", sessionId: "multica:run:run" });
  expect(f.events).toContainEqual({ type: "request.completed", requestId: "child-close" });
  const count = f.events.length; await f.sync();
  expect(f.events.slice(count).filter(event => event.type === "session.opened" && event.sessionId === "multica:run:run")).toHaveLength(1);
  expect(f.events.some(event => event.type === "timeline.item" && event.item.id.startsWith("multica:run-marker:"))).toBe(false);
  expect(f.requests.filter(request => request.method !== "GET")).toEqual([]);
  expect(f.nativeConnections).toHaveLength(2);
});

it("does not learn the owning identity from a pre-bootstrap listener and reconnects after discarding the wrong daemon", async () => {
  const f = await fixture(true), agent = f.thread();
  await f.server.rpc(threadOpen, { connectionKey: agent.labels["multica.connection"], issueId: "issue", rootId: "root" }, f.paseo);
  f.runs.set("issue", [{ id: "run", issue_id: "issue", agent_id: "agent", status: "running", trigger_comment_id: "root" }]);
  await f.sync(); await expect.poll(() => f.subagents.get("multica:run:run")?.status).toBe("running");
  await f.disconnect(); await f.dispose(); f.start();
  f.hostPlan.push({ serverId: "other-daemon" }, { serverId: "daemon" });
  await f.open(agent); // The listener is read before any authoritative PaseoApi call.
  await expect.poll(() => f.nativeConnections[1]?.commandAttempts).toBe(1);
  expect(f.nativeConnections[1]).toMatchObject({ serverId: "other-daemon", closed: false });
  // The authoritative identity must be established before validating this
  // cached listener, so a mismatch closes it instead of poisoning bootstrap.
  expect(await f.sync()).toEqual({ status: "unavailable" });
  expect(f.nativeConnections[1]).toMatchObject({ serverId: "other-daemon", closed: true, closeCalls: 1 });
  expect(await f.sync()).toEqual({ status: "ready" });
  expect(f.nativeConnections[2]).toMatchObject({ serverId: "daemon", closed: false });
  expect(f.nativeConnections).toHaveLength(3);
});

it.each(["throw", "response"] as const)("discards a failed listCommands %s connection and activates through a new shared client", async commandError => {
  const f = await fixture(true), agent = f.thread();
  await f.server.rpc(threadOpen, { connectionKey: agent.labels["multica.connection"], issueId: "issue", rootId: "root" }, f.paseo);
  f.runs.set("issue", [{ id: "run", issue_id: "issue", agent_id: "agent", status: "running", trigger_comment_id: "root" }]);
  await f.sync(); await expect.poll(() => f.subagents.get("multica:run:run")?.status).toBe("running");
  await f.disconnect(); await f.dispose(); f.start();
  f.hostPlan.push({ serverId: "daemon", commandError }, { serverId: "daemon" });
  await f.open(agent);
  await expect.poll(() => f.nativeConnections[1]?.closed).toBe(true);
  expect(f.nativeConnections[1]).toMatchObject({ closeCalls: 1, commandAttempts: 1 });
  expect(f.subagents.get("multica:run:run")?.status).toBe("failed");
  expect(await f.sync()).toEqual({ status: "ready" });
  await expect.poll(() => f.subagents.get("multica:run:run")?.status).toBe("running");
  expect(f.nativeConnections[2]).toMatchObject({ serverId: "daemon", closed: false, commandAttempts: 1 });
  expect(f.nativeConnections).toHaveLength(3);
});

it("announces a first unopened discovery only after native registration and listCommands completes", async () => {
  const f = await fixture();
  expect(f.events).toEqual([]); expect(f.wakes).toEqual([]);
  f.question();
  let release!: () => void; let reached!: () => void;
  const blocked = new Promise<void>(resolve => { release = resolve; });
  const opening = new Promise<void>(resolve => { reached = resolve; });
  f.nativeControl.beforeRegister = async () => { reached(); await blocked; };
  const syncing = f.sync(); await opening;
  const premature = f.events.filter(event => event.type === "session.permission");
  expect(f.events.some(event => event.type === "session.ready")).toBe(true);
  release(); expect(await syncing).toEqual({ status: "ready" });
  expect(premature).toEqual([]);
  expect(f.wakes).toEqual([f.thread().id]);
  expect(f.events).toContainEqual(expect.objectContaining({ type: "session.permission", sessionId: f.thread().id, request: expect.objectContaining({ kind: "question", title: card.title, description: card.description }) }));
  expect(f.events.filter(e => e.type === "session.opened").map(e => e.sessionId)).toEqual([f.thread().id]);
  const permissionIndex = f.events.findIndex(e => e.type === "session.permission");
  expect(permissionIndex).toBeGreaterThan(f.events.findIndex(e => e.type === "session.ready"));
  expect(f.registrationOrder.indexOf("session.permission")).toBeGreaterThan(f.registrationOrder.indexOf(`registered:${f.thread().id}`));
  // The fresh marker was consumed by that live projection. A new provider
  // connection restores it as opening history, even in the same process.
  await f.disconnect(); f.events.length = 0; await f.open(f.thread()); await f.sync();
  expect(f.events.filter(event => event.type === "session.permission")).toHaveLength(1);
  expect(f.events.findIndex(event => event.type === "session.permission")).toBeLessThan(f.events.findIndex(event => event.type === "session.ready"));
  expect(f.wakes).toEqual([f.thread().id]);
  expect(f.refreshes).toEqual([]);
  expect(f.requests.filter(r => r.method !== "GET")).toEqual([]);
});

it("keeps fresh auto-imported permissions deferred across post-ready publications until native loading acknowledges registration", async () => {
  const f = await fixture(); f.question(); await f.sync();
  const original = f.events.find((event): event is Extract<ProviderEvent, { type: "session.permission" }> => event.type === "session.permission")!;
  await (await f.connect()).send({ type: "session.permission", sessionId: f.thread().id, permissionId: original.request.id, response: { behavior: "deny" } });
  f.comments.get("issue")!.push(comment("issue", "fresh", [attachment("fresh")])); f.documents.set("fresh", card);
  f.nativeControl.autoOpenImport = true;
  let release!: () => void; let reached!: () => void;
  const blocked = new Promise<void>(resolve => { release = resolve; });
  const opening = new Promise<void>(resolve => { reached = resolve; });
  f.nativeControl.beforeRegister = async () => { reached(); await blocked; };
  const syncing = f.sync(); await opening;
  const freshId = f.thread("fresh").id;
  // Reopening another card publishes the entire Issue after the new provider
  // session is ready, while native import has deliberately not returned.
  const reopening = f.server.rpc(askuserReopen, { connectionKey: f.thread().labels["multica.connection"], issueId: "issue", commentId: "root", attachmentId: "root" }, f.paseo);
  let premature: ProviderEvent[] = [];
  try {
    await expect.poll(() => f.events.filter(event => event.type === "session.permission" && event.sessionId === f.thread().id)).toHaveLength(2);
    premature = f.events.filter(event => event.type === "session.permission" && event.sessionId === freshId);
  } finally { release(); }
  await Promise.all([syncing, reopening]); await f.sync();
  expect(premature).toEqual([]);
  expect(f.events.filter(event => event.type === "session.permission" && event.sessionId === freshId)).toHaveLength(1);
  expect(f.wakes).toEqual([f.thread().id, freshId]);
  expect(f.registrationOrder.lastIndexOf("session.permission")).toBeGreaterThan(f.registrationOrder.indexOf(`registered:${freshId}`));
  expect(f.requests.filter(request => request.method !== "GET")).toEqual([]);
});

it("replays cached pending questions quietly before ready on restart and after a new provider connection", async () => {
  const f = await fixture(); f.question(); await f.sync();
  await f.dispose(); await f.disconnect(); f.start(); f.events.length = 0;
  f.setClock(new Date("2026-11-24T10:10:00Z")); await f.sync(); await f.sync();
  const threadEvents = () => f.events.filter(event => "sessionId" in event && event.sessionId === f.thread().id);
  expect(threadEvents().filter(event => event.type === "session.permission")).toHaveLength(1);
  expect(threadEvents().findIndex(event => event.type === "session.permission")).toBeLessThan(threadEvents().findIndex(event => event.type === "session.ready"));
  await f.disconnect(); f.events.length = 0; await f.open(f.thread()); await f.sync();
  expect(threadEvents().filter(event => event.type === "session.permission")).toHaveLength(1);
  expect(threadEvents().findIndex(event => event.type === "session.permission")).toBeLessThan(threadEvents().findIndex(event => event.type === "session.ready"));
  expect(f.requests.filter(request => request.method !== "GET")).toEqual([]);
});

it("immediately re-expands a dismissed question after the native host evicts its idle session", async () => {
  const f = await fixture(); f.question(); await f.sync();
  const permission = f.events.find(e => e.type === "session.permission")!;
  if (permission.type !== "session.permission") throw new Error("Expected question");
  const provider = await f.connect();
  await provider.send({ type: "session.permission", sessionId: f.thread().id, permissionId: permission.request.id, response: { behavior: "deny", message: "Dismissed by user" } });
  await provider.send({ type: "session.close", requestId: "evict-idle", sessionId: f.thread().id });
  f.events.length = 0;
  await f.server.rpc(askuserReopen, { connectionKey: f.thread().labels["multica.connection"], issueId: "issue", commentId: "root", attachmentId: "root" }, f.paseo);
  expect(f.wakes).toEqual([f.thread().id, f.thread().id]);
  expect(f.events).toContainEqual(expect.objectContaining({ type: "session.permission", sessionId: f.thread().id, request: expect.objectContaining({ id: permission.request.id }) }));
  expect(f.refreshes).toEqual([]);
});

it("does not reopen a registered running Thread or change its aggregate turn while adding a native question", async () => {
  const f = await fixture();
  await f.open(f.thread());
  f.runs.set("issue", [{ id: "run", issue_id: "issue", agent_id: "agent", status: "running", trigger_comment_id: "root" }]);
  await f.sync();
  const started = f.events.filter(e => e.type === "session.turn");
  expect(started).toEqual([expect.objectContaining({ state: "started", sessionId: f.thread().id })]);
  // The first Run confirms native registration once through listCommands.
  expect(f.wakes).toEqual([f.thread().id]); f.wakes.length = 0;
  f.events.length = 0; f.question(); await f.sync(); await f.sync();
  expect(f.wakes).toEqual([]);
  expect(f.events.filter(e => e.type === "session.turn" || e.type === "session.closed")).toEqual([]);
  expect(f.events.filter(e => e.type === "session.permission")).toHaveLength(1);
  expect(f.refreshes).toEqual([]);
  expect(f.requests.filter(r => r.method !== "GET")).toEqual([]);
});

it("restores pending questions for an unloaded Thread that also owns a running remote Run", async () => {
  const f = await fixture(); f.question();
  f.runs.set("issue", [{ id: "run", issue_id: "issue", agent_id: "agent", status: "running", trigger_comment_id: "root" }]);
  await f.sync(); await f.sync();
  expect(f.wakes).toEqual([f.thread().id, f.thread().id]);
  expect(f.events.filter(e => e.type === "session.permission")).toHaveLength(1);
  expect(f.events.filter(e => e.type === "session.turn")).toEqual([expect.objectContaining({ state: "started", sessionId: f.thread().id })]);
  expect(f.refreshes).toEqual([]); expect(f.requests.filter(r => r.method !== "GET")).toEqual([]);
});

it("throttles unsuccessful loads per discussion while continuing other Threads and Issues", async () => {
  const f = await fixture();
  f.comments.get("issue")!.push(comment("issue", "second"));
  f.issues.push({ id: "other", workspace_id: "workspace", title: "Other", description: "Other", status: "todo" });
  f.comments.set("other", [comment("other", "third")]);
  await f.sync();
  f.question(); f.question("second"); f.question("third", "other");
  f.wakeControl.fail.add(f.thread().id);
  expect(await f.sync()).toEqual({ status: "ready" });
  expect(f.wakes).toEqual([f.thread().id, f.thread("second").id, f.thread("third", "other").id]);
  expect(f.events.filter(e => e.type === "session.permission").map(e => e.sessionId)).toEqual([f.thread("second").id, f.thread("third", "other").id]);
  await Promise.all([f.sync(), f.sync(), f.sync()]);
  f.setClock(new Date("2026-11-24T10:00:59Z")); await f.sync();
  expect(f.wakes).toHaveLength(3);
  f.wakeControl.fail.clear(); f.setClock(new Date("2026-11-24T10:01:00Z")); await f.sync(); await f.sync();
  expect(f.wakes).toEqual([f.thread().id, f.thread("second").id, f.thread("third", "other").id, f.thread().id]);
  expect(f.events.filter(e => e.type === "session.permission").map(e => e.sessionId)).toContain(f.thread().id);
});

it("starts the retry interval when native loading is attempted after a slow preflight", async () => {
  const f = await fixture(); f.question(); f.wakeControl.load = false;
  let release!: () => void;
  const suspended = new Promise<void>(resolve => { release = resolve; });
  let reached!: () => void;
  const checking = new Promise<void>(resolve => { reached = resolve; });
  f.nativeControl.beforeFetchAgent = async () => { reached(); await suspended; };
  const syncing = f.sync();
  await checking;
  f.setClock(new Date("2026-11-24T10:01:00Z")); release();
  await syncing; await f.sync();
  expect(f.wakes).toEqual([f.thread().id]);
});

it.each(["read-only", "answered", "skipped", "invalid", "timeline unavailable"])("does not wake a Thread with only %s cards", async state => {
  const f = await fixture();
  f.question("root", "issue", state === "read-only" ? { ...card, answer_user_id: "someone-else" } : state === "invalid" ? { ...card, version: "2" } : card);
  if (state === "answered") f.timelines.set("issue", [{ id: "answer", type: "comment", parent_id: "root", actor_type: "member", actor_id: "me", content: "**确认结果**\n\n1. **理由**：同意" }]);
  if (state === "skipped") f.timelines.set("issue", [{ id: "root", type: "comment", askuser_skipped_at: stamp, askuser_skipped_by: "me" }]);
  if (state === "timeline unavailable") f.remote.timelineStatus = 503;
  await f.sync(); await f.sync();
  expect(f.wakes).toEqual([]); expect(f.events.filter(e => e.type === "session.permission")).toEqual([]);
});

it.each(["tab hidden", "workspace hidden", "rule disabled", "filter exit", "attachment forbidden", "native archived", "native workspace archived"])("does not wake %s discussions", async state => {
  const f = await fixture();
  const thread = f.thread();
  if (state === "tab hidden") {
    await f.server.hook("agent.archive.after", { agent: { id: thread.id, provider: "multica", workspaceId: thread.workspaceId, cwd: thread.cwd, parentAgentId: null, title: "Thread" }, archivedAt: stamp }, f.paseo);
    thread.archivedAt = stamp;
  }
  if (state === "workspace hidden") {
    f.workspaces[0].archivedAt = stamp;
    await f.server.hook("workspace.archive.after", { workspace: { id: thread.workspaceId, cwd: thread.cwd, projectId: "project", name: "Task", archivedAt: stamp } }, f.paseo);
  }
  if (state === "rule disabled") await f.server.syncRpc(workspaceEnable, { workspaceId: "workspace", enabled: false }, f.paseo);
  if (state === "filter exit") { f.issues.length = 0; await f.server.syncRpc(workspaceRule, { workspaceId: "workspace", rule: { statusCategories: ["started"] } }, f.paseo); }
  if (state === "attachment forbidden") f.remote.issueStatus = 403;
  if (state === "native archived") thread.archivedAt = stamp;
  if (state === "native workspace archived") f.workspaces[0].archivedAt = stamp;
  f.question(); await f.sync(); await f.sync();
  expect(f.wakes).toEqual([]); expect(f.events.filter(e => e.type === "session.permission")).toEqual([]);
  expect(f.refreshes).toEqual([]);
});

it("keeps locally collapsed pending cards asleep after session eviction and daemon restart", async () => {
  const f = await fixture(); f.question(); await f.sync();
  const permission = f.events.find(e => e.type === "session.permission")!;
  if (permission.type !== "session.permission") throw new Error("Expected question");
  await (await f.connect()).send({ type: "session.permission", sessionId: f.thread().id, permissionId: permission.request.id, response: { behavior: "deny", message: "Dismissed by user" } });
  await f.dispose(); await f.disconnect(); f.start(); f.events.length = 0;
  f.setClock(new Date("2026-11-24T10:10:00Z")); await f.sync();
  expect(f.wakes).toEqual([f.thread().id]);
  expect(f.events.filter(e => e.type === "session.permission" || e.type === "session.opened")).toEqual([]);
});

it("rejects opening or re-expanding a question while native hidden-discussion reconciliation holds it", async () => {
  const f = await fixture(); f.wakeControl.load = false; f.question(); await f.sync();
  const thread = f.thread();
  const address = { connectionKey: thread.labels["multica.connection"], issueId: "issue" };
  await f.server.hook("agent.archive.after", { agent: { id: thread.id, provider: "multica", workspaceId: thread.workspaceId, cwd: thread.cwd, parentAgentId: null, title: "Thread" }, archivedAt: stamp }, f.paseo);
  thread.archivedAt = stamp;
  let release!: () => void;
  const suspended = new Promise<void>(resolve => { release = resolve; });
  let reached!: () => void;
  const holding = new Promise<void>(resolve => { reached = resolve; });
  f.nativeControl.beforeFetchAgent = async id => { if (id === thread.id) { reached(); await suspended; } };
  const restoring = f.server.rpc(hiddenRestore, address, f.paseo);
  await holding;
  try {
    await f.open(thread);
    expect(f.events).toContainEqual(expect.objectContaining({ type: "request.failed", error: expect.objectContaining({ code: "discussion_unavailable" }) }));
    await expect(f.server.rpc(askuserReopen, { ...address, commentId: "root", attachmentId: "root" }, f.paseo)).rejects.toThrow("归档");
    expect(f.wakes).toEqual([thread.id]);
    expect(f.events.filter(e => e.type === "session.permission" || e.type === "session.opened")).toEqual([]);
  } finally { release(); }
  expect(await restoring).toEqual({ status: "ready" });
});
