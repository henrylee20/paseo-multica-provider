import { createServer } from "node:http";
import { createRequire } from "node:module";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { defineRpc } from "@getpaseo/plugin";
import type { PaseoApi } from "@getpaseo/client";
import type { DaemonClient } from "@getpaseo/client/internal/daemon-client";
import type { ProviderConnection, ProviderEvent } from "@getpaseo/plugin/server/provider";
import { z } from "zod";
import { createServerContribution } from "../server/contribute.js";
import { syncBootstrap, workspaceEnable } from "../shared/contracts.js";
import { FakeServer, resync } from "./support/fake-server.js";

const hiddenList = defineRpc({ name: "hidden.list", input: z.object({}), output: z.object({ objects: z.array(z.object({
  connectionKey: z.string(), issueId: z.string(), workspaceId: z.string(), title: z.string(), cwd: z.string(),
  kind: z.enum(["workspace", "main", "thread"]), rootId: z.string().optional(), agentId: z.string().optional(),
})) }) });
const hiddenRestore = defineRpc({ name: "hidden.restore", input: z.object({ connectionKey: z.string(), issueId: z.string(), rootId: z.string().optional() }),
  output: z.object({ status: z.enum(["ready", "unavailable"]), message: z.string().optional() }) });
const cleanup: Array<() => unknown | Promise<unknown>> = [];
afterEach(async () => { for (const dispose of cleanup.splice(0).reverse()) await dispose(); });

