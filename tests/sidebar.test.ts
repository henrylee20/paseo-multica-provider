import { createServer } from "node:http";
import { createRequire } from "node:module";
import { mkdtemp, mkdir, writeFile, rm, stat, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import type { PaseoApi } from "@getpaseo/client";
import type { DaemonClient } from "@getpaseo/client/internal/daemon-client";
import type { ProviderEvent } from "@getpaseo/plugin/server/provider";
import { defineRpc } from "@getpaseo/plugin";
import { z } from "zod";
import { createServerContribution } from "../server/contribute.js";
import type { LocalState } from "../server/state.js";
import { FakeServer, resync } from "./support/fake-server.js";
import { metadataHost } from "./support/metadata-host.js";
import { hiddenList, hiddenRestore } from "../shared/hiding.js";

const bootstrap = defineRpc({ name: "sync.bootstrap", input: z.object({}), output: z.object({ status: z.string() }) });
const management = defineRpc({ name: "workspace.list", input: z.object({}), output: z.object({ workspaces: z.array(z.object({ id: z.string(), name: z.string(), enabled: z.boolean() })) }) });
const enable = defineRpc({ name: "workspace.enable", input: z.object({ workspaceId: z.string(), enabled: z.boolean() }), output: z.object({ status: z.string() }) });
const readDescription = defineRpc({ name: "description.read", input: z.object({ connectionKey: z.string(), issueId: z.string(), revision: z.string(), offset: z.number() }),
  output: z.object({ text: z.string(), nextOffset: z.number().nullable() }) });
const ruleRpc = defineRpc({ name: "workspace.rule", input: z.object({ workspaceId: z.string(), rule: z.object({
  statusCategories: z.array(z.string()), statuses: z.array(z.string()), assignees: z.array(z.object({ type: z.enum(["member", "agent", "squad"]), id: z.string() })),
  projectIds: z.array(z.string()), labelIds: z.array(z.string()),
}) }), output: z.object({ status: z.string() }) });
const catalogRpc = defineRpc({ name: "workspace.catalog", input: z.object({ workspaceId: z.string() }), output: z.object({
  assignees: z.array(z.object({ type: z.string(), id: z.string(), name: z.string() })),
  statuses: z.array(z.object({ key: z.string(), name: z.string(), category: z.string() })),
  projects: z.array(z.object({ id: z.string(), name: z.string() })), labels: z.array(z.object({ id: z.string(), name: z.string() })),
}) });
const cleanup: Array<() => void | Promise<void>> = [];
afterEach(async () => { for (const dispose of cleanup.splice(0).reverse()) await dispose(); });

async function fixture(syncIntervalMs = 15_000, homePrefix = "multica-sidebar-") {
  const home = await mkdtemp(join(tmpdir(), homePrefix));
  cleanup.push(() => rm(home, { recursive: true, force: true }));
  const requests: string[] = [];
  const issues = [
    { id: "issue-one", workspace_id: "remote-workspace", identifier: "PRD-1", title: "实现登录", description: "用户可以使用现有 CLI 登录。", assignee_type: "member", assignee_id: "user-42", project_id: "project-a", labels: [{ id: "red" }], status: "custom-ready", status_category: "unstarted", updated_at: "2026-11-24T12:00:00Z" },
    { id: "issue-two", workspace_id: "remote-workspace", identifier: "PRD-2", title: "修复同步", description: "保留任务身份。", assignee_type: "agent", assignee_id: "agent-owned", project_id: "project-a", labels: [{ id: "blue" }], status: "custom-review", status_category: "started", updated_at: "2026-11-24T12:00:00Z" },
  ];
  const scopes: Array<{ path: string; slug?: string }> = [];
  const workspaces = [{ id: "remote-workspace", name: "产品开发", slug: "product" }];
  const heldIssueReads: Array<() => void> = [];
  const remote = { holdIssueReads: false, disconnect: false, authStatus: 200, issueStatus: 200, invalidIssuePage: false, nextPageFails: false };
  const http = createServer((request, response) => {
    requests.push(request.url!);
    scopes.push({ path: request.url!, slug: request.headers["x-workspace-slug"] as string | undefined });
    response.setHeader("Content-Type", "application/json");
    const url = new URL(request.url!, "http://localhost");
    if (url.pathname === "/api/issues") {
      if (remote.disconnect) { response.destroy(); return; }
      response.statusCode = remote.nextPageFails && Number(url.searchParams.get("offset")) > 0 ? 503 : remote.issueStatus;
      const values = (key: string) => url.searchParams.get(key)?.split(",").filter(Boolean) ?? [];
      const found = issues.filter(issue => (!values("status_categories").length || values("status_categories").includes(issue.status_category)) &&
        (!values("statuses").length || values("statuses").includes(issue.status)) &&
        (!values("assignee_filters").length || values("assignee_filters").includes(`${issue.assignee_type}:${issue.assignee_id}`)) &&
        (!values("project_ids").length || values("project_ids").includes(issue.project_id)) &&
        (!values("label_ids").length || issue.labels.some(label => values("label_ids").includes(label.id))));
      const reply = () => response.end(JSON.stringify(remote.invalidIssuePage ? { issues: [] } : { issues: found.slice(Number(url.searchParams.get("offset")), Number(url.searchParams.get("offset")) + 1), total: found.length }));
      if (remote.holdIssueReads) heldIssueReads.push(reply); else reply();
      return;
    }
    if (url.pathname === "/api/me") response.statusCode = remote.authStatus;
    response.end(JSON.stringify(url.pathname === "/api/me" ? { id: "user-42", name: "Lin" }
      : (url.pathname.endsWith("/comments") || url.pathname.endsWith("/task-runs")) ? []
      : url.pathname.endsWith("/members") ? [{ id: "membership-row", user_id: "user-42", name: "Lin", email: "lin@example.test" }]
      : url.pathname === "/api/agents" ? [{ id: "agent-owned", name: "Builder", owner_id: "user-42" }]
      : url.pathname === "/api/squads" ? [{ id: "squad-owned", name: "Team", leader_id: "agent-owned" }]
      : url.pathname === "/api/projects" ? { projects: [{ id: "project-a", title: "客户端" }], total: 1 }
      : url.pathname === "/api/labels" ? { labels: [{ id: "red", name: "Red" }, { id: "blue", name: "Blue" }], total: 2 }
      : url.pathname === "/api/issue-statuses" ? { statuses: [{ key: "custom-ready", name: "待接手", category: "unstarted" }, { key: "custom-review", name: "待审核", category: "started" }], categories: [], total: 2 }
      : workspaces));
  });
  await new Promise<void>(resolve => http.listen(0, "127.0.0.1", resolve));
  cleanup.push(() => new Promise<void>(resolve => { http.close(() => resolve()); http.closeAllConnections(); }));
  type Socket = { send(data: string): void; close(): void; on(type: "message", callback: (data: { toString(): string }) => void): void };
  const { WebSocketServer } = createRequire(import.meta.url)("ws") as { WebSocketServer: new (options: { server: typeof http }) => {
    on(type: "connection", callback: (socket: Socket, request: { url?: string }) => void): void;
    clients: Set<Socket>; close(): void;
  } };
  const websocket = new WebSocketServer({ server: http });
  const websocketRequests: Array<{ url: string; auth?: unknown }> = [];
  websocket.on("connection", (socket, request) => {
    const entry = { url: request.url! } as { url: string; auth?: unknown };
    websocketRequests.push(entry);
    socket.on("message", data => { entry.auth = JSON.parse(data.toString()); socket.send(JSON.stringify({ type: "auth_ack", payload: {} })); });
  });
  cleanup.push(() => { for (const socket of websocket.clients) socket.close(); websocket.close(); });
  const signal = (type: string, payload = {}) => { for (const socket of websocket.clients) socket.send(JSON.stringify({ type, payload })); };
  const address = http.address() as { port: number };
  await mkdir(join(home, ".multica"));
  await writeFile(join(home, ".multica", "config.json"), JSON.stringify({ server_url: `http://127.0.0.1:${address.port}`, token: "private-token" }));
  const native = { projects: [] as Array<{ projectId: string; cwd: string; name: string }>, workspaces: [] as Array<{ id: string; projectId: string; cwd: string; title: string; archived?: boolean }>, agents: [] as Array<{ id: string; workspaceId: string; cwd: string; labels: Record<string, string>; name?: string; handle: string; archivedAt?: string | null }>, workspacePageSize: 100 };
  let projectSequence = 0;
  const host = {
    listHosts: async () => ({ self: { serverId: "owning-daemon" } }),
    addProject: async (cwd: string) => {
      let project = native.projects.find(item => item.cwd === cwd);
      if (!project) { project = { projectId: projectSequence++ ? `native-project-${projectSequence}` : "native-project", cwd, name: "" }; native.projects.push(project); }
      return { project, error: null };
    },
    listProjects: async () => ({ projects: native.projects.map(project => ({ projectId: project.projectId, projectRootPath: project.cwd, projectKind: "non_git" })) }),
    removeProject: async (id: string) => {
      if (native.workspaces.some(workspace => workspace.projectId === id && !workspace.archived)) throw new Error("Project still has active workspaces");
      native.projects.splice(native.projects.findIndex(project => project.projectId === id), 1);
      return { removedWorkspaceIds: [] };
    },
    renameProject: async (id: string, name: string) => { native.projects.find(item => item.projectId === id)!.name = name; },
    // Match the native active directory: no archived field and idPrefix ignored.
    fetchWorkspaces: async (input?: { page?: { limit: number; cursor?: string } }) => {
      const active = native.workspaces.filter(workspace => !workspace.archived);
      const offset = Number(input?.page?.cursor ?? 0);
      const end = offset + Math.min(input?.page?.limit ?? 200, native.workspacePageSize);
      const hasMore = end < active.length;
      return { entries: active.slice(offset, end).map(({ archived: _archived, ...workspace }) => workspace), pageInfo: { hasMore, nextCursor: hasMore ? String(end) : null } };
    },
    createWorkspace: async (input: { source: { path: string; projectId: string }; workspaceId: string; title: string }) => {
      if (!input.source.projectId) throw new Error("Explicit parent project required");
      if (native.workspaces.some(workspace => workspace.id === input.workspaceId)) throw new Error("workspace_id_conflict");
      const workspace = { id: input.workspaceId, projectId: input.source.projectId, cwd: input.source.path, title: input.title };
      native.workspaces.push(workspace);
      return { workspace, error: null };
    },
    setWorkspaceTitle: async (id: string, title: string) => { native.workspaces.find(item => item.id === id)!.title = title; },
    fetchAgents: async () => ({ entries: native.agents.map(agent => ({ agent: { provider: "multica", ...agent } })), pageInfo: { hasMore: false, nextCursor: null } }),
    importAgent: async (input: { workspaceId: string; cwd: string; providerHandleId: string; labels: Record<string, string> }) => {
      const existing = native.agents.find(agent => agent.handle === input.providerHandleId);
      if (existing) {
        if (!existing.archivedAt) throw new Error("Provider session is already imported");
        Object.assign(existing, { workspaceId: input.workspaceId, archivedAt: null });
        return existing;
      }
      const agent = { id: `native-agent-${native.agents.length + 1}`, workspaceId: input.workspaceId, cwd: input.cwd, labels: input.labels, handle: input.providerHandleId };
      native.agents.push(agent); return agent;
    },
    updateAgent: async (id: string, updates: { name: string }) => { native.agents.find(item => item.id === id)!.name = updates.name; },
    archiveWorkspace: async (id: string) => {
      native.workspaces.find(item => item.id === id)!.archived = true;
      for (const agent of native.agents.filter(item => item.workspaceId === id)) agent.archivedAt = "2026-11-24T12:00:00Z";
      return { error: null };
    },
    restoreWorkspace: async (id: string) => {
      const workspace = native.workspaces.find(item => item.id === id)!;
      if (!native.projects.some(project => project.projectId === workspace.projectId)) throw new Error("Unknown project");
      if (!workspace.archived) throw new Error("This workspace is not archived, but it is unavailable from the host.");
      workspace.archived = false;
    },
    fetchAgent: async (id: string) => {
      const agent = native.agents.find(item => item.id === id);
      return agent ? { agent: { provider: "multica", status: "idle", persistence: { sessionId: agent.handle }, ...agent } } : null;
    },
    refreshAgent: async (id: string) => {
      const agent = native.agents.find(item => item.id === id)!;
      if (!agent.archivedAt) throw new Error("Refreshing a live agent would interrupt it");
      agent.archivedAt = null;
      return { agent };
    },
    close: async () => {},
  } as unknown as DaemonClient;
  function start() {
    const server = new FakeServer();
    const dispose = createServerContribution({ homeDirectory: home, workingDirectory: home, environment: { PASEO_HOME: home }, connectHost: async () => host, syncIntervalMs })(server.context);
    cleanup.push(dispose);
    return { server, dispose };
  }
  const { server, dispose } = start();
  const paseo = { hosts: { list: async () => ({ self: { serverId: "owning-daemon" } }) } } as unknown as PaseoApi;
  return { server, requests, paseo, native, home, issues, start, dispose, host, remote, heldIssueReads, websocket, websocketRequests, signal, scopes, workspaces };
}

it("client bootstrap leaves the native sidebar empty until a workspace rule is explicitly enabled", async () => {
  const f = await fixture();
  expect(await f.server.rpc(bootstrap, {}, f.paseo)).toMatchObject({ status: "ready" });
  expect(await f.server.rpc(management, {}, f.paseo)).toEqual({ workspaces: [{ id: "remote-workspace", name: "产品开发", enabled: false }] });
  expect(f.requests.some(path => path.startsWith("/api/issues"))).toBe(false);
  expect(f.websocketRequests).toEqual([]);
});

it("client bootstrap copies each discussion's task from agent labels into metadata for the composer's agent picker", async () => {
  const f = await fixture();
  await f.server.rpc(enable, { workspaceId: "remote-workspace", enabled: true }, f.paseo);
  const host = metadataHost(f.native.agents);
  const [first, second] = f.native.agents;
  const task = (agent: typeof first) => ({ agentId: agent.id, patch: { "multica.connection": agent.labels["multica.connection"], "multica.issue": agent.labels["multica.issue"] } });
  expect(await f.server.rpc(bootstrap, {}, host.paseo)).toEqual({ status: "ready" });
  await vi.waitFor(() => expect(host.writes).toEqual([task(first), task(second)]));
  // Only this connection's discussions are read, archived ones included; a matching copy is left alone.
  expect(host.listings).toEqual([{ labels: { "multica.connection": first.labels["multica.connection"] }, includeArchived: true }]);
  expect(await f.server.rpc(bootstrap, {}, host.paseo)).toEqual({ status: "ready" });
  await vi.waitFor(() => expect(host.listings).toHaveLength(2));
  expect(host.writes).toEqual([task(first), task(second)]);

});

it("the metadata copy follows directory pages, and a cursor that repeats stops it without failing bootstrap", async () => {
  const f = await fixture();
  await f.server.rpc(enable, { workspaceId: "remote-workspace", enabled: true }, f.paseo);
  const paged = metadataHost(f.native.agents, { pageSize: 1 });
  expect(await f.server.rpc(bootstrap, {}, paged.paseo)).toEqual({ status: "ready" });
  await vi.waitFor(() => expect(paged.writes).toHaveLength(2));
  expect(paged.listings).toHaveLength(2);
  const looping = metadataHost(f.native.agents, { pageSize: 1, repeatingCursor: true });
  expect(await f.server.rpc(bootstrap, {}, looping.paseo)).toEqual({ status: "ready" });
  await vi.waitFor(() => expect(looping.listings).toHaveLength(2));
  // The same cursor comes back, so the directory cannot be proven complete: nothing loops, and the
  // discussions after it wait for a readable directory.
  await new Promise(resolve => setTimeout(resolve, 20));
  expect(looping.writes).toHaveLength(1);
});

it("a host without agent metadata is read once, and bootstrap stays ready", async () => {
  const f = await fixture();
  await f.server.rpc(enable, { workspaceId: "remote-workspace", enabled: true }, f.paseo);
  const host = metadataHost(f.native.agents, { legacy: true });
  expect(await f.server.rpc(bootstrap, {}, host.paseo)).toEqual({ status: "ready" });
  await vi.waitFor(() => expect(host.attempts()).toBe(1));
  await new Promise(resolve => setTimeout(resolve, 20));
  expect(await f.server.rpc(bootstrap, {}, host.paseo)).toEqual({ status: "ready" });
  await new Promise(resolve => setTimeout(resolve, 20));
  expect(host.attempts()).toBe(1);
  expect(host.writes).toEqual([]);
});

it("a failed metadata copy leaves bootstrap ready and is retried; disposal waits for a copy in flight", async () => {
  const f = await fixture();
  await f.server.rpc(enable, { workspaceId: "remote-workspace", enabled: true }, f.paseo);
  const host = metadataHost(f.native.agents);
  host.control.failNextListing = true;
  expect(await f.server.rpc(bootstrap, {}, host.paseo)).toEqual({ status: "ready" });
  await vi.waitFor(() => expect(host.attempts()).toBe(1));
  await new Promise(resolve => setTimeout(resolve, 20));
  expect(host.writes).toEqual([]);
  expect(await f.server.rpc(bootstrap, {}, host.paseo)).toEqual({ status: "ready" });
  await vi.waitFor(() => expect(host.writes).toHaveLength(2));
  await f.dispose();
  // Bootstrap answers while the copy is still pending; shutdown does not overtake it.
  host.stored.clear();
  let release!: () => void;
  host.control.holdWrites = new Promise<void>(resolve => { release = resolve; });
  const restarted = f.start();
  expect(await restarted.server.rpc(bootstrap, {}, host.paseo)).toEqual({ status: "ready" });
  await vi.waitFor(() => expect(host.attempts()).toBe(3));
  let disposed = false;
  const disposing = Promise.resolve(restarted.dispose()).then(() => { disposed = true; });
  await new Promise(resolve => setTimeout(resolve, 20));
  expect(disposed).toBe(false);
  release();
  await disposing;
  expect(host.writes).toHaveLength(4);
});

it("disabling a rule removes its empty Project and reenabling preserves tasks, discussion IDs and directories", async () => {
  const f = await fixture();
  await f.server.rpc(enable, { workspaceId: "remote-workspace", enabled: true }, f.paseo);
  const projectId = f.native.projects[0].projectId;
  const directories = f.native.workspaces.map(item => item.cwd);
  const agents = f.native.agents.map(item => item.id);
  await f.server.rpc(enable, { workspaceId: "remote-workspace", enabled: false }, f.paseo);
  expect(f.native.workspaces.every(item => item.archived)).toBe(true);
  expect(f.native.projects).toEqual([]);
  await f.server.rpc(enable, { workspaceId: "remote-workspace", enabled: true }, f.paseo);
  const active = f.native.workspaces.filter(item => !item.archived);
  expect(active.map(item => item.cwd)).toEqual(directories);
  expect(f.native.projects).toHaveLength(1);
  expect(f.native.projects[0].projectId).not.toBe(projectId);
  expect(active.every(item => item.projectId === f.native.projects[0].projectId)).toBe(true);
  expect(f.native.agents.every(item => !item.archivedAt)).toBe(true);
  expect(f.native.agents.map(item => item.id)).toEqual(agents);
  expect(f.native.agents.every(agent => active.some(workspace => workspace.id === agent.workspaceId))).toBe(true);
});

it("a failed rule archive remains retryable and reenable does not refresh a previously hidden main tab", async () => {
  const f = await fixture();
  await f.server.rpc(enable, { workspaceId: "remote-workspace", enabled: true }, f.paseo);
  f.native.agents[0].archivedAt = "already-hidden";
  const archive = f.host.archiveWorkspace.bind(f.host);
  f.host.archiveWorkspace = async () => { throw new Error("temporarily disconnected"); };
  expect(await f.server.rpc(enable, { workspaceId: "remote-workspace", enabled: false }, f.paseo)).toMatchObject({ status: "unavailable" });
  f.host.archiveWorkspace = archive;
  await resync(f.server, f.paseo, "remote-workspace");
  expect(f.native.workspaces.every(item => item.archived)).toBe(true);
  await f.server.rpc(enable, { workspaceId: "remote-workspace", enabled: true }, f.paseo);
  expect(f.native.agents[0].archivedAt).toBeTruthy();
  expect(f.native.agents[1].archivedAt).toBeNull();
});

it("rebuilt Projects retain manual hiding and restore the original discussion only when selected", async () => {
  const f = await fixture();
  await f.server.rpc(enable, { workspaceId: "remote-workspace", enabled: true }, f.paseo);
  const main = f.native.agents[0];
  main.archivedAt = "manual-hidden";
  await f.server.hook("agent.archive.after", { agent: { id: main.id, workspaceId: main.workspaceId, provider: "multica", cwd: main.cwd, title: "主讨论", parentAgentId: null }, archivedAt: main.archivedAt }, f.paseo);
  await f.server.rpc(enable, { workspaceId: "remote-workspace", enabled: false }, f.paseo);
  await f.server.rpc(enable, { workspaceId: "remote-workspace", enabled: true }, f.paseo);
  expect(main.archivedAt).toBeTruthy();
  const hidden = await f.server.rpc(hiddenList, {}, f.paseo);
  expect(hidden.objects).toHaveLength(1);
  expect(hidden.objects[0].agentId).toBe(main.id);
  expect(await f.server.rpc(hiddenRestore, { connectionKey: main.labels["multica.connection"], issueId: "issue-one", rootId: "main" }, f.paseo)).toEqual({ status: "ready" });
  expect(main.archivedAt).toBeNull();
  expect(f.native.agents).toHaveLength(2);
  expect(f.native.workspaces.find(workspace => workspace.id === main.workspaceId)?.projectId).toBe(f.native.projects[0].projectId);
});

it("rebuilding a disabled Project leaves manually hidden tasks archived until explicitly restored", async () => {
  const f = await fixture();
  await f.server.rpc(enable, { workspaceId: "remote-workspace", enabled: true }, f.paseo);
  const workspace = f.native.workspaces[0], main = f.native.agents[0];
  await f.host.archiveWorkspace(workspace.id);
  await f.server.hook("agent.archive.after", { agent: { id: main.id, workspaceId: main.workspaceId, provider: "multica", cwd: main.cwd, title: "主讨论", parentAgentId: null }, archivedAt: main.archivedAt! }, f.paseo);
  await f.server.hook("workspace.archive.after", { workspace: { id: workspace.id, projectId: workspace.projectId, cwd: workspace.cwd, name: workspace.title, archivedAt: "manual-hidden" } }, f.paseo);
  await f.server.rpc(enable, { workspaceId: "remote-workspace", enabled: false }, f.paseo);
  expect(f.native.projects).toEqual([]);
  await f.server.rpc(enable, { workspaceId: "remote-workspace", enabled: true }, f.paseo);
  expect(f.native.workspaces.filter(item => !item.archived)).toHaveLength(1);
  const address = { connectionKey: main.labels["multica.connection"], issueId: "issue-one" };
  expect(await f.server.rpc(hiddenRestore, address, f.paseo)).toEqual({ status: "ready" });
  expect(main.archivedAt).toBeTruthy();
  expect(await f.server.rpc(hiddenRestore, { ...address, rootId: "main" }, f.paseo)).toEqual({ status: "ready" });
  expect(main.archivedAt).toBeNull();
  expect(f.native.agents).toHaveLength(2);
});

it("a lost Project removal acknowledgement survives restart and rebuilding retries lost discussion imports", async () => {
  const f = await fixture();
  await f.server.rpc(enable, { workspaceId: "remote-workspace", enabled: true }, f.paseo);
  const original = f.native.agents.map(({ id, cwd, handle }) => ({ id, cwd, handle }));
  const remove = f.host.removeProject.bind(f.host);
  f.host.removeProject = async id => { await remove(id); throw new Error("Removal acknowledgement lost"); };
  expect(await f.server.rpc(enable, { workspaceId: "remote-workspace", enabled: false }, f.paseo)).toEqual({ status: "unavailable" });
  expect(f.native.projects).toEqual([]);
  await f.dispose();
  const restarted = f.start();
  expect(await resync(restarted.server, f.paseo, "remote-workspace")).toEqual({ status: "ready" });
  const importAgent = f.host.importAgent.bind(f.host);
  f.host.importAgent = async input => { await importAgent(input); throw new Error("Import acknowledgement lost"); };
  expect(await restarted.server.rpc(enable, { workspaceId: "remote-workspace", enabled: true }, f.paseo)).toEqual({ status: "unavailable" });
  f.host.importAgent = importAgent;
  expect(await resync(restarted.server, f.paseo, "remote-workspace")).toEqual({ status: "ready" });
  expect(f.native.agents.map(({ id, cwd, handle }) => ({ id, cwd, handle }))).toEqual(original);
  expect(f.native.agents.every(agent => !agent.archivedAt)).toBe(true);
  expect(f.native.projects).toHaveLength(1);
});

it("disabling an empty rule removes its Project, but retains Projects containing user workspaces on later pages", async () => {
  const f = await fixture();
  f.issues.length = 0;
  await f.server.rpc(enable, { workspaceId: "remote-workspace", enabled: true }, f.paseo);
  expect(f.native.projects).toHaveLength(1);
  expect(await f.server.rpc(enable, { workspaceId: "remote-workspace", enabled: false }, f.paseo)).toEqual({ status: "ready" });
  expect(f.native.projects).toEqual([]);
  await f.server.rpc(enable, { workspaceId: "remote-workspace", enabled: true }, f.paseo);
  const projectId = f.native.projects[0].projectId;
  f.native.workspacePageSize = 1;
  f.native.workspaces.push({ id: "unrelated", projectId: "unrelated-project", cwd: f.home, title: "Unrelated" },
    { id: "user-workspace", projectId, cwd: f.home, title: "User workspace" });
  expect(await f.server.rpc(enable, { workspaceId: "remote-workspace", enabled: false }, f.paseo)).toEqual({ status: "ready" });
  expect(f.native.projects[0].projectId).toBe(projectId);
  expect(f.native.workspaces.every(workspace => !workspace.archived)).toBe(true);
});

it("an incomplete native workspace directory cannot authorize removing a disabled Project", async () => {
  const f = await fixture();
  f.issues.length = 0;
  await f.server.rpc(enable, { workspaceId: "remote-workspace", enabled: true }, f.paseo);
  const fetch = f.host.fetchWorkspaces.bind(f.host);
  f.host.fetchWorkspaces = (async () => ({ entries: [], pageInfo: { hasMore: true, nextCursor: null } })) as unknown as DaemonClient["fetchWorkspaces"];
  expect(await f.server.rpc(enable, { workspaceId: "remote-workspace", enabled: false }, f.paseo)).toEqual({ status: "unavailable" });
  expect(f.native.projects).toHaveLength(1);
  f.host.fetchWorkspaces = fetch;
  expect(await resync(f.server, f.paseo, "remote-workspace")).toEqual({ status: "ready" });
  expect(f.native.projects).toEqual([]);
});

it("repeated bootstrap, title edits, token rotation and normal restart preserve native issue and tab identities", async () => {
  const f = await fixture();
  await f.server.rpc(enable, { workspaceId: "remote-workspace", enabled: true }, f.paseo);
  const workspaceIds = f.native.workspaces.map(item => item.id);
  const agentIds = f.native.agents.map(item => item.id);
  f.issues[0].title = "登录标题已修改";
  const configPath = join(f.home, ".multica", "config.json");
  const config = JSON.parse(await readFile(configPath, "utf8"));
  await writeFile(configPath, JSON.stringify({ ...config, token: "rotated-private-token" }));
  await Promise.all([resync(f.server, f.paseo, "remote-workspace"), resync(f.server, f.paseo, "remote-workspace")]);
  await f.dispose();
  const restarted = f.start();
  expect(await resync(restarted.server, f.paseo, "remote-workspace")).toMatchObject({ status: "ready" });
  expect(await restarted.server.rpc(management, {}, f.paseo)).toMatchObject({ workspaces: [{ id: "remote-workspace", enabled: true }] });
  expect(f.native.workspaces.map(item => item.id)).toEqual(workspaceIds);
  expect(f.native.agents.map(item => item.id)).toEqual(agentIds);
  expect(f.native.workspaces[0].title).toBe("PRD-1 登录标题已修改");
  expect(await readFile(join(f.home, "multica-provider", "state.json"), "utf8")).not.toContain("private-token");
});

it("new placeholder directories fit the host's flattened agent storage path and stay stable across restart", async () => {
  const f = await fixture(15_000, "multica-sidebar-runtime-daemon-");
  const importAgent = f.host.importAgent.bind(f.host);
  f.host.importAgent = async input => {
    if (!input.cwd) throw new Error("Explicit cwd required");
    // Paseo 0.15.3 AgentStorage uses the absolute Unix cwd, without its root,
    // with separators replaced by hyphens as one filesystem component.
    const storageComponent = input.cwd.slice(1).replaceAll("/", "-");
    expect(Buffer.byteLength(storageComponent)).toBeLessThanOrEqual(255);
    await mkdir(join(f.home, "agents", storageComponent), { recursive: true });
    return importAgent(input);
  };
  expect(await f.server.rpc(enable, { workspaceId: "remote-workspace", enabled: true }, f.paseo)).toMatchObject({ status: "ready" });
  expect(f.native.agents).toHaveLength(2);
  const projects = structuredClone(f.native.projects);
  const workspaces = structuredClone(f.native.workspaces);
  const agents = structuredClone(f.native.agents);
  await f.dispose();
  const restarted = f.start();
  expect(await resync(restarted.server, f.paseo, "remote-workspace")).toMatchObject({ status: "ready" });
  expect(f.native.projects).toEqual(projects);
  expect(f.native.workspaces).toEqual(workspaces);
  expect(f.native.agents).toEqual(agents);
});

it("restart preserves existing placeholder directories and the imported history bound to them", async () => {
  const f = await fixture();
  await f.server.rpc(enable, { workspaceId: "remote-workspace", enabled: true }, f.paseo);
  await f.dispose();
  const statePath = join(f.home, "multica-provider", "state.json");
  const persisted = JSON.parse(await readFile(statePath, "utf8")) as LocalState;
  const connectionKey = f.native.agents[0].labels["multica.connection"];
  const legacyProject = join(f.home, "multica-provider", "placeholders", "a".repeat(64), "b".repeat(64));
  // Seed the persisted/native boundary as an installation using the older
  // full-length directory format, with already imported agent history.
  persisted.connections[connectionKey].projects["remote-workspace"].cwd = legacyProject;
  f.native.projects[0].cwd = legacyProject;
  for (const [index, issue] of f.issues.entries()) {
    const cwd = join(legacyProject, (index === 0 ? "c" : "d").repeat(64));
    persisted.connections[connectionKey].issues[issue.id].cwd = cwd;
    f.native.workspaces[index].cwd = cwd;
    f.native.agents[index].cwd = cwd;
    await mkdir(cwd, { recursive: true });
  }
  await writeFile(statePath, JSON.stringify(persisted));
  const projects = structuredClone(f.native.projects);
  const workspaces = structuredClone(f.native.workspaces);
  const agents = structuredClone(f.native.agents);
  const restarted = f.start();
  expect(await resync(restarted.server, f.paseo, "remote-workspace")).toMatchObject({ status: "ready" });
  expect(f.native.projects).toEqual(projects);
  expect(f.native.workspaces).toEqual(workspaces);
  expect(f.native.agents).toEqual(agents);
  const provider = await restarted.server.providers.get("multica")!.connect({ versions: [1], capabilities: ["session.persistence"] });
  const events: ProviderEvent[] = [];
  provider.onEvent(event => events.push(event));
  await provider.send({ type: "session.open", requestId: "legacy-open", sessionId: "legacy-main", history: "replay",
    persistence: JSON.parse(agents[0].handle.slice("plugin:".length)),
    config: { cwd: agents[0].cwd, env: {}, mcpServers: {}, settings: {}, persist: true } });
  expect(events.at(-1)).toEqual({ type: "session.ready", requestId: "legacy-open", sessionId: "legacy-main" });
  await provider.close();
});

it("a lost native workspace creation response is reconciled on a later directory page after restart", async () => {
  const f = await fixture();
  const create = f.host.createWorkspace.bind(f.host);
  f.host.createWorkspace = async (...args) => { await create(...args); throw new Error("response lost"); };
  expect(await f.server.rpc(enable, { workspaceId: "remote-workspace", enabled: true }, f.paseo)).toMatchObject({ status: "unavailable" });
  expect(f.native.workspaces).toHaveLength(1);
  const original = { ...f.native.workspaces[0] };
  f.native.workspaces.unshift({ ...original, id: `${original.id}-similar` });
  f.native.workspacePageSize = 1;
  f.host.createWorkspace = create;
  await f.dispose();
  const restarted = f.start();
  expect(await resync(restarted.server, f.paseo, "remote-workspace")).toMatchObject({ status: "ready" });
  expect(f.native.workspaces).toHaveLength(3);
  expect(f.native.workspaces.filter(workspace => workspace.id === original.id)).toEqual([original]);
  expect(f.native.agents).toHaveLength(2);
  expect(f.native.agents[0].workspaceId).toBe(original.id);
  expect(f.native.agents[0].cwd).toBe(original.cwd);
});

it("a lost native import response is reconciled through stable labels without importing the active handle again", async () => {
  const f = await fixture();
  const importAgent = f.host.importAgent.bind(f.host);
  f.host.importAgent = async input => { await importAgent(input); throw new Error("response lost"); };
  expect(await f.server.rpc(enable, { workspaceId: "remote-workspace", enabled: true }, f.paseo)).toMatchObject({ status: "unavailable" });
  expect(f.native.agents).toHaveLength(1);
  f.host.importAgent = importAgent;
  const existing = f.native.agents[0];
  // Host filters can return other providers/workspaces. Match all stable
  // identity fields, even when the valid record is on a later page.
  f.host.fetchAgents = (async (input?: { page?: { cursor?: string } }) => ({ entries: [{ agent: { ...existing, provider: input?.page?.cursor === "valid" ? "multica" : "other", id: input?.page?.cursor === "valid" ? existing.id : "other-provider" } }],
    pageInfo: { hasMore: input?.page?.cursor !== "valid", nextCursor: input?.page?.cursor === "valid" ? null : "valid" } })) as unknown as DaemonClient["fetchAgents"];
  await f.dispose();
  const restarted = f.start();
  expect(await resync(restarted.server, f.paseo, "remote-workspace")).toMatchObject({ status: "ready" });
  expect(f.native.workspaces).toHaveLength(2);
  expect(f.native.agents).toHaveLength(2);
});

it("an incomplete native discussion directory with a cursor cycle never imports another handle", async () => {
  const f = await fixture();
  const seen: Array<string | undefined> = [];
  f.host.fetchAgents = (async (input?: { page?: { cursor?: string } }) => {
    const cursor = input?.page?.cursor;
    seen.push(cursor);
    if (seen.length > 3) throw new Error("Fixture rejected repeated cursor");
    return { entries: [], pageInfo: { hasMore: true, nextCursor: cursor === "first" ? "second" : "first" } };
  }) as unknown as DaemonClient["fetchAgents"];
  expect(await f.server.rpc(enable, { workspaceId: "remote-workspace", enabled: true }, f.paseo)).toMatchObject({ status: "unavailable" });
  expect(f.native.agents).toEqual([]);
  expect(seen).toEqual([undefined, "first", "second"]);
});

it("bootstrap rejects a different native daemon before creating sidebar records", async () => {
  const f = await fixture();
  f.host.listHosts = async () => ({ self: { serverId: "other-daemon" } }) as Awaited<ReturnType<DaemonClient["listHosts"]>>;
  expect(await f.server.rpc(enable, { workspaceId: "remote-workspace", enabled: true }, f.paseo)).toMatchObject({ status: "unavailable" });
  expect(f.native.projects).toEqual([]);
  expect(f.native.workspaces).toEqual([]);
  expect(f.native.agents).toEqual([]);
});

it("the daemon worker continues updating native task names without further client RPCs", async () => {
  const f = await fixture(30);
  await f.server.rpc(enable, { workspaceId: "remote-workspace", enabled: true }, f.paseo);
  f.issues[0].title = "后台已同步";
  await expect.poll(() => f.native.workspaces[0].title, { timeout: 2_000, interval: 20 }).toBe("PRD-1 后台已同步");
});

it("enabling the default rule pages custom-category issues into a native project, separate workspaces and main discussion tabs", async () => {
  const f = await fixture();
  expect(await f.server.rpc(enable, { workspaceId: "remote-workspace", enabled: true }, f.paseo)).toMatchObject({ status: "ready" });
  expect(f.native.projects).toMatchObject([{ name: "产品开发" }]);
  expect(f.native.workspaces.map(item => ({ projectId: item.projectId, title: item.title }))).toEqual([
    { projectId: "native-project", title: "PRD-1 实现登录" }, { projectId: "native-project", title: "PRD-2 修复同步" },
  ]);
  expect(f.native.agents.map(item => item.name)).toEqual(["主讨论", "主讨论"]);
  expect(new Set(f.native.workspaces.map(item => item.cwd)).size).toBe(2);
  for (const item of f.native.workspaces) {
    expect((await stat(item.cwd)).isDirectory()).toBe(true);
    await expect(stat(join(item.cwd, ".git"))).rejects.toMatchObject({ code: "ENOENT" });
  }
  const pages = f.requests.filter(path => path.startsWith("/api/issues?")).map(path => new URL(path, "http://localhost"));
  expect(pages.slice(0, 2).map(url => url.searchParams.get("offset"))).toEqual(["0", "1"]);
  expect(pages.every(url => url.searchParams.get("status_categories") === "unstarted,started" && !url.searchParams.has("open_only") && !url.searchParams.has("statuses"))).toBe(true);
});

it("the main discussion replays a stable task description row without participant messages or remote comments", async () => {
  const f = await fixture();
  await f.server.rpc(enable, { workspaceId: "remote-workspace", enabled: true }, f.paseo);
  const registration = f.server.providers.get("multica");
  expect(registration).toBeDefined();
  const connection = await registration!.connect({ versions: [1], capabilities: ["session.persistence", "session.list", "timeline.plugin"] });
  const events: ProviderEvent[] = [];
  connection.onEvent(event => events.push(event));
  const agent = f.native.agents[0];
  await connection.send({ type: "session.open", requestId: "open", sessionId: "main", history: "replay",
    persistence: JSON.parse(agent.handle.slice("plugin:".length)),
    config: { cwd: agent.cwd, env: {}, mcpServers: {}, settings: {}, persist: true } });
  expect(events).toContainEqual(expect.objectContaining({ type: "session.opened", description: "用户可以使用现有 CLI 登录。", title: "PRD-1 实现登录" }));
  expect(connection.capabilities).toContain("timeline.plugin");
  expect(events).toContainEqual(expect.objectContaining({ type: "timeline.item", item: expect.objectContaining({
    type: "plugin", pluginId: "multica", kind: "task-description", version: 1, id: "multica:description:issue-one",
    data: expect.objectContaining({ preview: "用户可以使用现有 CLI 登录。", truncated: false }),
  }) }));
  expect(events.some(event => event.type === "timeline.item" && (event.item.type === "assistant_message" || event.item.type === "user_message"))).toBe(false);
  expect(events.at(-1)).toEqual({ type: "session.ready", requestId: "open", sessionId: "main" });
  const beforeClose = f.requests.length;
  await connection.send({ type: "session.close", requestId: "close", sessionId: "main" });
  const firstRow = events.find(event => event.type === "timeline.item" && event.item.type === "plugin" && event.item.kind === "task-description");
  events.length = 0;
  await connection.send({ type: "session.open", requestId: "reopen", sessionId: "restored-main", history: "replay",
    persistence: JSON.parse(agent.handle.slice("plugin:".length)),
    config: { cwd: agent.cwd, env: {}, mcpServers: {}, settings: {}, persist: true } });
  expect(events.find(event => event.type === "timeline.item" && event.item.type === "plugin" && event.item.kind === "task-description")).toEqual({ ...firstRow, sessionId: "restored-main" });
  await connection.send({ type: "session.close", requestId: "close-restored", sessionId: "restored-main" });
  events.length = 0;
  await connection.send({ type: "session.open", requestId: "skip", sessionId: "existing-history", history: "skip",
    persistence: JSON.parse(agent.handle.slice("plugin:".length)),
    config: { cwd: agent.cwd, env: {}, mcpServers: {}, settings: {}, persist: true } });
  expect(events.some(event => event.type === "timeline.item" && event.item.type === "plugin" && event.item.kind === "task-description")).toBe(false);
  expect(events).toContainEqual(expect.objectContaining({ type: "timeline.item", item: expect.objectContaining({ type: "plugin", kind: "thread", data: expect.objectContaining({ rootId: "main" }) }) }));
  await connection.close();
  expect(f.requests).toHaveLength(beforeClose);
});

it("a large task description stays within the row limit and its cached full text remains readable after CLI logout", async () => {
  const f = await fixture();
  const description = `${"中文😀\n\\\"".repeat(15_000)}最终段落，不能截断。`;
  f.issues[0].description = description;
  await f.server.rpc(enable, { workspaceId: "remote-workspace", enabled: true }, f.paseo);
  const provider = await f.server.providers.get("multica")!.connect({ versions: [1], capabilities: ["session.persistence", "timeline.plugin"] });
  const events: ProviderEvent[] = [];
  provider.onEvent(event => events.push(event));
  const agent = f.native.agents[0];
  await provider.send({ type: "session.open", requestId: "large", sessionId: "large-main", history: "replay",
    persistence: JSON.parse(agent.handle.slice("plugin:".length)),
    config: { cwd: agent.cwd, env: {}, mcpServers: {}, settings: {}, persist: true } });
  await provider.close();
  const row = events.find(event => event.type === "timeline.item" && event.item.type === "plugin");
  expect(row?.type).toBe("timeline.item");
  if (row?.type !== "timeline.item" || row.item.type !== "plugin") throw new Error("Task description row missing");
  expect(Buffer.byteLength(JSON.stringify(row.item))).toBeLessThan(64 * 1024);
  expect(row.item.data).toMatchObject({ truncated: true });
  const data = z.object({ connectionKey: z.string(), issueId: z.string(), revision: z.string(), preview: z.string() }).parse(row.item.data);
  expect(data.preview.length).toBeLessThan(description.length);
  await f.dispose();
  const reader = f.start();
  const configPath = join(f.home, ".multica", "config.json");
  const cliConfig = await readFile(configPath, "utf8");
  await rm(configPath);
  const requestsBeforeRead = f.requests.length;
  let offset: number | null = 0;
  let full = "";
  let pages = 0;
  while (offset !== null) {
    const page: { text: string; nextOffset: number | null } = await reader.server.rpc(readDescription,
      { connectionKey: data.connectionKey, issueId: data.issueId, revision: data.revision, offset }, f.paseo);
    expect(Buffer.byteLength(JSON.stringify(page))).toBeLessThan(64 * 1024);
    full += page.text;
    offset = page.nextOffset;
    pages++;
  }
  expect(pages).toBeGreaterThan(1);
  expect(full).toBe(description);
  expect(f.requests).toHaveLength(requestsBeforeRead);
  await expect(reader.server.rpc(readDescription, { ...data, connectionKey: "another-user", offset: 0 }, f.paseo)).rejects.toThrow();
  await writeFile(configPath, cliConfig);
  f.issues[0].description = "任务描述已更新";
  await resync(reader.server, f.paseo, "remote-workspace");
  await expect(reader.server.rpc(readDescription, { ...data, offset: 0 }, f.paseo)).rejects.toThrow();
});

it("typed multi-value filters intersect fields and keep directly assigned members distinct from owned agents", async () => {
  const f = await fixture();
  const catalogs = await f.server.rpc(catalogRpc, { workspaceId: "remote-workspace" }, f.paseo);
  expect(catalogs.assignees).toEqual([
    { type: "member", id: "user-42", name: "Lin" }, { type: "agent", id: "agent-owned", name: "Builder" }, { type: "squad", id: "squad-owned", name: "Team" },
  ]);
  expect(catalogs.projects).toEqual([{ id: "project-a", name: "客户端" }]);
  const catalogPaths = ["/api/workspaces/remote-workspace/members", "/api/agents?workspace_id=remote-workspace&include_archived=true", "/api/squads", "/api/projects?include_archived=true", "/api/labels?resource_type=issue", "/api/issue-statuses?include_archived=true"];
  expect(f.scopes.filter(item => catalogPaths.includes(item.path))).toHaveLength(6);
  expect(f.scopes.filter(item => catalogPaths.includes(item.path)).every(item => item.slug === "product")).toBe(true);
  await f.server.rpc(enable, { workspaceId: "remote-workspace", enabled: true }, f.paseo);
  const rule: z.input<typeof ruleRpc.input>["rule"] = { statusCategories: ["unstarted", "started"], statuses: ["custom-ready", "custom-review"],
    assignees: [{ type: "member" as const, id: "user-42" }, { type: "squad" as const, id: "squad-owned" }], projectIds: ["project-a"], labelIds: ["red", "blue"] };
  expect(await f.server.rpc(ruleRpc, { workspaceId: "remote-workspace", rule }, f.paseo)).toEqual({ status: "ready" });
  expect(f.native.workspaces.map(item => !!item.archived)).toEqual([false, true]);
  const query = new URL(f.requests.filter(path => path.startsWith("/api/issues?")).at(-1)!, "http://localhost").searchParams;
  expect(Object.fromEntries(query)).toEqual({ limit: "100", offset: "0", status_categories: "unstarted,started", statuses: "custom-ready,custom-review", assignee_filters: "member:user-42,squad:squad-owned", project_ids: "project-a", label_ids: "red,blue" });
  rule.assignees = [{ type: "agent", id: "agent-owned" }];
  await f.server.rpc(ruleRpc, { workspaceId: "remote-workspace", rule }, f.paseo);
  expect(f.native.workspaces.map(item => !!item.archived)).toEqual([true, false]);
  const managementRules = defineRpc({ name: "workspace.list", input: z.object({}), output: z.object({ workspaces: z.array(z.object({ id: z.string(), rule: ruleRpc.input.shape.rule })) }) });
  expect((await f.server.rpc(managementRules, {}, f.paseo)).workspaces[0].rule).toEqual(rule);
  await f.dispose();
  const restart = f.start();
  await resync(restart.server, f.paseo, "remote-workspace");
  expect(f.native.workspaces).toHaveLength(2);
  expect(f.native.workspaces.map(item => !!item.archived)).toEqual([true, false]);
});


it("workspace events discover new matching issues and restore every automatically archived tab on reentry", async () => {
  const f = await fixture(60_000);
  await f.server.rpc(enable, { workspaceId: "remote-workspace", enabled: true }, f.paseo);
  await expect.poll(() => f.websocketRequests[0], { timeout: 2_000 }).toEqual({ url: "/ws?workspace_slug=product", auth: { type: "auth", payload: { token: "private-token" } } });
  const first = f.native.workspaces[0];
  const main = f.native.agents[0];
  f.native.agents.push({ ...main, id: "thread-tab", labels: { ...main.labels, "multica.discussion": "thread-a" } });
  f.native.agents.push({ ...main, id: "previously-hidden", archivedAt: "manual-hidden" });
  f.issues.push({ ...f.issues[1], id: "issue-new", identifier: "PRD-3", title: "新匹配" });
  f.signal("issue:created", { issue: f.issues.at(-1) });
  await expect.poll(() => f.native.workspaces.length, { timeout: 2_000 }).toBe(3);
  f.issues[0].status_category = "done";
  f.issues[0].status = "done";
  f.signal("issue_status:changed", { issue_id: "issue-one" });
  await expect.poll(() => first.archived, { timeout: 2_000 }).toBe(true);
  const state = JSON.parse(await readFile(join(f.home, "multica-provider", "state.json"), "utf8"));
  expect(Object.values(state.connections).map((value) => (value as { issues: Record<string, { archiveReason: string }> }).issues["issue-one"].archiveReason)).toEqual(["filter_exit"]);
  f.issues[0].status_category = "started";
  f.signal("issue:updated", { issue: f.issues[0] });
  await expect.poll(() => first.archived, { timeout: 2_000 }).toBe(false);
  expect(f.native.agents.find(item => item.id === main.id)?.archivedAt).toBeNull();
  expect(f.native.agents.find(item => item.id === "thread-tab")?.archivedAt).toBeNull();
  expect(f.native.agents.find(item => item.id === "previously-hidden")?.archivedAt).toBeTruthy();
  expect(f.native.workspaces.filter(item => item.id === first.id)).toHaveLength(1);
  expect(f.native.agents.filter(item => item.id === main.id)).toHaveLength(1);
  await f.server.rpc(enable, { workspaceId: "remote-workspace", enabled: false }, f.paseo);
  await expect.poll(() => f.websocket.clients.size, { timeout: 2_000 }).toBe(0);
});


it("failed or incomplete snapshots retain cached native workspaces and only an authoritative empty result archives them", async () => {
  const f = await fixture(60_000);
  await f.server.rpc(enable, { workspaceId: "remote-workspace", enabled: true }, f.paseo);
  const identities = f.native.workspaces.map(item => item.id);
  for (const failure of ["authentication", "network", "transport", "schema", "pagination"]) {
    f.remote.issueStatus = failure === "authentication" ? 401 : failure === "network" ? 503 : 200;
    f.remote.disconnect = failure === "transport";
    f.remote.invalidIssuePage = failure === "schema";
    f.remote.nextPageFails = failure === "pagination";
    expect(await resync(f.server, f.paseo, "remote-workspace")).toMatchObject({ status: "unavailable" });
    expect(f.native.workspaces.every(item => !item.archived)).toBe(true);
    expect(f.native.workspaces.map(item => item.id)).toEqual(identities);
  }
  f.remote.nextPageFails = false;
  for (const issue of f.issues) issue.status_category = "closed";
  expect(await resync(f.server, f.paseo, "remote-workspace")).toEqual({ status: "ready" });
  expect(f.native.workspaces.every(item => item.archived)).toBe(true);
  for (const workspace of f.native.workspaces) expect((await stat(workspace.cwd)).isDirectory()).toBe(true);
  expect(f.native.workspaces.map(item => item.id)).toEqual(identities);
});

it("reconnecting an enabled workspace resnapshots missed changes without subscribing to disabled workspaces", async () => {
  const f = await fixture(60_000);
  f.workspaces.push({ id: "disabled-workspace", name: "未启用", slug: "disabled" });
  await f.server.rpc(enable, { workspaceId: "remote-workspace", enabled: true }, f.paseo);
  await expect.poll(() => f.websocketRequests.length, { timeout: 2_000 }).toBe(1);
  for (const socket of f.websocket.clients) socket.close();
  f.issues[0].status_category = "done";
  await expect.poll(() => f.websocketRequests.length, { timeout: 3_000 }).toBe(2);
  await expect.poll(() => f.native.workspaces[0].archived, { timeout: 2_000 }).toBe(true);
  expect(f.websocketRequests.every(request => request.url === "/ws?workspace_slug=product")).toBe(true);
});


it("explicit exact terminal and custom statuses are selectable without default category exclusions", async () => {
  const f = await fixture(60_000);
  f.issues[1].status = "custom-complete";
  f.issues[1].status_category = "done";
  await f.server.rpc(enable, { workspaceId: "remote-workspace", enabled: true }, f.paseo);
  expect(f.native.workspaces.map(item => item.title)).toEqual(["PRD-1 实现登录"]);
  await f.server.rpc(ruleRpc, { workspaceId: "remote-workspace", rule: { statusCategories: [], statuses: ["done", "custom-complete"], assignees: [], projectIds: [], labelIds: [] } }, f.paseo);
  expect(f.native.workspaces.map(item => [item.title, !!item.archived])).toEqual([["PRD-1 实现登录", true], ["PRD-2 修复同步", false]]);
  const query = new URL(f.requests.filter(path => path.startsWith("/api/issues?")).at(-1)!, "http://localhost").searchParams;
  expect(query.has("status_categories")).toBe(false);
  expect(query.get("statuses")).toBe("done,custom-complete");
});


it("a lost automatic archive response survives restart and restores the tabs captured before archive", async () => {
  const f = await fixture(60_000);
  await f.server.rpc(enable, { workspaceId: "remote-workspace", enabled: true }, f.paseo);
  const archive = f.host.archiveWorkspace.bind(f.host);
  f.host.archiveWorkspace = async (...args) => { await archive(...args); throw new Error("archive acknowledgement lost"); };
  expect(await f.server.rpc(enable, { workspaceId: "remote-workspace", enabled: false }, f.paseo)).toEqual({ status: "unavailable" });
  expect(f.native.workspaces[0].archived).toBe(true);
  await f.dispose();
  f.host.archiveWorkspace = archive;
  const restarted = f.start();
  expect(await resync(restarted.server, f.paseo, "remote-workspace")).toEqual({ status: "ready" });
  await restarted.server.rpc(enable, { workspaceId: "remote-workspace", enabled: true }, f.paseo);
  expect(f.native.workspaces.filter(item => !item.archived)).toHaveLength(2);
  expect(f.native.agents.every(item => !item.archivedAt)).toBe(true);
});

it("retries a lost automatic workspace restore acknowledgement after restart without refreshing active tabs", async () => {
  const f = await fixture(60_000);
  await f.server.rpc(enable, { workspaceId: "remote-workspace", enabled: true }, f.paseo);
  const original = f.native.agents.map(agent => ({ id: agent.id, cwd: agent.cwd, handle: agent.handle }));
  // A user-created workspace retains this Project, so recovery uses restore.
  f.native.workspaces.push({ id: "user-workspace", projectId: f.native.projects[0].projectId, cwd: f.home, title: "User workspace" });
  await f.server.rpc(enable, { workspaceId: "remote-workspace", enabled: false }, f.paseo);
  const restore = f.host.restoreWorkspace.bind(f.host);
  f.host.restoreWorkspace = async id => { await restore(id); throw new Error("workspace restore acknowledgement lost"); };
  expect(await f.server.rpc(enable, { workspaceId: "remote-workspace", enabled: true }, f.paseo)).toEqual({ status: "unavailable" });
  expect(f.native.workspaces[0].archived).toBe(false);
  expect(f.native.agents[0].archivedAt).toBeTruthy();
  await f.dispose();
  f.host.restoreWorkspace = restore;
  const restarted = f.start();
  expect(await resync(restarted.server, f.paseo, "remote-workspace")).toEqual({ status: "ready" });
  expect(f.native.workspaces.every(item => !item.archived)).toBe(true);
  expect(f.native.agents.every(item => !item.archivedAt)).toBe(true);
  expect(f.native.agents.map(agent => ({ id: agent.id, cwd: agent.cwd, handle: agent.handle }))).toEqual(original);
  expect(await resync(restarted.server, f.paseo, "remote-workspace")).toEqual({ status: "ready" });
});


it("a restarted daemon keeps one retry worker after the connecting client leaves during an offline bootstrap", async () => {
  const f = await fixture(1000);
  await f.server.rpc(enable, { workspaceId: "remote-workspace", enabled: true }, f.paseo);
  const originalIds = f.native.agents.map(agent => agent.id);
  await f.dispose();
  f.remote.authStatus = 503;
  vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
  try {
    const restarted = f.start();
    expect(await restarted.server.rpc(bootstrap, {}, f.paseo)).toMatchObject({ status: "unavailable" });
    // No further client RPC or management page is needed after this connection.
    f.remote.authStatus = 200;
    f.issues.push({ ...f.issues[0], id: "issue-after-client-close", title: "Recovered in background" });
    await vi.advanceTimersByTimeAsync(1000);
    await expect.poll(() => f.native.agents.length).toBe(3);
    expect(f.native.agents.slice(0, 2).map(agent => agent.id)).toEqual(originalIds);
    await restarted.dispose();
  } finally { vi.useRealTimers(); }
});

it("shares truthful sync progress and retains cached task identity through failed reads and recovery", async () => {
  const status = defineRpc({ name: "sync.status", input: z.object({}), output: z.object({ status: z.string(), stage: z.string(), lastSuccessAt: z.string().optional(), completedWorkspaces: z.number(), enabledWorkspaces: z.number() }) });
  const f = await fixture();
  await f.server.rpc(enable, { workspaceId: "remote-workspace", enabled: true }, f.paseo);
  const ready = await f.server.rpc(status, {}, f.paseo);
  expect(ready).toMatchObject({ status: "ready", stage: "idle", completedWorkspaces: 1, enabledWorkspaces: 1, lastSuccessAt: expect.any(String) });
  const ids = f.native.agents.map(agent => agent.id);
  f.remote.invalidIssuePage = true;
  expect(await resync(f.server, f.paseo, "remote-workspace")).toMatchObject({ status: "unavailable" });
  expect(await f.server.rpc(status, {}, f.paseo)).toMatchObject({ status: "unavailable", stage: "issues", lastSuccessAt: ready.lastSuccessAt });
  expect(f.native.agents.map(agent => agent.id)).toEqual(ids);
  expect(f.native.workspaces.every(workspace => !workspace.archived)).toBe(true);
  f.remote.invalidIssuePage = false;
  await Promise.all([resync(f.server, f.paseo, "remote-workspace"), resync(f.server, f.paseo, "remote-workspace")]);
  expect(await f.server.rpc(status, {}, f.paseo)).toMatchObject({ status: "ready", completedWorkspaces: 1 });
});

it("updates the opened main discussion's stable description from cached observation without losing version guards offline", async () => {
  const f = await fixture();
  await f.server.rpc(enable, { workspaceId: "remote-workspace", enabled: true }, f.paseo);
  const agent = f.native.agents[0];
  const address = JSON.parse(agent.handle.slice(7)).data;
  const provider = await f.server.providers.get("multica")!.connect({ versions: [1], capabilities: [] });
  cleanup.push(() => provider.close());
  const events: ProviderEvent[] = [];
  provider.onEvent(event => events.push(event));
  await provider.send({ type: "session.open", requestId: "open", sessionId: "opened-main", history: "replay", persistence: JSON.parse(agent.handle.slice(7)), config: { cwd: agent.cwd, env: {}, mcpServers: {}, settings: {}, persist: true } });
  const descriptions = () => events.flatMap(event => event.type === "timeline.item" && event.item.type === "plugin" && event.item.kind === "task-description" ? [event.item.data as { revision: string; preview: string }] : []);
  const old = descriptions().at(-1)!;
  f.issues[0].description = "新的任务目标。";
  await resync(f.server, f.paseo, "remote-workspace");
  expect(events.filter(event => event.type === "timeline.item" && event.item.type === "plugin" && event.item.kind === "task-description").at(-1)).toMatchObject({ item: { id: "multica:description:issue-one", data: { preview: "新的任务目标。" } } });
  f.remote.authStatus = 503;
  const current = descriptions().at(-1)!;
  expect(current).toMatchObject({ preview: "新的任务目标。" });
  expect(await f.server.rpc(readDescription, { ...address, revision: current.revision, offset: 0 }, f.paseo)).toEqual({ text: "新的任务目标。", nextOffset: null });
  await expect(f.server.rpc(readDescription, { ...address, revision: old.revision, offset: 0 }, f.paseo)).rejects.toThrow("changed");
});


it("coalesces multiple reconnecting clients and periodic opportunities into one effective sync pass with visible progress", async () => {
  const status = defineRpc({ name: "sync.status", input: z.object({}), output: z.object({ status: z.string(), stage: z.string(), enabledWorkspaces: z.number() }) });
  const f = await fixture(1000);
  await f.server.rpc(enable, { workspaceId: "remote-workspace", enabled: true }, f.paseo);
  await new Promise(resolve => setTimeout(resolve, 70));
  vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
  try {
    // The worker already exists; its new contribution is created with a controlled clock.
    await f.dispose();
    const restarted = f.start();
    const before = f.requests.length;
    f.remote.holdIssueReads = true;
    const clients = Promise.all([restarted.server.rpc(bootstrap, {}, f.paseo), restarted.server.rpc(bootstrap, {}, { ...f.paseo } as PaseoApi), restarted.server.rpc(bootstrap, {}, f.paseo)]);
    await expect.poll(() => f.heldIssueReads.length).toBe(1);
    expect(await restarted.server.rpc(status, {}, f.paseo)).toMatchObject({ status: "syncing", stage: "issues", enabledWorkspaces: 1 });
    await vi.advanceTimersByTimeAsync(30_000);
    expect(f.requests.slice(before).filter(path => path.startsWith("/api/issues?"))).toHaveLength(1);
    f.remote.holdIssueReads = false;
    for (const reply of f.heldIssueReads.splice(0)) reply();
    await clients;
    expect(f.native.agents).toHaveLength(2);
    await restarted.dispose();
  } finally { vi.useRealTimers(); }
});

it("keeps cached tasks and reports incomplete recovery when an enabled workspace is absent from the accessible snapshot", async () => {
  const f = await fixture();
  await f.server.rpc(enable, { workspaceId: "remote-workspace", enabled: true }, f.paseo);
  const ids = f.native.agents.map(agent => agent.id);
  f.workspaces.splice(0);
  expect(await resync(f.server, f.paseo, "remote-workspace")).toMatchObject({ status: "unavailable" });
  expect(f.native.agents.map(agent => agent.id)).toEqual(ids);
  expect(f.native.workspaces.every(workspace => !workspace.archived)).toBe(true);
});

it("repeated successful bootstrap checks the daemon without requesting another remote snapshot", async () => {
  const f = await fixture(60_000);
  await f.server.rpc(enable, { workspaceId: "remote-workspace", enabled: true }, f.paseo);
  await new Promise(resolve => setTimeout(resolve, 70));
  const before = f.requests.length;
  await Promise.all([f.server.rpc(bootstrap, {}, f.paseo), f.server.rpc(bootstrap, {}, f.paseo)]);
  expect(f.requests).toHaveLength(before);
});