async function fixture() {
  const home = await mkdtemp(join(tmpdir(), "multica-hiding-"));
  cleanup.push(() => rm(home, { recursive: true, force: true }));
  const remote = { matching: true, roots: ["root"] };
  const requests: string[] = [];
  const http = createServer((request, response) => {
    requests.push(`${request.method} ${request.url}`);
    const path = new URL(request.url!, "http://localhost").pathname;
    const body = path === "/api/me" ? { id: "me", name: "Lin" }
      : path === "/api/workspaces" ? [{ id: "remote", name: "Product", slug: "product" }]
      : path === "/api/issues" ? { issues: remote.matching ? [{ id: "issue", workspace_id: "remote", title: "Task", description: "Original description", status: "todo" }] : [], total: remote.matching ? 1 : 0 }
      : path.endsWith("/comments") ? remote.roots.map(id => ({ id, parent_id: null, content: id, author_id: "me", author_type: "member", type: "comment", issue_id: "issue" })) : [];
    response.setHeader("Content-Type", "application/json"); response.end(JSON.stringify(body));
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
  const signal = (type: string) => { for (const socket of authenticated) socket.send(JSON.stringify({ type, payload: {} })); };
  const eventsReady = async () => { await expect.poll(() => authenticated.size, { timeout: 2000 }).toBeGreaterThan(0); signal("auth_ack"); };
  await mkdir(join(home, ".multica"));
  await writeFile(join(home, ".multica", "config.json"), JSON.stringify({ server_url: `http://127.0.0.1:${(http.address() as { port: number }).port}`, token: "synthetic" }));
  const paseo = { hosts: { list: async () => ({ self: { serverId: "owner" } }) } } as unknown as PaseoApi;
  type Agent = { id: string; workspaceId: string; cwd: string; labels: Record<string, string>; handle: string; archivedAt: string | null; name?: string };
  const native = { agents: [] as Agent[], workspaces: [] as Array<{ id: string; cwd: string; archivedAt: string | null }>, effects: [] as string[], workspacePageSize: 100 };
  let server: FakeServer;
  let provider: ProviderConnection;
  const providerEvents: ProviderEvent[] = [];
  const hookAgent = (agent: Agent) => ({ id: agent.id, workspaceId: agent.workspaceId, parentAgentId: null, provider: "multica", cwd: agent.cwd, title: agent.name ?? null });
  async function archiveAgent(agent: Agent) {
    if (agent.archivedAt) return;
    agent.archivedAt = new Date().toISOString();
    await server.hook("agent.archive.after", { agent: hookAgent(agent), archivedAt: agent.archivedAt }, paseo);
    await provider.send({ type: "session.close", requestId: `close-${agent.id}`, sessionId: agent.id });
    await server.hook("agent.close.after", { agent: hookAgent(agent) }, paseo);
  }
  async function archiveWorkspace(id: string) {
    for (const agent of native.agents.filter(agent => agent.workspaceId === id)) await archiveAgent(agent);
    const workspace = native.workspaces.find(workspace => workspace.id === id)!;
    workspace.archivedAt = new Date().toISOString();
    await server.hook("workspace.archive.after", { workspace: { ...workspace, projectId: "project", name: "Task" } }, paseo);
    native.effects.push(`archive:${id}`);
    return { error: null };
  }
  const host = {
    listHosts: async () => ({ self: { serverId: "owner" } }),
    listProjects: async () => ({ projects: [] }),
    addProject: async () => ({ project: { projectId: "project", projectKind: "non_git" } }), renameProject: async () => {},
    // The real directory lists only active workspaces, omits archivedAt, and
    // accepts idPrefix without filtering on it. Callers must match exact IDs.
    fetchWorkspaces: async (input?: { page?: { limit: number; cursor?: string } }) => {
      const active = native.workspaces.filter(workspace => !workspace.archivedAt);
      const offset = Number(input?.page?.cursor ?? 0);
      const end = offset + Math.min(input?.page?.limit ?? 200, native.workspacePageSize);
      const hasMore = end < active.length;
      return { entries: active.slice(offset, end).map(({ id, cwd }) => ({ id, cwd })), pageInfo: { hasMore, nextCursor: hasMore ? String(end) : null } };
    },
    createWorkspace: async (input: { workspaceId: string; source: { path: string } }) => {
      const workspace = { id: input.workspaceId, cwd: input.source.path, archivedAt: null }; native.workspaces.push(workspace); return { workspace };
    }, setWorkspaceTitle: async () => {},
    fetchAgents: async () => ({ entries: native.agents.map(agent => ({ agent: { provider: "multica", ...agent } })), pageInfo: { hasMore: false } }),
    importAgent: async (input: { cwd: string; workspaceId: string; labels: Record<string, string>; providerHandleId: string }) => {
      const agent = { id: `agent-${native.agents.length}`, cwd: input.cwd, workspaceId: input.workspaceId, labels: input.labels, handle: input.providerHandleId, archivedAt: null };
      native.agents.push(agent); native.effects.push(`import:${agent.id}`);
      return agent;
    },
    updateAgent: async (id: string, update: { name: string }) => Object.assign(native.agents.find(agent => agent.id === id)!, update),
    archiveWorkspace,
    restoreWorkspace: async (id: string) => {
      const workspace = native.workspaces.find(workspace => workspace.id === id)!;
      if (!workspace.archivedAt) throw new Error("This workspace is not archived, but it is unavailable from the host.");
      native.effects.push(`restore:${id}`); workspace.archivedAt = null;
    },
    fetchAgent: async (id: string) => ({ agent: native.agents.find(agent => agent.id === id) }),
    refreshAgent: async (id: string) => {
      const agent = native.agents.find(agent => agent.id === id)!;
      if (!agent.archivedAt) throw new Error("Live refresh interrupts native activity");
      if (native.workspaces.find(workspace => workspace.id === agent.workspaceId)!.archivedAt) throw new Error("Restore workspace first");
      native.effects.push(`refresh:${id}`); agent.archivedAt = null; return { agent };
    }, close: async () => {},
  } as unknown as DaemonClient;
  async function start() {
    server = new FakeServer();
    const dispose = createServerContribution({ homeDirectory: home, workingDirectory: home, environment: { PASEO_HOME: home }, connectHost: async () => host })(server.context);
    cleanup.push(dispose);
    provider = await server.providers.get("multica")!.connect({ versions: [1], capabilities: ["session.persistence", "session.archive", "session.unarchive"] });
    provider.onEvent(event => providerEvents.push(event));
    cleanup.push(() => provider.close());
    return { server, dispose };
  }
  const started = await start();
  await server!.rpc(workspaceEnable, { workspaceId: "remote", enabled: true }, paseo);
  return { ...started, start, paseo, native, remote, requests, host, archiveAgent, archiveWorkspace, provider: () => provider, providerEvents, eventsReady, signal };
}

it("keeps a manually closed Thread hidden through new discovery, filter reentry, shared clients and restart", async () => {
  const f = await fixture();
  await f.eventsReady();
  const thread = f.native.agents.find(agent => agent.labels["multica.discussion"] === "root")!;
  await f.archiveAgent(thread);
  f.remote.roots.push("new-root");
  f.signal("comment:created"); f.signal("comment:updated");
  await expect.poll(() => f.native.agents.length).toBe(3);
  await Promise.all([resync(f.server, f.paseo, "remote"), resync(f.server, f.paseo, "remote")]);
  f.remote.matching = false; await resync(f.server, f.paseo, "remote");
  f.remote.matching = true; await resync(f.server, f.paseo, "remote");
  await f.dispose(); const restarted = await f.start();
  await resync(restarted.server, f.paseo, "remote");
  const hidden = await restarted.server.rpc(hiddenList, {}, f.paseo);
  expect(hidden.objects).toEqual([expect.objectContaining({ kind: "thread", rootId: "root", agentId: thread.id, cwd: thread.cwd })]);
  expect(thread.archivedAt).toBeTruthy();
  expect(f.native.agents).toHaveLength(3);
  expect(f.requests.every(request => request.startsWith("GET "))).toBe(true);
});

it("keeps an archived workspace hidden and restores only explicitly selected original tabs after its workspace", async () => {
  const f = await fixture();
  const original = f.native.agents.map(agent => ({ id: agent.id, cwd: agent.cwd, handle: agent.handle }));
  const workspace = f.native.workspaces[0];
  await f.archiveWorkspace(workspace.id);
  f.remote.roots.push("new-root");
  await resync(f.server, f.paseo, "remote");
  expect(workspace.archivedAt).toBeTruthy();
  expect(f.native.agents).toHaveLength(2);
  const hidden = await f.server.rpc(hiddenList, {}, f.paseo);
  expect(hidden.objects.map(object => object.kind).sort()).toEqual(["main", "thread", "workspace"]);
  const selected = hidden.objects.find(object => object.kind === "thread")!;
  f.native.effects.length = 0;
  expect(await f.server.rpc(hiddenRestore, { connectionKey: selected.connectionKey, issueId: selected.issueId, rootId: selected.rootId }, f.paseo)).toEqual({ status: "ready" });
  expect(f.native.effects).toEqual([`restore:${workspace.id}`, `refresh:${selected.agentId}`]);
  expect(workspace.archivedAt).toBeNull();
  expect(f.native.agents[0].archivedAt).toBeTruthy();
  expect(f.native.agents[1].archivedAt).toBeNull();
  expect(f.native.agents.map(agent => ({ id: agent.id, cwd: agent.cwd, handle: agent.handle }))).toEqual(original);
  expect((await f.server.rpc(hiddenList, {}, f.paseo)).objects).toEqual([expect.objectContaining({ kind: "main" })]);
  expect(await f.server.rpc(hiddenRestore, { connectionKey: selected.connectionKey, issueId: selected.issueId, rootId: selected.rootId }, f.paseo)).toEqual({ status: "ready" });
  expect(f.native.effects).toEqual([`restore:${workspace.id}`, `refresh:${selected.agentId}`]);
  await resync(f.server, f.paseo, "remote");
  expect(f.native.agents).toHaveLength(3);
  expect(f.native.agents[0].archivedAt).toBeTruthy();
  expect(f.requests.every(request => request.startsWith("GET "))).toBe(true);
});

it("restores a manually hidden Thread in its active workspace after filter reentry", async () => {
  const f = await fixture();
  const original = f.native.agents.map(agent => ({ id: agent.id, cwd: agent.cwd, handle: agent.handle }));
  const thread = f.native.agents.find(agent => agent.labels["multica.discussion"] === "root")!;
  await f.archiveAgent(thread);
  f.remote.matching = false; await resync(f.server, f.paseo, "remote");
  f.remote.matching = true; await resync(f.server, f.paseo, "remote");
  expect(f.native.workspaces[0].archivedAt).toBeNull();
  expect(f.native.agents.find(agent => agent.labels["multica.discussion"] === "main")!.archivedAt).toBeNull();
  const hidden = (await f.server.rpc(hiddenList, {}, f.paseo)).objects[0];
  // The SDK ignores idPrefix; the original active workspace is on a later page.
  f.native.workspaces.unshift({ id: `${hidden.workspaceId}-similar`, cwd: hidden.cwd, archivedAt: null });
  f.native.workspacePageSize = 1;
  f.native.effects.length = 0;
  const requestsBeforeRestore = f.requests.length;
  expect(await f.server.rpc(hiddenRestore, { connectionKey: hidden.connectionKey, issueId: hidden.issueId, rootId: hidden.rootId }, f.paseo)).toEqual({ status: "ready" });
  expect(thread.archivedAt).toBeNull();
  expect((await f.server.rpc(hiddenList, {}, f.paseo)).objects).toEqual([]);
  expect(f.native.agents.map(agent => ({ id: agent.id, cwd: agent.cwd, handle: agent.handle }))).toEqual(original);
  expect(f.native.effects).toEqual([`refresh:${thread.id}`]);
  expect(f.requests).toHaveLength(requestsBeforeRestore);
});

it("keeps main-discussion hiding independent from session resource close and preserves replayed history", async () => {
  const f = await fixture();
  const main = f.native.agents.find(agent => agent.labels["multica.discussion"] === "main")!;
  const open = async (sessionId: string) => {
    const rows: ProviderEvent[] = [];
    const off = f.provider().onEvent(event => { if (event.type === "timeline.item" && event.sessionId === sessionId) rows.push(event); });
    await f.provider().send({ type: "session.open", requestId: `open-${sessionId}`, sessionId, history: "replay", persistence: JSON.parse(main.handle.slice(7)),
      config: { cwd: main.cwd, env: {}, mcpServers: {}, settings: {}, persist: true } });
    off(); return rows.map(event => event.type === "timeline.item" ? event.item : undefined);
  };
  const original = await open("before");
  await f.provider().send({ type: "session.close", requestId: "resource-close", sessionId: "before" });
  expect(await f.server.rpc(hiddenList, {}, f.paseo)).toEqual({ objects: [] });
  await f.archiveAgent(main);
  f.remote.roots.push("new-root");
  await resync(f.server, f.paseo, "remote");
  f.remote.matching = false; await resync(f.server, f.paseo, "remote");
  f.remote.matching = true; await resync(f.server, f.paseo, "remote");
  expect(main.archivedAt).toBeTruthy();
  expect(f.native.agents.filter(agent => !agent.archivedAt).map(agent => agent.labels["multica.discussion"])).toEqual(["root", "new-root"]);
  const hidden = (await f.server.rpc(hiddenList, {}, f.paseo)).objects[0];
  await f.server.rpc(hiddenRestore, { connectionKey: hidden.connectionKey, issueId: hidden.issueId, rootId: "main" }, f.paseo);
  expect(await open("after")).toEqual(original);
  expect(f.requests.every(request => request.startsWith("GET "))).toBe(true);
});

it("restores a workspace alone without refreshing its hidden tabs", async () => {
  const f = await fixture();
  await f.archiveWorkspace(f.native.workspaces[0].id);
  const workspace = (await f.server.rpc(hiddenList, {}, f.paseo)).objects.find(object => object.kind === "workspace")!;
  f.native.workspaces.push({ id: `${workspace.workspaceId}-similar`, cwd: workspace.cwd, archivedAt: null });
  f.native.effects.length = 0;
  await f.server.rpc(hiddenRestore, { connectionKey: workspace.connectionKey, issueId: workspace.issueId }, f.paseo);
  expect(f.native.effects).toEqual([`restore:${workspace.workspaceId}`]);
  expect(f.native.agents.every(agent => agent.archivedAt)).toBe(true);
  expect((await f.server.rpc(hiddenList, {}, f.paseo)).objects.map(object => object.kind).sort()).toEqual(["main", "thread"]);
});

it("retries a lost workspace restore acknowledgement without restoring the already active workspace again", async () => {
  const f = await fixture();
  const original = f.native.agents.map(agent => ({ id: agent.id, cwd: agent.cwd, handle: agent.handle }));
  await f.archiveWorkspace(f.native.workspaces[0].id);
  const hidden = (await f.server.rpc(hiddenList, {}, f.paseo)).objects.find(object => object.kind === "thread")!;
  const target = { connectionKey: hidden.connectionKey, issueId: hidden.issueId, rootId: hidden.rootId };
  const restore = f.host.restoreWorkspace.bind(f.host);
  f.host.restoreWorkspace = async id => { await restore(id); throw new Error("workspace restore acknowledgement lost"); };
  f.native.effects.length = 0;
  const requestsBeforeRestore = f.requests.length;
  expect(await f.server.rpc(hiddenRestore, target, f.paseo)).toMatchObject({ status: "unavailable" });
  expect(f.native.workspaces[0].archivedAt).toBeNull();
  expect(f.native.agents.every(agent => agent.archivedAt)).toBe(true);
  expect((await f.server.rpc(hiddenList, {}, f.paseo)).objects).toHaveLength(3);
  await f.dispose(); const restarted = await f.start();
  expect(await restarted.server.rpc(hiddenRestore, target, f.paseo)).toEqual({ status: "ready" });
  expect(f.native.effects).toEqual([`restore:${hidden.workspaceId}`, `refresh:${hidden.agentId}`]);
  expect((await restarted.server.rpc(hiddenList, {}, f.paseo)).objects).toEqual([expect.objectContaining({ kind: "main" })]);
  expect(f.native.agents.map(agent => ({ id: agent.id, cwd: agent.cwd, handle: agent.handle }))).toEqual(original);
  expect(f.requests).toHaveLength(requestsBeforeRestore);
});

it("retains hide intent after a lost restore acknowledgement and retries without refreshing the now live agent", async () => {
  const f = await fixture();
  const main = f.native.agents[0];
  await f.archiveAgent(main);
  const hidden = (await f.server.rpc(hiddenList, {}, f.paseo)).objects[0];
  const target = { connectionKey: hidden.connectionKey, issueId: hidden.issueId, rootId: "main" };
  const refresh = f.host.refreshAgent.bind(f.host);
  f.host.refreshAgent = async id => { await refresh(id); throw new Error("response lost"); };
  expect(await f.server.rpc(hiddenRestore, target, f.paseo)).toMatchObject({ status: "unavailable" });
  expect((await f.server.rpc(hiddenList, {}, f.paseo)).objects).toHaveLength(1);
  expect(main.archivedAt).toBeNull();
  await f.dispose(); const restarted = await f.start();
  expect((await restarted.server.rpc(hiddenList, {}, f.paseo)).objects).toHaveLength(1);
  expect(await restarted.server.rpc(hiddenRestore, target, f.paseo)).toEqual({ status: "ready" });
  expect(f.native.effects.filter(effect => effect === `refresh:${main.id}`)).toHaveLength(1);
  expect((await restarted.server.rpc(hiddenList, {}, f.paseo)).objects).toEqual([]);
});
