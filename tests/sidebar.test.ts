import { rebuildPreflight, rebuildStart, rebuildStatus } from "../shared/rebuild.js";
import { StateStore } from "../server/state.js";
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
import { SidebarSynchronizer } from "../server/sync.js";
import { RunSynchronizer } from "../server/runs.js";
import { WorkspaceEvents } from "../server/workspace-events.js";
import type { LocalState } from "../server/state.js";
import { FakeServer, resync, hiddenObjects, waitForSync } from "./support/fake-server.js";
import { metadataHost } from "./support/metadata-host.js";
import { multicaSettings, connectionStatus, taskRuleSchema, workspaceList, workspacePreview, workspaceRule, workspaceEnable } from "../shared/contracts.js";
import { hiddenRestore } from "../shared/hiding.js";

const bootstrap = defineRpc({ name: "sync.bootstrap", input: z.object({}), output: z.object({ status: z.string() }) });
const workspaces = defineRpc({ name: "workspace.list", input: z.object({}), output: z.object({ workspaces: z.array(z.object({ id: z.string(), name: z.string(), enabled: z.boolean() })) }) });
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

async function fixture(syncIntervalMs: number | null = 15_000, homePrefix = "multica-sidebar-", eventDebounceMs: number | null = 20) {
  const home = await mkdtemp(join(tmpdir(), homePrefix));
  cleanup.push(() => rm(home, { recursive: true, force: true }));
  const requests: string[] = [];
  const comments: Array<{ id: string; issue_id: string; content: string }> = [];
  const runs: Array<{ id: string; issue_id: string; agent_id: string; status: string; completed_at?: string; error?: string | null; failure_reason?: string | null; work_dir?: string | null }> = [];
  const runResponses = new Map<string, { status: number; body?: unknown }>();
  const catalogResponses = new Map<string, { status: number; body?: unknown }>();
  const effects: string[] = [];
  const creations: Array<{ workspaceId: string; idempotencyKey: string }> = [];
  const issues = [
    { id: "issue-one", workspace_id: "remote-workspace", identifier: "PRD-1", title: "实现登录", description: "用户可以使用现有 CLI 登录。", assignee_type: "member", assignee_id: "user-42", project_id: "project-a", labels: [{ id: "red" }], status: "custom-ready", status_category: "unstarted", updated_at: "2026-11-24T12:00:00Z" },
    { id: "issue-two", workspace_id: "remote-workspace", identifier: "PRD-2", title: "修复同步", description: "保留任务身份。", assignee_type: "agent", assignee_id: "agent-owned", project_id: "project-a", labels: [{ id: "blue" }], status: "custom-review", status_category: "started", updated_at: "2026-11-24T12:00:00Z" },
  ];
  const workspaceIssues = new Map([["product", issues]]);
  const scopes: Array<{ path: string; slug?: string }> = [];
  const workspaces = [{ id: "remote-workspace", name: "产品开发", slug: "product" }];
  const heldWorkspaceReads: Array<() => void> = [];
  const heldIssueReads: Array<(() => void) & { slug?: string }> = [];
  const heldRunReads: Array<() => void> = [];
  const remote = { acknowledgeEvents: true, workspacesStatus: 200, holdWorkspaceReads: false, holdIssueReads: false, holdIssueWorkspace: "", holdRunReads: false, disconnectRuns: false, disconnect: false, authStatus: 200, issueStatus: 200, invalidIssuePage: false, nextPageFails: false, failingWorkspace: "", emptyNextPage: false };
  const http = createServer((request, response) => {
    requests.push(request.url!);
    scopes.push({ path: request.url!, slug: request.headers["x-workspace-slug"] as string | undefined });
    response.setHeader("Content-Type", "application/json");
    const url = new URL(request.url!, "http://localhost");
    const catalog = catalogResponses.get(url.pathname);
    if (catalog) { response.statusCode = catalog.status; response.end(JSON.stringify(catalog.body ?? {})); return; }
    if (url.pathname === "/api/issues") {
      if (remote.disconnect) { response.destroy(); return; }
      response.statusCode = remote.nextPageFails && (!remote.failingWorkspace || remote.failingWorkspace === request.headers["x-workspace-slug"]) && Number(url.searchParams.get("offset")) > 0 ? 503 : remote.issueStatus;
      const values = (key: string) => url.searchParams.get(key)?.split(",").filter(Boolean) ?? [];
      const found = (workspaceIssues.get(request.headers["x-workspace-slug"] as string) ?? issues).filter(issue => (!values("status_categories").length || values("status_categories").includes(issue.status_category)) &&
        (!values("statuses").length || values("statuses").includes(issue.status)) &&
        (!values("assignee_filters").length || values("assignee_filters").includes(`${issue.assignee_type}:${issue.assignee_id}`)) &&
        (!values("project_ids").length || values("project_ids").includes(issue.project_id)) &&
        (!values("label_ids").length || issue.labels.some(label => values("label_ids").includes(label.id))));
      const reply = () => response.end(JSON.stringify(remote.invalidIssuePage ? { issues: [] } : { issues: remote.emptyNextPage && Number(url.searchParams.get("offset")) > 0 ? [] : found.slice(Number(url.searchParams.get("offset")), Number(url.searchParams.get("offset")) + 1), total: found.length }));
      if (remote.holdIssueReads && (!remote.holdIssueWorkspace || remote.holdIssueWorkspace === request.headers["x-workspace-slug"]))
        heldIssueReads.push(Object.assign(reply, { slug: request.headers["x-workspace-slug"] as string }));
      else reply();
      return;
    }
    if (url.pathname.endsWith("/task-runs")) {
      if (remote.disconnectRuns) { response.destroy(); return; }
      const issueId = decodeURIComponent(url.pathname.split("/")[3]);
      const reply = () => {
        const override = runResponses.get(issueId);
        response.statusCode = override?.status ?? 200;
        response.end(JSON.stringify(override && "body" in override ? override.body : runs.filter(run => run.issue_id === issueId)));
      };
      if (remote.holdRunReads) heldRunReads.push(reply); else reply();
      return;
    }
    if (url.pathname === "/api/workspaces") {
      response.statusCode = remote.workspacesStatus;
      const reply = () => response.end(JSON.stringify(workspaces));
      if (remote.holdWorkspaceReads) heldWorkspaceReads.push(reply); else reply();
      return;
    }
    if (url.pathname === "/api/me") response.statusCode = remote.authStatus;
    response.end(JSON.stringify(url.pathname === "/api/me" ? { id: "user-42", name: "Lin" }
      : url.pathname.endsWith("/comments") ? comments.filter(comment => comment.issue_id === decodeURIComponent(url.pathname.split("/")[3]))
        .map(comment => ({ parent_id: null, type: "comment", author_id: "user-42", author_type: "member", created_at: "2026-11-24T12:00:00Z", ...comment }))
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
  const socketSlugs = new WeakMap<Socket, string | null>();
  const websocketRequests: Array<{ url: string; auth?: unknown }> = [];
  websocket.on("connection", (socket, request) => {
    socketSlugs.set(socket, new URL(request.url!, "http://localhost").searchParams.get("workspace_slug"));
    const entry = { url: request.url! } as { url: string; auth?: unknown };
    websocketRequests.push(entry);
    socket.on("message", data => {
      entry.auth = JSON.parse(data.toString());
      if (remote.acknowledgeEvents) socket.send(JSON.stringify({ type: "auth_ack", payload: {} }));
    });
  });
  cleanup.push(() => { for (const socket of websocket.clients) socket.close(); websocket.close(); });
  const signal = (type: string, payload = {}, slug?: string) => { for (const socket of websocket.clients) if (!slug || socketSlugs.get(socket) === slug) socket.send(JSON.stringify({ type, payload })); };
  const address = http.address() as { port: number };
  await mkdir(join(home, ".multica"));
  await writeFile(join(home, ".multica", "config.json"), JSON.stringify({ server_url: `http://127.0.0.1:${address.port}`, token: "private-token" }));
  const native = { projects: [] as Array<{ projectId: string; cwd: string; name: string }>, workspaces: [] as Array<{ id: string; projectId: string; cwd: string; title: string; archived?: boolean; workspaceDirectory?: string }>, agents: [] as Array<{ id: string; workspaceId: string; cwd: string; labels: Record<string, string>; name?: string; handle: string; archivedAt?: string | null }>, workspacePageSize: 100 };
  let projectSequence = 0, agentSequence = 0;
  const host = {
    listHosts: async () => ({ self: { serverId: "owning-daemon" } }),
    addProject: async (cwd: string) => {
      let project = native.projects.find(item => item.cwd === cwd);
      if (!project) {
        project = { projectId: projectSequence++ ? `native-project-${projectSequence}` : "native-project", cwd, name: "" };
        native.projects.push(project);
      }
      return { project, error: null };
    },
    listProjects: async () => ({ projects: native.projects.map(project => ({ projectId: project.projectId, projectRootPath: project.cwd, projectKind: "non_git" })) }),
    removeProject: async (id: string) => {
      effects.push(`removeProject:${id}`);
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
    createWorkspace: async (input: { source: { path: string; projectId: string }; workspaceId: string; title: string; idempotencyKey: string }) => {
      creations.push({ workspaceId: input.workspaceId, idempotencyKey: input.idempotencyKey });
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
      const agent = { id: `native-agent-${++agentSequence}`, workspaceId: input.workspaceId, cwd: input.cwd, labels: input.labels, handle: input.providerHandleId };
      native.agents.push(agent); return agent;
    },
    updateAgent: async (id: string, updates: { name: string }) => { native.agents.find(item => item.id === id)!.name = updates.name; },
    deleteAgent: async (id: string) => { effects.push(`deleteAgent:${id}`); native.agents.splice(native.agents.findIndex(agent => agent.id === id), 1); },
    archiveAgent: async () => { throw new Error("Rebuild must never archiveAgent / interrupt"); },
    archiveWorkspace: async (id: string) => {
      effects.push(`archiveWorkspace:${id}`);
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
  const connectHost = vi.fn(async () => host);
  function start(values?: unknown) {
    const server = new FakeServer();
    if (values) server.setSettings(multicaSettings.id, values);
    const dispose = createServerContribution({ homeDirectory: home, workingDirectory: home, environment: { PASEO_HOME: home }, connectHost, syncIntervalMs: syncIntervalMs ?? undefined, eventDebounceMs: eventDebounceMs ?? undefined })(server.context);
    cleanup.push(dispose);
    return { server, dispose };
  }
  const { server, dispose } = start();
  const paseo = { hosts: { list: async () => ({ self: { serverId: "owning-daemon" } }) } } as unknown as PaseoApi;
  return { server, requests, paseo, native, home, issues, comments, start, dispose, host, connectHost, remote, heldWorkspaceReads, heldIssueReads, heldRunReads, runResponses, catalogResponses, websocket, websocketRequests, signal, scopes, workspaces, workspaceIssues, runs, effects, creations };
}

it("client bootstrap leaves the native sidebar empty until a workspace rule is explicitly enabled", async () => {
  const f = await fixture();
  expect(f.connectHost).not.toHaveBeenCalled();
  expect(await f.server.syncRpc(bootstrap, {}, f.paseo)).toMatchObject({ status: "ready" });
  expect(f.connectHost).toHaveBeenCalledTimes(1);
  expect((await f.server.rpc(connectionStatus, {}, f.paseo)).sync).toMatchObject({ status: "ready", lastSuccessAt: expect.any(String) });
  expect(await f.server.rpc(workspaces, {}, f.paseo)).toEqual({ workspaces: [{ id: "remote-workspace", name: "产品开发", enabled: false }] });
  expect(f.requests.some(path => path.startsWith("/api/issues"))).toBe(false);
  expect(f.websocketRequests).toEqual([]);
});

it("saves task overviews with snapshot-memoized member, agent, squad, project and status names and optional app links", async () => {
  const f = await fixture();
  const configPath = join(f.home, ".multica/config.json");
  await writeFile(configPath, JSON.stringify({ ...JSON.parse(await readFile(configPath, "utf8")), app_url: "https://multica.example/app/" }));
  Object.assign(f.issues[0], { priority: "high", due_date: "2027-01-02", labels: [{ id: "red", name: "界面", color: "red" }] });
  f.issues.push({ ...f.issues[0], id: "squad-one", assignee_type: "squad", assignee_id: "squad-owned" },
    { ...f.issues[0], id: "squad-two", assignee_type: "squad", assignee_id: "squad-owned" });
  expect(await f.server.syncRpc(enable, { workspaceId: "remote-workspace", enabled: true }, f.paseo)).toMatchObject({ status: "ready" });
  const read = async () => Object.values((await new StateStore(join(f.home, "multica-provider")).read()).connections)[0].issues;
  const issues = await read();
  expect(issues["issue-one"].overview).toEqual({ identifier: "PRD-1", statusKey: "custom-ready", statusName: "待接手", statusCategory: "unstarted",
    priority: "high", dueDate: "2027-01-02", assigneeType: "member", assigneeId: "user-42", assigneeName: "Lin",
    projectId: "project-a", projectName: "客户端", labels: ["界面"], url: "https://multica.example/app/product/issues/PRD-1" });
  expect(issues["issue-two"].overview).toMatchObject({ assigneeName: "Builder", statusName: "待审核" });
  expect(issues["squad-one"].overview).toMatchObject({ assigneeName: "Team" });
  f.requests.length = 0;
  await resync(f.server, f.paseo, "remote-workspace");
  const catalogs = ["/api/workspaces/remote-workspace/members", "/api/agents?workspace_id=remote-workspace&include_archived=true", "/api/squads", "/api/projects?include_archived=true", "/api/issue-statuses?include_archived=true"];
  for (const path of catalogs) expect(f.requests.filter(request => request === path), path).toHaveLength(1);
  Object.assign(f.issues[0], { identifier: undefined });
  await resync(f.server, f.paseo, "remote-workspace");
  expect((await read())["issue-one"].overview?.url).toBe("https://multica.example/app/product/issues/issue-one");
  await writeFile(configPath, JSON.stringify({ ...JSON.parse(await readFile(configPath, "utf8")), app_url: undefined }));
  await resync(f.server, f.paseo, "remote-workspace");
  expect((await read())["issue-one"].overview?.url).toBeUndefined();
});

it.each([
  ["identifier", 42, "identifier"], ["status", {}, "statusKey"], ["status_category", false, "statusCategory"],
  ["priority", "critical", "priority"], ["assignee_type", "unknown", "assigneeType"], ["assignee_id", [], "assigneeId"],
  ["project_id", 7, "projectId"], ["due_date", "2026-02-30", "dueDate"], ["labels", [{ name: 42 }], "labels"],
] as const)("treats malformed overview field %s as missing while synchronizing the task's other fields", async (field, invalid, stored) => {
  const f = await fixture();
  f.catalogResponses.set("/api/issues", { status: 200, body: { issues: [{ ...f.issues[0], priority: "low", labels: [{ name: "界面" }], [field]: invalid }], total: 1 } });
  expect(await f.server.syncRpc(enable, { workspaceId: "remote-workspace", enabled: true }, f.paseo)).toMatchObject({ status: "ready" });
  const saved = Object.values((await new StateStore(join(f.home, "multica-provider")).read()).connections)[0].issues["issue-one"];
  expect(saved.description).toBe(f.issues[0].description);
  expect(saved.overview?.[stored]).toBeUndefined();
  expect(saved.overview?.statusName).toBe(field === "status" ? "未开始" : "待接手");
  if (field !== "priority") expect(saved.overview?.priority).toBe("low");
});

it.each(["http", "malformed"])("retains same-object overview names after %s catalog failures without failing or rewriting an unchanged snapshot", async failure => {
  const f = await fixture();
  f.issues.push({ ...f.issues[0], id: "squad", assignee_type: "squad", assignee_id: "squad-owned" });
  await f.server.syncRpc(enable, { workspaceId: "remote-workspace", enabled: true }, f.paseo);
  const file = join(f.home, "multica-provider/state.json");
  const before = await stat(file);
  for (const path of ["/api/workspaces/remote-workspace/members", "/api/agents", "/api/squads", "/api/projects", "/api/issue-statuses"])
    f.catalogResponses.set(path, { status: failure === "http" ? 503 : 200, body: {} });
  expect(await resync(f.server, f.paseo, "remote-workspace")).toMatchObject({ status: "ready" });
  expect((await stat(file)).ino).toBe(before.ino);
  const read = async () => Object.values((await new StateStore(join(f.home, "multica-provider")).read()).connections)[0].issues;
  expect((await read())["issue-one"].overview).toMatchObject({ assigneeName: "Lin", projectName: "客户端", statusName: "待接手" });
  expect((await read())["issue-two"].overview?.assigneeName).toBe("Builder");
  expect((await read()).squad.overview?.assigneeName).toBe("Team");
  Object.assign(f.issues[0], { assignee_id: "other-user", project_id: "other-project", status: "other-status" });
  Object.assign(f.issues[1], { assignee_type: "member" });
  expect(await resync(f.server, f.paseo, "remote-workspace")).toMatchObject({ status: "ready" });
  const changed = (await read())["issue-one"].overview!;
  expect(changed.assigneeName).toBeUndefined(); expect(changed.projectName).toBeUndefined(); expect(changed.statusName).toBe("未开始");
  expect((await read())["issue-two"].overview?.assigneeName).toBeUndefined();
});

it.each(["", 42, null])("resolves empty or malformed status_name %s lazily, then falls back to category and key", async status_name => {
  const f = await fixture();
  const raw = { ...f.issues[0], status_name, assignee_type: null, assignee_id: null, project_id: null };
  f.catalogResponses.set("/api/issues", { status: 200, body: { issues: [raw], total: 1 } });
  await f.server.syncRpc(enable, { workspaceId: "remote-workspace", enabled: true }, f.paseo);
  const read = async () => Object.values((await new StateStore(join(f.home, "multica-provider")).read()).connections)[0].issues["issue-one"].overview!;
  expect((await read()).statusName).toBe("待接手");
  expect(f.requests.some(path => /\/api\/(agents|squads|projects)/.test(path))).toBe(false);
  f.catalogResponses.set("/api/issue-statuses", { status: 200, body: { statuses: [] } });
  for (const [category, name] of [["unstarted", "未开始"], ["started", "进行中"], ["done", "已完成"], ["closed", "已关闭"], ["future", "custom-ready"]]) {
    raw.status_category = category;
    await resync(f.server, f.paseo, "remote-workspace");
    expect((await read()).statusName).toBe(name);
  }
  Object.assign(raw, { status_name: "自定义名称" });
  f.requests.length = 0;
  await resync(f.server, f.paseo, "remote-workspace");
  expect((await read()).statusName).toBe("自定义名称");
  expect(f.requests.some(path => path.startsWith("/api/issue-statuses"))).toBe(false);
});

it("workspace preview counts all matched tasks against unarchived mappings without writing state or calling the native host", async () => {
  const f = await fixture(60_000);
  await f.server.syncRpc(enable, { workspaceId: "remote-workspace", enabled: true }, f.paseo);
  await f.dispose();
  const statePath = join(f.home, "multica-provider", "state.json");
  const state = JSON.parse(await readFile(statePath, "utf8")) as LocalState;
  const connectionKey = Object.keys(state.connections)[0], local = state.connections[connectionKey];
  local.issues["issue-two"].archiveReason = "filter_exit";
  local.issues["left-task"] = { ...local.issues["issue-one"], title: "保留的本地标题" };
  local.issues["other-workspace"] = { ...local.issues["issue-one"], remoteWorkspaceId: "other" };
  local.issues["archived-task"] = { ...local.issues["issue-one"], archiveReason: "inaccessible" };
  // Manual hiding and an unfinished native creation do not add an archiveReason.
  local.issues["left-task"].manualHidden = { workspace: true, discussions: ["main"] };
  local.issues["left-task"].workspaceCreated = false;
  await writeFile(statePath, JSON.stringify(state));
  f.issues.push({ ...f.issues[1], id: "new-task", title: "新任务" });
  const reader = f.start();
  f.connectHost.mockClear();
  const before = await readFile(statePath, "utf8"), native = JSON.stringify(f.native), requests = f.requests.length;
  const rule = taskRuleSchema.parse({});
  expect(await reader.server.rpc(workspacePreview, { workspaceId: "remote-workspace", connectionKey, rule }, f.paseo)).toEqual({
    total: 3, imported: 2, entering: 2, leaving: [{ id: "left-task", title: "保留的本地标题" }],
  });
  const previewReads = f.requests.slice(requests).filter(path => path.startsWith("/api/issues?"));
  expect(previewReads.filter(path => new URL(path, "http://fixture").searchParams.has("ids"))).toHaveLength(1);
  expect(previewReads.filter(path => !new URL(path, "http://fixture").searchParams.has("ids"))).toHaveLength(3);
  expect(f.scopes.filter(item => item.path.startsWith("/api/issues?")).every(item => item.slug === "product")).toBe(true);
  expect(await reader.server.rpc(workspacePreview, { workspaceId: "remote-workspace", connectionKey, rule: { ...rule, labelIds: ["blue"] } }, f.paseo)).toEqual({
    total: 2, imported: 2, entering: 2, leaving: [{ id: "issue-one", title: "PRD-1 实现登录" }, { id: "left-task", title: "保留的本地标题" }],
  });
  expect(await readFile(statePath, "utf8")).toBe(before);
  expect(JSON.stringify(f.native)).toBe(native);
  expect(f.connectHost).not.toHaveBeenCalled();
  expect((await reader.server.rpc(workspaceList, {}, f.paseo)).workspaces[0]).toMatchObject({ id: "remote-workspace", importedCount: 2 });
});

it("workspace preview rejects an old connection or missing workspace and preserves pagination and workspace guards", async () => {
  const f = await fixture();
  const input = { workspaceId: "remote-workspace", rule: taskRuleSchema.parse({}) };
  await expect(f.server.rpc(workspacePreview, { ...input, connectionKey: "old-connection" }, f.paseo)).rejects.toThrow("Connection identity changed");
  await expect(f.server.rpc(workspacePreview, { ...input, workspaceId: "missing" }, f.paseo)).rejects.toThrow("Multica workspace unavailable");
  expect(f.requests.filter(path => path.startsWith("/api/issues?"))).toHaveLength(0);
  f.issues[0].workspace_id = "other";
  await expect(f.server.rpc(workspacePreview, input, f.paseo)).rejects.toThrow("Issue belongs to a different workspace");
  f.issues[0].workspace_id = "remote-workspace";
  f.remote.emptyNextPage = true;
  await expect(f.server.rpc(workspacePreview, input, f.paseo)).rejects.toThrow("Incomplete issue pagination");
  f.remote.emptyNextPage = false;
  f.remote.nextPageFails = true;
  await expect(f.server.rpc(workspacePreview, input, f.paseo)).rejects.toThrow("HTTP 503");
  expect(f.connectHost).not.toHaveBeenCalled();
  await expect(stat(join(f.home, "multica-provider", "state.json"))).rejects.toMatchObject({ code: "ENOENT" });
});

it("workspace preview does not wait behind a blocked native sync", async () => {
  const f = await fixture();
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const rename = f.host.renameProject.bind(f.host);
  const held = vi.spyOn(f.host, "renameProject").mockImplementation(async (...args) => { await gate; return rename(...args); });
  const syncing = f.server.syncRpc(enable, { workspaceId: "remote-workspace", enabled: true }, f.paseo);
  try {
    await vi.waitFor(() => expect(held).toHaveBeenCalled());
    expect(await f.server.rpc(workspacePreview, { workspaceId: "remote-workspace", rule: taskRuleSchema.parse({}) }, f.paseo)).toEqual({ total: 2, imported: 0, entering: 2, leaving: [] });
    expect(f.native.workspaces).toHaveLength(0);
  } finally { release(); await syncing; }
});

it("client bootstrap copies each discussion's task from agent labels into metadata for the composer's agent picker", async () => {
  const f = await fixture();
  await f.server.syncRpc(enable, { workspaceId: "remote-workspace", enabled: true }, f.paseo);
  const host = metadataHost(f.native.agents);
  const [first, second] = f.native.agents;
  const task = (agent: typeof first) => ({ agentId: agent.id, patch: { "multica.connection": agent.labels["multica.connection"], "multica.issue": agent.labels["multica.issue"] } });
  expect(await f.server.syncRpc(bootstrap, {}, host.paseo)).toEqual({ status: "ready" });
  await vi.waitFor(() => expect(host.writes).toEqual([task(first), task(second)]));
  // Only this connection's discussions are read, archived ones included; a matching copy is left alone.
  expect(host.listings).toEqual([{ labels: { "multica.connection": first.labels["multica.connection"] }, includeArchived: true }]);
  expect(await f.server.syncRpc(bootstrap, {}, host.paseo)).toEqual({ status: "ready" });
  await new Promise(resolve => setTimeout(resolve, 20));
  expect(host.listings).toHaveLength(1);
  expect(host.writes).toEqual([task(first), task(second)]);

});

it("the metadata copy follows directory pages, and a cursor that repeats stops it without failing bootstrap", async () => {
  const f = await fixture();
  await f.server.syncRpc(enable, { workspaceId: "remote-workspace", enabled: true }, f.paseo);
  const paged = metadataHost(f.native.agents, { pageSize: 1 });
  expect(await f.server.syncRpc(bootstrap, {}, paged.paseo)).toEqual({ status: "ready" });
  await vi.waitFor(() => expect(paged.writes).toHaveLength(2));
  expect(paged.listings).toHaveLength(2);
  await f.dispose();
  const restarted = f.start();
  const looping = metadataHost(f.native.agents, { pageSize: 1, repeatingCursor: true });
  expect(await restarted.server.syncRpc(bootstrap, {}, looping.paseo)).toEqual({ status: "ready" });
  await vi.waitFor(() => expect(looping.listings).toHaveLength(2));
  // The same cursor comes back, so the directory cannot be proven complete: nothing loops, and the
  // discussions after it wait for a readable directory.
  await new Promise(resolve => setTimeout(resolve, 20));
  expect(looping.writes).toHaveLength(2);
  expect(new Set(looping.writes.map(write => write.agentId)).size).toBe(1);
});

it("a host without agent metadata is read once, and bootstrap stays ready", async () => {
  const f = await fixture();
  await f.server.syncRpc(enable, { workspaceId: "remote-workspace", enabled: true }, f.paseo);
  const host = metadataHost(f.native.agents, { legacy: true });
  expect(await f.server.syncRpc(bootstrap, {}, host.paseo)).toEqual({ status: "ready" });
  await vi.waitFor(() => expect(host.attempts()).toBe(1));
  await new Promise(resolve => setTimeout(resolve, 20));
  expect(await f.server.syncRpc(bootstrap, {}, host.paseo)).toEqual({ status: "ready" });
  await new Promise(resolve => setTimeout(resolve, 20));
  expect(host.attempts()).toBe(1);
  expect(host.writes).toEqual([]);
});

it("a failed backfill retries on the next bootstrap and disposal waits for an in-flight copy", async () => {
  const f = await fixture();
  await f.server.syncRpc(enable, { workspaceId: "remote-workspace", enabled: true }, f.paseo);
  const host = metadataHost(f.native.agents);
  host.control.failNextListing = true;
  expect(await f.server.syncRpc(bootstrap, {}, host.paseo)).toEqual({ status: "ready" });
  await vi.waitFor(() => expect(host.attempts()).toBe(1));
  await new Promise(resolve => setTimeout(resolve, 20));
  expect(host.writes).toEqual([]);
  expect(await f.server.syncRpc(bootstrap, {}, host.paseo)).toEqual({ status: "ready" });
  await vi.waitFor(() => expect(host.writes).toHaveLength(2));
  expect(host.attempts()).toBe(2);
  await f.dispose();
  // Bootstrap answers while the copy is still pending; shutdown does not overtake it.
  host.stored.clear();
  let release!: () => void;
  host.control.holdWrites = new Promise<void>(resolve => { release = resolve; });
  const restarted = f.start();
  expect(await restarted.server.syncRpc(bootstrap, {}, host.paseo)).toEqual({ status: "ready" });
  await vi.waitFor(() => expect(host.attempts()).toBe(3));
  let disposed = false;
  const disposing = Promise.resolve(restarted.dispose()).then(() => { disposed = true; });
  await new Promise(resolve => setTimeout(resolve, 20));
  expect(disposed).toBe(false);
  release();
  await disposing;
  expect(host.writes).toHaveLength(3);
});

it("disabling a rule removes its empty Project and reenabling preserves tasks, discussion IDs and directories", async () => {
  const f = await fixture();
  await f.server.syncRpc(enable, { workspaceId: "remote-workspace", enabled: true }, f.paseo);
  const projectId = f.native.projects[0].projectId;
  const directories = f.native.workspaces.map(item => item.cwd);
  const agents = f.native.agents.map(item => item.id);
  await f.server.syncRpc(enable, { workspaceId: "remote-workspace", enabled: false }, f.paseo);
  expect(f.native.workspaces.every(item => item.archived)).toBe(true);
  expect(f.native.projects).toEqual([]);
  await f.server.syncRpc(enable, { workspaceId: "remote-workspace", enabled: true }, f.paseo);
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
  await f.server.syncRpc(enable, { workspaceId: "remote-workspace", enabled: true }, f.paseo);
  f.native.agents[0].archivedAt = "already-hidden";
  const archive = f.host.archiveWorkspace.bind(f.host);
  f.host.archiveWorkspace = async () => { throw new Error("temporarily disconnected"); };
  expect(await f.server.syncRpc(enable, { workspaceId: "remote-workspace", enabled: false }, f.paseo)).toMatchObject({ status: "unavailable" });
  f.host.archiveWorkspace = archive;
  await resync(f.server, f.paseo, "remote-workspace");
  expect(f.native.workspaces.every(item => item.archived)).toBe(true);
  await f.server.syncRpc(enable, { workspaceId: "remote-workspace", enabled: true }, f.paseo);
  expect(f.native.agents[0].archivedAt).toBeTruthy();
  expect(f.native.agents[1].archivedAt).toBeNull();
});

it("rebuilt Projects retain manual hiding and restore the original discussion only when selected", async () => {
  const f = await fixture();
  await f.server.syncRpc(enable, { workspaceId: "remote-workspace", enabled: true }, f.paseo);
  const main = f.native.agents[0];
  main.archivedAt = "manual-hidden";
  await f.server.hook("agent.archive.after", { agent: { id: main.id, workspaceId: main.workspaceId, provider: "multica", cwd: main.cwd, title: "主讨论", parentAgentId: null }, archivedAt: main.archivedAt }, f.paseo);
  await f.server.syncRpc(enable, { workspaceId: "remote-workspace", enabled: false }, f.paseo);
  await f.server.syncRpc(enable, { workspaceId: "remote-workspace", enabled: true }, f.paseo);
  expect(main.archivedAt).toBeTruthy();
  const hidden = await hiddenObjects(f.server, f.paseo);
  expect(hidden).toHaveLength(1);
  expect(hidden[0].agentId).toBe(main.id);
  expect(await f.server.rpc(hiddenRestore, { connectionKey: main.labels["multica.connection"], issueId: "issue-one", rootId: "main" }, f.paseo)).toEqual({ status: "ready" });
  expect(main.archivedAt).toBeNull();
  expect(f.native.agents).toHaveLength(2);
  expect(f.native.workspaces.find(workspace => workspace.id === main.workspaceId)?.projectId).toBe(f.native.projects[0].projectId);
});

it("reconciles native workspace restoration once across all pages and imports new Threads while retaining separately archived tabs", async () => {
  const f = await fixture(60_000); f.remote.acknowledgeEvents = false;
  f.comments.push({ id: "existing-thread", issue_id: "issue-one", content: "已有讨论" });
  await f.server.syncRpc(enable, { workspaceId: "remote-workspace", enabled: true }, f.paseo);
  const fetch = vi.spyOn(f.host, "fetchWorkspaces");
  await resync(f.server, f.paseo, "remote-workspace");
  expect(fetch).not.toHaveBeenCalled();
  const thread = f.native.agents.find(agent => agent.labels["multica.discussion"] === "existing-thread")!;
  thread.archivedAt = "separately-hidden";
  await f.server.hook("agent.archive.after", { agent: { ...thread, provider: "multica", title: thread.name!, parentAgentId: null }, archivedAt: thread.archivedAt }, f.paseo);
  for (const workspace of f.native.workspaces) {
    await f.host.archiveWorkspace(workspace.id);
    for (const agent of f.native.agents.filter(agent => agent.workspaceId === workspace.id)) {
      await f.server.hook("agent.archive.after", { agent: { ...agent, provider: "multica", title: agent.name!, parentAgentId: null }, archivedAt: agent.archivedAt! }, f.paseo);
    }
    await f.server.hook("workspace.archive.after", { workspace: { id: workspace.id, projectId: workspace.projectId, cwd: workspace.cwd, name: workspace.title, archivedAt: "manually-hidden" } }, f.paseo);
    await f.host.restoreWorkspace(workspace.id);
    f.native.agents.find(agent => agent.workspaceId === workspace.id && agent.labels["multica.discussion"] === "main")!.archivedAt = null;
  }
  f.native.workspacePageSize = 1;
  f.comments.push({ id: "new-thread", issue_id: "issue-one", content: "恢复后的新讨论" });
  f.issues[0].title = "恢复后的任务标题";
  expect(await resync(f.server, f.paseo, "remote-workspace")).toEqual({ status: "ready" });
  expect(fetch.mock.calls).toEqual([[{ page: { limit: 100, cursor: undefined } }], [{ page: { limit: 100, cursor: "1" } }]]);
  const state = JSON.parse(await readFile(join(f.home, "multica-provider/state.json"), "utf8")) as LocalState;
  const local = Object.values(state.connections)[0];
  expect(local.issues["issue-one"].manualHidden).toEqual({ workspace: false, discussions: ["existing-thread"] });
  expect(local.issues["issue-two"].manualHidden).toEqual({ workspace: false, discussions: [] });
  expect(f.native.workspaces[0].title).toBe("PRD-1 恢复后的任务标题");
  expect(thread.archivedAt).toBeTruthy();
  expect(f.native.agents.find(agent => agent.labels["multica.discussion"] === "new-thread")).toMatchObject({ workspaceId: thread.workspaceId, name: "恢复后的新讨论" });
  fetch.mockClear();
  await resync(f.server, f.paseo, "remote-workspace");
  expect(fetch).not.toHaveBeenCalled();
});

it("reconciles a native Thread unarchive immediately while ignoring unarchive notifications inside the hidden-discussion hold", async () => {
  const f = await fixture(60_000); f.remote.acknowledgeEvents = false;
  f.comments.push({ id: "restored-thread", issue_id: "issue-one", content: "恢复的讨论" }, { id: "protected-thread", issue_id: "issue-one", content: "仍隐藏的讨论" });
  await f.server.syncRpc(enable, { workspaceId: "remote-workspace", enabled: true }, f.paseo);
  const thread = f.native.agents.find(agent => agent.labels["multica.discussion"] === "restored-thread")!;
  const protectedThread = f.native.agents.find(agent => agent.labels["multica.discussion"] === "protected-thread")!;
  for (const agent of [thread, protectedThread]) {
    agent.archivedAt = "manually-hidden";
    await f.server.hook("agent.archive.after", { agent: { ...agent, provider: "multica", title: agent.name!, parentAgentId: null }, archivedAt: agent.archivedAt }, f.paseo);
  }
  const provider = await f.server.providers.get("multica")!.connect({ versions: [1], capabilities: ["session.unarchive"] });
  cleanup.push(() => provider.close());
  const events: ProviderEvent[] = []; provider.onEvent(event => events.push(event));
  let entered!: () => void, release!: () => void;
  const arrived = new Promise<void>(resolve => { entered = resolve; }), blocked = new Promise<void>(resolve => { release = resolve; });
  const fetch = f.host.fetchAgent.bind(f.host);
  vi.spyOn(f.host, "fetchAgent").mockImplementation(async id => { if (id === protectedThread.id) { entered(); await blocked; } return fetch(id); });
  const restoring = f.server.rpc(hiddenRestore, { connectionKey: thread.labels["multica.connection"], issueId: "issue-one", rootId: "main" }, f.paseo);
  await arrived;
  try {
    await provider.send({ type: "session.unarchive", requestId: "held-unarchive", persistence: JSON.parse(protectedThread.handle.slice(7)) });
    expect(events).toContainEqual({ type: "request.completed", requestId: "held-unarchive" });
    expect((await f.server.rpc(connectionStatus, {}, f.paseo)).sync.status).toBe("ready");
    expect((await hiddenObjects(f.server, f.paseo)).map(item => item.rootId)).toEqual(["restored-thread", "protected-thread"]);
  } finally { release(); await restoring; }
  thread.archivedAt = null;
  const workspaces = vi.spyOn(f.host, "fetchWorkspaces");
  await provider.send({ type: "session.unarchive", requestId: "native-unarchive", persistence: JSON.parse(thread.handle.slice(7)) });
  expect(events).toContainEqual({ type: "request.completed", requestId: "native-unarchive" });
  await expect.poll(async () => (await hiddenObjects(f.server, f.paseo)).map(item => item.rootId)).toEqual(["protected-thread"]);
  expect((await waitForSync(f.server, f.paseo)).status).toBe("ready");
  expect(workspaces).not.toHaveBeenCalled();
  expect(thread.archivedAt).toBeNull(); expect(protectedThread.archivedAt).toBeTruthy();
  const state = JSON.parse(await readFile(join(f.home, "multica-provider/state.json"), "utf8")) as LocalState;
  expect(Object.values(state.connections)[0].issues["issue-one"].manualHidden).toEqual({ workspace: false, discussions: ["protected-thread"] });
});

it.each(["missing", "workspaceId", "cwd", "provider"])("retains discussion hiding when the native agent is %s or does not match", async field => {
  const f = await fixture(60_000); f.remote.acknowledgeEvents = false;
  await f.server.syncRpc(enable, { workspaceId: "remote-workspace", enabled: true }, f.paseo);
  const main = f.native.agents[0];
  main.archivedAt = "manually-hidden";
  await f.server.hook("agent.archive.after", { agent: { ...main, provider: "multica", title: "主讨论", parentAgentId: null }, archivedAt: main.archivedAt }, f.paseo);
  main.archivedAt = null;
  const fetch = f.host.fetchAgent.bind(f.host);
  vi.spyOn(f.host, "fetchAgent").mockImplementation(async id => {
    const result = await fetch(id);
    return id !== main.id ? result : field === "missing" ? null : { ...result!, agent: { ...result!.agent, [field]: "other" } };
  });
  expect(await resync(f.server, f.paseo, "remote-workspace")).toEqual({ status: "ready" });
  expect(await hiddenObjects(f.server, f.paseo)).toMatchObject([{ kind: "main", agentId: main.id, rootId: "main" }]);
});

it.each(["missing", "repeated"])("retains workspace hiding when the native directory has a %s cursor", async kind => {
  const f = await fixture(60_000); f.remote.acknowledgeEvents = false;
  await f.server.syncRpc(enable, { workspaceId: "remote-workspace", enabled: true }, f.paseo);
  const workspace = f.native.workspaces[0];
  await f.server.hook("workspace.archive.after", { workspace: { id: workspace.id, projectId: workspace.projectId, cwd: workspace.cwd, name: workspace.title, archivedAt: "manually-hidden" } }, f.paseo);
  const page = await f.host.fetchWorkspaces();
  const fetch = vi.spyOn(f.host, "fetchWorkspaces").mockResolvedValue({ ...page, pageInfo: { ...page.pageInfo, hasMore: true, nextCursor: kind === "missing" ? null : "loop" } });
  expect(await resync(f.server, f.paseo, "remote-workspace")).toEqual({ status: "unavailable" });
  expect(fetch).toHaveBeenCalledTimes(kind === "missing" ? 1 : 2);
  expect(await hiddenObjects(f.server, f.paseo)).toMatchObject([{ kind: "workspace", workspaceId: workspace.id }]);
});

it("rebuilding a disabled Project leaves manually hidden tasks archived until explicitly restored", async () => {
  const f = await fixture();
  await f.server.syncRpc(enable, { workspaceId: "remote-workspace", enabled: true }, f.paseo);
  const workspace = f.native.workspaces[0], main = f.native.agents[0];
  await f.host.archiveWorkspace(workspace.id);
  await f.server.hook("agent.archive.after", { agent: { id: main.id, workspaceId: main.workspaceId, provider: "multica", cwd: main.cwd, title: "主讨论", parentAgentId: null }, archivedAt: main.archivedAt! }, f.paseo);
  await f.server.hook("workspace.archive.after", { workspace: { id: workspace.id, projectId: workspace.projectId, cwd: workspace.cwd, name: workspace.title, archivedAt: "manual-hidden" } }, f.paseo);
  await f.server.syncRpc(enable, { workspaceId: "remote-workspace", enabled: false }, f.paseo);
  expect(f.native.projects).toEqual([]);
  await f.server.syncRpc(enable, { workspaceId: "remote-workspace", enabled: true }, f.paseo);
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
  // Inspect the failed pass before any handshake-triggered automatic retry.
  f.remote.acknowledgeEvents = false;
  await f.server.syncRpc(enable, { workspaceId: "remote-workspace", enabled: true }, f.paseo);
  const original = f.native.agents.map(({ id, cwd, handle }) => ({ id, cwd, handle }));
  const remove = f.host.removeProject.bind(f.host);
  f.host.removeProject = async id => { await remove(id); throw new Error("Removal acknowledgement lost"); };
  expect(await f.server.syncRpc(enable, { workspaceId: "remote-workspace", enabled: false }, f.paseo)).toEqual({ status: "unavailable" });
  expect(f.native.projects).toEqual([]);
  await f.dispose();
  const restarted = f.start();
  expect(await resync(restarted.server, f.paseo, "remote-workspace")).toEqual({ status: "ready" });
  const importAgent = f.host.importAgent.bind(f.host);
  f.host.importAgent = async input => { await importAgent(input); throw new Error("Import acknowledgement lost"); };
  expect(await restarted.server.syncRpc(enable, { workspaceId: "remote-workspace", enabled: true }, f.paseo)).toEqual({ status: "unavailable" });
  f.host.importAgent = importAgent;
  expect(await resync(restarted.server, f.paseo, "remote-workspace")).toEqual({ status: "ready" });
  expect(f.native.agents.map(({ id, cwd, handle }) => ({ id, cwd, handle }))).toEqual(original);
  expect(f.native.agents.every(agent => !agent.archivedAt)).toBe(true);
  expect(f.native.projects).toHaveLength(1);
});

it("disabling an empty rule removes its Project, but retains Projects containing user workspaces on later pages", async () => {
  const f = await fixture();
  f.issues.length = 0;
  await f.server.syncRpc(enable, { workspaceId: "remote-workspace", enabled: true }, f.paseo);
  expect(f.native.projects).toHaveLength(1);
  expect(await f.server.syncRpc(enable, { workspaceId: "remote-workspace", enabled: false }, f.paseo)).toEqual({ status: "ready" });
  expect(f.native.projects).toEqual([]);
  await f.server.syncRpc(enable, { workspaceId: "remote-workspace", enabled: true }, f.paseo);
  const projectId = f.native.projects[0].projectId;
  f.native.workspacePageSize = 1;
  f.native.workspaces.push({ id: "unrelated", projectId: "unrelated-project", cwd: f.home, title: "Unrelated" },
    { id: "user-workspace", projectId, cwd: f.home, title: "User workspace" });
  expect(await f.server.syncRpc(enable, { workspaceId: "remote-workspace", enabled: false }, f.paseo)).toEqual({ status: "ready" });
  expect(f.native.projects[0].projectId).toBe(projectId);
  expect(f.native.workspaces.every(workspace => !workspace.archived)).toBe(true);
  expect((await f.server.rpc(connectionStatus, {}, f.paseo)).sync).toMatchObject({ status: "ready", completedArchives: 0, pendingArchives: 0 });
  const stages: string[] = [];
  const listing = f.host.listProjects.bind(f.host);
  f.host.listProjects = async () => { stages.push((await f.server.rpc(connectionStatus, {}, f.paseo)).sync.stage); return listing(); };
  expect(await resync(f.server, f.paseo, "remote-workspace")).toEqual({ status: "ready" });
  expect(stages.length).toBeGreaterThan(0);
  expect(stages).not.toContain("archiving");
  expect((await f.server.rpc(connectionStatus, {}, f.paseo)).sync.pendingArchives).toBe(0);
});

it("an incomplete native workspace directory cannot authorize removing a disabled Project", async () => {
  const f = await fixture();
  f.issues.length = 0;
  await f.server.syncRpc(enable, { workspaceId: "remote-workspace", enabled: true }, f.paseo);
  const fetch = f.host.fetchWorkspaces.bind(f.host);
  f.host.fetchWorkspaces = (async () => ({ entries: [], pageInfo: { hasMore: true, nextCursor: null } })) as unknown as DaemonClient["fetchWorkspaces"];
  expect(await f.server.syncRpc(enable, { workspaceId: "remote-workspace", enabled: false }, f.paseo)).toEqual({ status: "unavailable" });
  expect(f.native.projects).toHaveLength(1);
  f.host.fetchWorkspaces = fetch;
  expect(await resync(f.server, f.paseo, "remote-workspace")).toEqual({ status: "ready" });
  expect(f.native.projects).toEqual([]);
});

it("repeated bootstrap, title edits, token rotation and normal restart preserve native issue and tab identities", async () => {
  const f = await fixture();
  await f.server.syncRpc(enable, { workspaceId: "remote-workspace", enabled: true }, f.paseo);
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
  expect(await restarted.server.rpc(workspaces, {}, f.paseo)).toMatchObject({ workspaces: [{ id: "remote-workspace", enabled: true }] });
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
  expect(await f.server.syncRpc(enable, { workspaceId: "remote-workspace", enabled: true }, f.paseo)).toMatchObject({ status: "ready" });
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
  await f.server.syncRpc(enable, { workspaceId: "remote-workspace", enabled: true }, f.paseo);
  await f.dispose();
  const statePath = join(f.home, "multica-provider", "state.json");
  const persisted = JSON.parse(await readFile(statePath, "utf8")) as LocalState;
  const connectionKey = f.native.agents[0].labels["multica.connection"];
  const legacyProject = join(f.home, "multica-provider", "placeholders", "a".repeat(64), "b".repeat(64));
  // Seed the persisted/native boundary as an installation using the older
  // full-length directory format, with already imported agent history.
  persisted.connections[connectionKey].projects["remote-workspace"].cwd = legacyProject;
  delete persisted.connections[connectionKey].projects["remote-workspace"].appliedName;
  f.native.projects[0].cwd = legacyProject;
  f.native.projects[0].name = "产品开发";
  for (const [index, issue] of f.issues.entries()) {
    const cwd = join(legacyProject, (index === 0 ? "c" : "d").repeat(64));
    persisted.connections[connectionKey].issues[issue.id].cwd = cwd;
    f.native.workspaces[index].cwd = cwd;
    f.native.agents[index].cwd = cwd;
    await mkdir(cwd, { recursive: true });
  }
  await writeFile(statePath, JSON.stringify(persisted));
  const projects = structuredClone(f.native.projects);
  projects[0].name = "Multica · 产品开发";
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
  // Inspect the failed pass before any handshake-triggered automatic retry.
  f.remote.acknowledgeEvents = false;
  const create = f.host.createWorkspace.bind(f.host);
  f.host.createWorkspace = async (...args) => { await create(...args); throw new Error("response lost"); };
  expect(await f.server.syncRpc(enable, { workspaceId: "remote-workspace", enabled: true }, f.paseo)).toMatchObject({ status: "unavailable" });
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
  // Inspect the failed pass before any handshake-triggered automatic retry.
  f.remote.acknowledgeEvents = false;
  const importAgent = f.host.importAgent.bind(f.host);
  f.host.importAgent = async input => { await importAgent(input); throw new Error("response lost"); };
  expect(await f.server.syncRpc(enable, { workspaceId: "remote-workspace", enabled: true }, f.paseo)).toMatchObject({ status: "unavailable" });
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
  // Inspect the failed pass before any handshake-triggered automatic retry.
  f.remote.acknowledgeEvents = false;
  const seen: Array<string | undefined> = [];
  f.host.fetchAgents = (async (input?: { page?: { cursor?: string } }) => {
    const cursor = input?.page?.cursor;
    seen.push(cursor);
    if (seen.length > 3) throw new Error("Fixture rejected repeated cursor");
    return { entries: [], pageInfo: { hasMore: true, nextCursor: cursor === "first" ? "second" : "first" } };
  }) as unknown as DaemonClient["fetchAgents"];
  expect(await f.server.syncRpc(enable, { workspaceId: "remote-workspace", enabled: true }, f.paseo)).toMatchObject({ status: "unavailable" });
  expect(f.native.agents).toEqual([]);
  expect(seen).toEqual([undefined, "first", "second"]);
});

it("bootstrap rejects a different native daemon before creating sidebar records", async () => {
  const f = await fixture();
  f.host.listHosts = async () => ({ self: { serverId: "other-daemon" } }) as Awaited<ReturnType<DaemonClient["listHosts"]>>;
  expect(await f.server.syncRpc(enable, { workspaceId: "remote-workspace", enabled: true }, f.paseo)).toMatchObject({ status: "unavailable" });
  expect(f.native.projects).toEqual([]);
  expect(f.native.workspaces).toEqual([]);
  expect(f.native.agents).toEqual([]);
});

it("the daemon worker continues updating native task names without further client RPCs", async () => {
  const f = await fixture(30);
  await f.server.syncRpc(enable, { workspaceId: "remote-workspace", enabled: true }, f.paseo);
  f.issues[0].title = "后台已同步";
  await expect.poll(() => f.native.workspaces[0].title, { timeout: 2_000, interval: 20 }).toBe("PRD-1 后台已同步");
});

it("enabling the default rule pages custom-category issues into a native project, separate workspaces and main discussion tabs", async () => {
  const f = await fixture();
  expect(await f.server.syncRpc(enable, { workspaceId: "remote-workspace", enabled: true }, f.paseo)).toMatchObject({ status: "ready" });
  expect(f.native.projects).toMatchObject([{ name: "Multica · 产品开发" }]);
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
  await f.server.syncRpc(enable, { workspaceId: "remote-workspace", enabled: true }, f.paseo);
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
  await f.server.syncRpc(enable, { workspaceId: "remote-workspace", enabled: true }, f.paseo);
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
  await f.server.syncRpc(enable, { workspaceId: "remote-workspace", enabled: true }, f.paseo);
  const rule: z.input<typeof ruleRpc.input>["rule"] = { statusCategories: ["unstarted", "started"], statuses: ["custom-ready", "custom-review"],
    assignees: [{ type: "member" as const, id: "user-42" }, { type: "squad" as const, id: "squad-owned" }], projectIds: ["project-a"], labelIds: ["red", "blue"] };
  expect(await f.server.syncRpc(ruleRpc, { workspaceId: "remote-workspace", rule }, f.paseo)).toEqual({ status: "ready" });
  expect(f.native.workspaces.map(item => !!item.archived)).toEqual([false, true]);
  const query = new URL(f.requests.filter(path => path.startsWith("/api/issues?")).at(-1)!, "http://localhost").searchParams;
  expect(Object.fromEntries(query)).toEqual({ limit: "100", offset: "0", status_categories: "unstarted,started", statuses: "custom-ready,custom-review", assignee_filters: "member:user-42,squad:squad-owned", project_ids: "project-a", label_ids: "red,blue" });
  rule.assignees = [{ type: "agent", id: "agent-owned" }];
  await f.server.syncRpc(ruleRpc, { workspaceId: "remote-workspace", rule }, f.paseo);
  expect(f.native.workspaces.map(item => !!item.archived)).toEqual([true, false]);
  const workspaceRules = defineRpc({ name: "workspace.list", input: z.object({}), output: z.object({ workspaces: z.array(z.object({ id: z.string(), rule: ruleRpc.input.shape.rule })) }) });
  expect((await f.server.rpc(workspaceRules, {}, f.paseo)).workspaces[0].rule).toEqual(rule);
  await f.dispose();
  const restart = f.start();
  await resync(restart.server, f.paseo, "remote-workspace");
  expect(f.native.workspaces).toHaveLength(2);
  expect(f.native.workspaces.map(item => !!item.archived)).toEqual([true, false]);
});


it("workspace events discover new matching issues and restore every automatically archived tab on reentry", async () => {
  const f = await fixture(60_000);
  await f.server.syncRpc(enable, { workspaceId: "remote-workspace", enabled: true }, f.paseo);
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
  await f.server.syncRpc(enable, { workspaceId: "remote-workspace", enabled: false }, f.paseo);
  await expect.poll(() => f.websocket.clients.size, { timeout: 2_000 }).toBe(0);
});

it("ignores streaming task telemetry while auth_ack and task lifecycle events still trigger sidebar snapshots", async () => {
  const f = await fixture(60_000, undefined, null); f.remote.acknowledgeEvents = false;
  await f.server.syncRpc(enable, { workspaceId: "remote-workspace", enabled: true }, f.paseo);
  await expect.poll(() => f.websocketRequests[0]?.auth).toBeDefined();
  const reads = () => f.requests.filter(path => path.startsWith("/api/issues?")).length;
  const beforeAuth = reads(); f.signal("auth_ack");
  await expect.poll(reads).toBe(beforeAuth + 2); await waitForSync(f.server, f.paseo);
  const before = reads();
  for (let i = 0; i < 10; i++) for (const type of ["task:message", "task:usage", "task:progress"]) f.signal(type);
  await new Promise(resolve => setTimeout(resolve, 600));
  expect(reads()).toBe(before);
  expect((await f.server.rpc(connectionStatus, {}, f.paseo)).sync.status).toBe("ready");
  f.issues[0].title = "执行已完成"; f.signal("task:completed");
  await expect.poll(() => f.native.workspaces[0].title).toBe("PRD-1 执行已完成");
  expect((await waitForSync(f.server, f.paseo)).status).toBe("ready");
  expect(reads()).toBe(before + 2);
});

it("coalesces event bursts and settles ready before waiting a new window for events received during a snapshot", async () => {
  const f = await fixture(60_000, undefined, null); f.remote.acknowledgeEvents = false;
  await f.server.syncRpc(enable, { workspaceId: "remote-workspace", enabled: true }, f.paseo);
  await expect.poll(() => f.websocketRequests[0]?.auth).toBeDefined();
  const reads = () => f.requests.filter(path => path.startsWith("/api/issues?")).length;
  let before = reads(); f.signal("auth_ack");
  await expect.poll(reads).toBe(before + 2); await waitForSync(f.server, f.paseo);
  before = reads(); f.remote.holdIssueReads = true;
  try {
    for (let i = 0; i < 20; i++) f.signal("task:started");
    await expect.poll(() => f.heldIssueReads.length).toBe(1);
    for (let i = 0; i < 20; i++) f.signal("task:failed");
    await new Promise(resolve => setTimeout(resolve, 600));
    expect(reads()).toBe(before + 1);
  } finally { f.remote.holdIssueReads = false; for (const reply of f.heldIssueReads.splice(0)) reply(); }
  const ready = await waitForSync(f.server, f.paseo);
  expect(ready).toMatchObject({ status: "ready", lastSuccessAt: expect.any(String) });
  expect(reads()).toBe(before + 2);
  await expect.poll(reads).toBe(before + 4);
  expect((await waitForSync(f.server, f.paseo)).status).toBe("ready");
  expect(reads()).toBe(before + 4);
});

it("scopes workspace events without disconnecting other sockets and preserves unexamined workspace failures until their own recovery", async () => {
  const f = await fixture(60_000); f.remote.acknowledgeEvents = false;
  await f.server.syncRpc(enable, { workspaceId: "remote-workspace", enabled: true }, f.paseo);
  await enableSecondWorkspace(f);
  await expect.poll(() => f.websocketRequests.filter(request => request.auth).length).toBe(2);
  f.signal("auth_ack");
  await new Promise(resolve => setTimeout(resolve, 50)); await waitForSync(f.server, f.paseo);
  f.remote.nextPageFails = true; f.remote.failingWorkspace = "second";
  expect(await resync(f.server, f.paseo, "remote-workspace")).toEqual({ status: "unavailable" });
  const reads = () => f.scopes.filter(request => request.path.startsWith("/api/issues?"));
  const eventPass = async (slug: string) => {
    const before = reads().length;
    f.signal("task:cancelled", {}, slug);
    await expect.poll(() => reads().length).toBe(before + 2);
    const status = await waitForSync(f.server, f.paseo);
    expect(reads().slice(before).map(request => request.slug)).toEqual([slug, slug]);
    expect(f.websocket.clients.size).toBe(2); expect(f.websocketRequests).toHaveLength(2);
    return status;
  };
  expect(await eventPass("product")).toMatchObject({ status: "unavailable", enabledWorkspaces: 1, completedWorkspaces: 1, failedWorkspaces: [{ workspaceId: "second-workspace" }] });
  f.remote.failingWorkspace = "product";
  expect(await eventPass("product")).toMatchObject({ status: "unavailable", enabledWorkspaces: 1, completedWorkspaces: 0,
    failedWorkspaces: [{ workspaceId: "remote-workspace" }, { workspaceId: "second-workspace" }] });
  f.remote.nextPageFails = false;
  expect(await eventPass("product")).toMatchObject({ status: "unavailable", enabledWorkspaces: 1, completedWorkspaces: 1, failedWorkspaces: [{ workspaceId: "second-workspace" }] });
  const recovered = await eventPass("second");
  expect(recovered).toMatchObject({ status: "ready", enabledWorkspaces: 1, completedWorkspaces: 1 });
  expect(recovered.failedWorkspaces ?? []).toEqual([]);
});


it("failed or incomplete snapshots retain cached native workspaces and only an authoritative empty result archives them", async () => {
  const f = await fixture(60_000);
  await f.server.syncRpc(enable, { workspaceId: "remote-workspace", enabled: true }, f.paseo);
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
  await f.server.syncRpc(enable, { workspaceId: "remote-workspace", enabled: true }, f.paseo);
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
  await f.server.syncRpc(enable, { workspaceId: "remote-workspace", enabled: true }, f.paseo);
  expect(f.native.workspaces.map(item => item.title)).toEqual(["PRD-1 实现登录"]);
  await f.server.syncRpc(ruleRpc, { workspaceId: "remote-workspace", rule: { statusCategories: [], statuses: ["done", "custom-complete"], assignees: [], projectIds: [], labelIds: [] } }, f.paseo);
  expect(f.native.workspaces.map(item => [item.title, !!item.archived])).toEqual([["PRD-1 实现登录", true], ["PRD-2 修复同步", false]]);
  const query = new URL(f.requests.filter(path => path.startsWith("/api/issues?")).at(-1)!, "http://localhost").searchParams;
  expect(query.has("status_categories")).toBe(false);
  expect(query.get("statuses")).toBe("done,custom-complete");
});


it("a lost automatic archive response survives restart and restores the tabs captured before archive", async () => {
  const f = await fixture(60_000);
  await f.server.syncRpc(enable, { workspaceId: "remote-workspace", enabled: true }, f.paseo);
  const archive = f.host.archiveWorkspace.bind(f.host);
  f.host.archiveWorkspace = async (...args) => { await archive(...args); throw new Error("archive acknowledgement lost"); };
  expect(await f.server.syncRpc(enable, { workspaceId: "remote-workspace", enabled: false }, f.paseo)).toEqual({ status: "unavailable" });
  expect(f.native.workspaces[0].archived).toBe(true);
  await f.dispose();
  f.host.archiveWorkspace = archive;
  const restarted = f.start();
  expect(await resync(restarted.server, f.paseo, "remote-workspace")).toEqual({ status: "ready" });
  await restarted.server.syncRpc(enable, { workspaceId: "remote-workspace", enabled: true }, f.paseo);
  expect(f.native.workspaces.filter(item => !item.archived)).toHaveLength(2);
  expect(f.native.agents.every(item => !item.archivedAt)).toBe(true);
});

it("retries a lost automatic workspace restore acknowledgement after restart without refreshing active tabs", async () => {
  const f = await fixture(60_000);
  // Inspect the failed pass before any handshake-triggered automatic retry.
  f.remote.acknowledgeEvents = false;
  await f.server.syncRpc(enable, { workspaceId: "remote-workspace", enabled: true }, f.paseo);
  const original = f.native.agents.map(agent => ({ id: agent.id, cwd: agent.cwd, handle: agent.handle }));
  // A user-created workspace retains this Project, so recovery uses restore.
  f.native.workspaces.push({ id: "user-workspace", projectId: f.native.projects[0].projectId, cwd: f.home, title: "User workspace" });
  await f.server.syncRpc(enable, { workspaceId: "remote-workspace", enabled: false }, f.paseo);
  const restore = f.host.restoreWorkspace.bind(f.host);
  f.host.restoreWorkspace = async id => { await restore(id); throw new Error("workspace restore acknowledgement lost"); };
  expect(await f.server.syncRpc(enable, { workspaceId: "remote-workspace", enabled: true }, f.paseo)).toEqual({ status: "unavailable" });
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
  await f.server.syncRpc(enable, { workspaceId: "remote-workspace", enabled: true }, f.paseo);
  const originalIds = f.native.agents.map(agent => agent.id);
  await f.dispose();
  f.remote.authStatus = 503;
  vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
  try {
    const restarted = f.start();
    expect(await restarted.server.syncRpc(bootstrap, {}, f.paseo)).toMatchObject({ status: "unavailable" });
    // No further client RPC or settings page is needed after this connection.
    f.remote.authStatus = 200;
    f.issues.push({ ...f.issues[0], id: "issue-after-client-close", title: "Recovered in background" });
    await vi.advanceTimersByTimeAsync(1000);
    await expect.poll(() => f.native.agents.length).toBe(3);
    expect(f.native.agents.slice(0, 2).map(agent => agent.id)).toEqual(originalIds);
    await restarted.dispose();
  } finally { vi.useRealTimers(); }
});

it("shares truthful sync progress and retains cached task identity through failed reads and recovery", async () => {
  const f = await fixture();
  await f.server.syncRpc(enable, { workspaceId: "remote-workspace", enabled: true }, f.paseo);
  const ready = (await f.server.rpc(connectionStatus, {}, f.paseo)).sync;
  expect(ready).toMatchObject({ status: "ready", stage: "idle", completedWorkspaces: 1, enabledWorkspaces: 1, lastSuccessAt: expect.any(String) });
  const ids = f.native.agents.map(agent => agent.id);
  f.remote.invalidIssuePage = true;
  expect(await resync(f.server, f.paseo, "remote-workspace")).toMatchObject({ status: "unavailable" });
  expect((await f.server.rpc(connectionStatus, {}, f.paseo)).sync).toMatchObject({ status: "unavailable", stage: "idle", lastSuccessAt: ready.lastSuccessAt });
  expect(f.native.agents.map(agent => agent.id)).toEqual(ids);
  expect(f.native.workspaces.every(workspace => !workspace.archived)).toBe(true);
  f.remote.invalidIssuePage = false;
  await Promise.all([resync(f.server, f.paseo, "remote-workspace"), resync(f.server, f.paseo, "remote-workspace")]);
  expect((await f.server.rpc(connectionStatus, {}, f.paseo)).sync).toMatchObject({ status: "ready", completedWorkspaces: 1 });
});

it("updates the opened main discussion's stable description from cached observation without losing version guards offline", async () => {
  const f = await fixture();
  await f.server.syncRpc(enable, { workspaceId: "remote-workspace", enabled: true }, f.paseo);
  const agent = f.native.agents[0];
  const address = JSON.parse(agent.handle.slice(7)).data;
  const provider = await f.server.providers.get("multica")!.connect({ versions: [1], capabilities: [] });
  cleanup.push(() => provider.close());
  const events: ProviderEvent[] = [];
  provider.onEvent(event => events.push(event));
  await provider.send({ type: "session.open", requestId: "open", sessionId: "opened-main", history: "replay", persistence: JSON.parse(agent.handle.slice(7)), config: { cwd: agent.cwd, env: {}, mcpServers: {}, settings: {}, persist: true } });
  const descriptions = () => events.flatMap(event => event.type === "timeline.item" && event.item.type === "plugin" && event.item.kind === "task-description" ? [event.item.data as { revision: string; preview: string }] : []);
  const old = descriptions().at(-1)!;
  Object.assign(f.issues[0], { status_name: "正在开发", status_category: "started" });
  await resync(f.server, f.paseo, "remote-workspace");
  expect(descriptions()).toHaveLength(2);
  expect(descriptions().at(-1)).toMatchObject({ revision: old.revision, preview: old.preview, overview: { statusName: "正在开发", statusCategory: "started" } });
  expect(events.filter(event => event.type === "timeline.item" && event.item.type === "plugin" && event.item.kind === "task-description")
    .every(event => event.type === "timeline.item" && event.item.id === "multica:description:issue-one")).toBe(true);
  await resync(f.server, f.paseo, "remote-workspace");
  expect(descriptions()).toHaveLength(2);
  f.issues[0].description = "新的任务目标。";
  await resync(f.server, f.paseo, "remote-workspace");
  expect(events.filter(event => event.type === "timeline.item" && event.item.type === "plugin" && event.item.kind === "task-description").at(-1)).toMatchObject({ item: { id: "multica:description:issue-one", data: { preview: "新的任务目标。" } } });
  f.remote.authStatus = 503;
  const current = descriptions().at(-1)!;
  expect(current).toMatchObject({ preview: "新的任务目标。" });
  expect(await f.server.rpc(readDescription, { ...address, revision: current.revision, offset: 0 }, f.paseo)).toEqual({ text: "新的任务目标。", nextOffset: null });
  await expect(f.server.rpc(readDescription, { ...address, revision: old.revision, offset: 0 }, f.paseo)).rejects.toThrow("changed");
});

it.each([
  ["\n  ## 背景\n\n首行正文\n后续内容", "首行正文"],
  ["\n# 目标\n\n## 背景\r\n\r\n首行正文", "首行正文"],
  ["\n  ## 首行目标\n\n### 背景", "首行目标"],
  [`\n## 背景\n\n${"😀".repeat(121)}\n后续内容`, "😀".repeat(120) + "…"],
  [`\n# ${"😀".repeat(121)}`, "😀".repeat(120) + "…"],
  ["\n \n", ""],
])("prefers a body line and falls back to a heading for main session summaries: %s", async (description, expected) => {
  const f = await fixture();
  f.issues[0].description = description;
  await f.server.syncRpc(enable, { workspaceId: "remote-workspace", enabled: true }, f.paseo);
  const agent = f.native.agents[0];
  const provider = await f.server.providers.get("multica")!.connect({ versions: [1], capabilities: ["session.list"] });
  cleanup.push(() => provider.close());
  const events: ProviderEvent[] = [];
  provider.onEvent(event => events.push(event));
  await provider.send({ type: "session.open", requestId: "summary", sessionId: "summary", history: "replay", persistence: JSON.parse(agent.handle.slice(7)), config: { cwd: agent.cwd, env: {}, mcpServers: {}, settings: {}, persist: true } });
  await provider.send({ type: "sessions", requestId: "list", cwd: agent.cwd });
  expect(events).toContainEqual(expect.objectContaining({ type: "session.opened", description: expected }));
  const list = events.find(event => event.type === "sessions");
  expect(list).toMatchObject({ sessions: [expect.objectContaining({ description: expected })] });
  expect(events).toContainEqual(expect.objectContaining({ type: "timeline.item", item: expect.objectContaining({ kind: "task-description", data: expect.objectContaining({ preview: description }) }) }));
});


it("coalesces multiple reconnecting clients and periodic opportunities into one effective sync pass with visible progress", async () => {
  const f = await fixture(1000);
  await f.server.syncRpc(enable, { workspaceId: "remote-workspace", enabled: true }, f.paseo);
  await new Promise(resolve => setTimeout(resolve, 70));
  vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
  try {
    // The worker already exists; its new contribution is created with a controlled clock.
    await f.dispose();
    const restarted = f.start();
    const before = f.requests.length;
    f.remote.holdIssueReads = true;
    const clients = Promise.all([restarted.server.syncRpc(bootstrap, {}, f.paseo), restarted.server.syncRpc(bootstrap, {}, { ...f.paseo } as PaseoApi), restarted.server.syncRpc(bootstrap, {}, f.paseo)]);
    await expect.poll(() => f.heldIssueReads.length).toBe(1);
    expect((await restarted.server.rpc(connectionStatus, {}, f.paseo)).sync).toMatchObject({ status: "syncing", stage: "issues", enabledWorkspaces: 1 });
    await vi.advanceTimersByTimeAsync(30_000);
    expect(f.requests.slice(before).filter(path => path.startsWith("/api/issues?"))).toHaveLength(1);
    f.remote.holdIssueReads = false;
    for (const reply of f.heldIssueReads.splice(0)) reply();
    await clients;
    expect(f.native.agents).toHaveLength(2);
    await restarted.dispose();
  } finally { vi.useRealTimers(); }
});

it("initial settings and repeated interval changes keep one timer, reset its deadline, and leave active snapshots alone", async () => {
  const f = await fixture(null);
  await f.dispose();
  vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
  const changed = vi.spyOn(SidebarSynchronizer.prototype, "settingsChanged");
  const restarted = f.start({ profile: "", syncIntervalSeconds: 30 });
  const issueReads = () => f.requests.filter(path => path.startsWith("/api/issues?")).length;
  try {
    // Initialization records the interval without starting a timer or a pass.
    await restarted.server.rpc(connectionStatus, {}, f.paseo);
    expect(vi.getTimerCount()).toBe(1); // Only the existing RunDetails timer.
    expect(changed).not.toHaveBeenCalled();
    await restarted.server.syncRpc(enable, { workspaceId: "remote-workspace", enabled: true }, f.paseo);
    await expect.poll(() => f.websocketRequests[0]?.auth).toBeDefined();
    expect(vi.getTimerCount()).toBe(2);
    changed.mockClear();
    const before = issueReads(), sockets = f.websocketRequests.length, me = f.requests.filter(path => path === "/api/me").length;
    await vi.advanceTimersByTimeAsync(29_999);
    expect(issueReads()).toBe(before);
    f.remote.holdIssueReads = true;
    await vi.advanceTimersByTimeAsync(1);
    await expect.poll(() => f.heldIssueReads.length).toBe(1);
    for (const seconds of [10, 60, 120, 120]) {
      restarted.server.setSettings(multicaSettings.id, { profile: "", syncIntervalSeconds: seconds });
      await restarted.server.rpc(connectionStatus, {}, f.paseo);
      expect(vi.getTimerCount()).toBe(2);
    }
    await vi.advanceTimersByTimeAsync(360_000);
    expect(issueReads()).toBe(before + 1);
    expect(changed).not.toHaveBeenCalled();
    expect(f.websocketRequests).toHaveLength(sockets);
    expect(f.requests.filter(path => path === "/api/me")).toHaveLength(me);
    expect(f.effects).toEqual([]);
    expect((await restarted.server.rpc(connectionStatus, {}, f.paseo)).sync.status).toBe("syncing");
    f.remote.holdIssueReads = false;
    for (const reply of f.heldIssueReads.splice(0)) reply();
    expect((await waitForSync(restarted.server, f.paseo)).status).toBe("ready");
    expect(issueReads()).toBe(before + 2);
    // Reapplying the same interval must keep the existing deadline.
    await vi.advanceTimersByTimeAsync(60_000);
    restarted.server.setSettings(multicaSettings.id, { profile: "", syncIntervalSeconds: 120 });
    await restarted.server.rpc(connectionStatus, {}, f.paseo);
    await vi.advanceTimersByTimeAsync(59_999);
    expect(issueReads()).toBe(before + 2);
    await vi.advanceTimersByTimeAsync(1);
    await expect.poll(issueReads).toBe(before + 4);
    await waitForSync(restarted.server, f.paseo);
  } finally {
    f.remote.holdIssueReads = false;
    for (const reply of f.heldIssueReads.splice(0)) reply();
    await restarted.dispose(); changed.mockRestore(); vi.useRealTimers();
  }
});

it("the injected polling interval overrides settings, including subsequent changes", async () => {
  const f = await fixture(1_000);
  vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
  try {
    f.server.setSettings(multicaSettings.id, { syncIntervalSeconds: 600 });
    await f.server.syncRpc(enable, { workspaceId: "remote-workspace", enabled: true }, f.paseo);
    const before = f.requests.length;
    f.server.setSettings(multicaSettings.id, { syncIntervalSeconds: 60 });
    await f.server.rpc(connectionStatus, {}, f.paseo);
    await vi.advanceTimersByTimeAsync(1_000);
    await expect.poll(() => f.requests.length).toBeGreaterThan(before);
    await waitForSync(f.server, f.paseo);
  } finally { await f.dispose(); vi.useRealTimers(); }
});

it.each(["workspace", "connection"])("a persistent %s failure retries at the configured interval despite repeated client bootstraps", async failure => {
  const f = await fixture(null);
  // Isolate scheduled retries from the independent WebSocket auth_ack trigger.
  f.remote.acknowledgeEvents = false;
  await f.server.syncRpc(enable, { workspaceId: "remote-workspace", enabled: true }, f.paseo);
  if (failure === "workspace") await enableSecondWorkspace(f);
  await f.dispose();
  if (failure === "workspace") { f.remote.nextPageFails = true; f.remote.failingWorkspace = "product"; }
  else f.remote.authStatus = 503;
  vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
  const restarted = f.start({ profile: "", syncIntervalSeconds: 60 });
  const hostChecks = vi.spyOn(f.host, "listHosts");
  // Whole-pass connection failures stop before reading the workspace list.
  const attempts = () => failure === "workspace" ? f.requests.filter(path => path === "/api/workspaces").length : hostChecks.mock.calls.length;
  const before = attempts();
  const startedAt = vi.getMockedSystemTime()!.getTime();
  // expect.poll also advances fake time; keep client ticks on absolute deadlines.
  const advanceTo = (elapsed: number) => vi.advanceTimersByTimeAsync(startedAt + elapsed - vi.getMockedSystemTime()!.getTime());
  try {
    expect(await restarted.server.syncRpc(bootstrap, {}, f.paseo)).toEqual({ status: "unavailable" });
    const status = (await restarted.server.rpc(connectionStatus, {}, f.paseo)).sync;
    expect(status).toMatchObject(failure === "workspace"
      ? { status: "unavailable", completedWorkspaces: 1, enabledWorkspaces: 2, failedWorkspaces: [{ workspaceId: "remote-workspace" }] }
      : { status: "unavailable", stage: "connection" });
    expect(attempts()).toBe(before + 1);
    for (let elapsed = 10_000; elapsed < 60_000; elapsed += 10_000) {
      await advanceTo(elapsed);
      await Promise.all([restarted.server.rpc(bootstrap, {}, f.paseo), restarted.server.rpc(bootstrap, {}, { ...f.paseo } as PaseoApi)]);
      expect((await waitForSync(restarted.server, f.paseo)).status).toBe("unavailable");
      expect(attempts()).toBe(before + 1);
    }
    await advanceTo(59_999);
    expect(attempts()).toBe(before + 1);
    await advanceTo(60_000);
    expect((await waitForSync(restarted.server, f.paseo)).status).toBe("unavailable");
    expect(attempts()).toBe(before + 2);
    f.remote.nextPageFails = false;
    f.remote.authStatus = 200;
    await advanceTo(120_000);
    expect((await waitForSync(restarted.server, f.paseo)).status).toBe("ready");
  } finally {
    await restarted.dispose(); hostChecks.mockRestore(); vi.useRealTimers();
  }
});

async function enableSecondWorkspace(f: Awaited<ReturnType<typeof fixture>>) {
  f.workspaces.push({ id: "second-workspace", name: "第二个 Multica 工作区", slug: "second" });
  const issues = [0, 1].map(index => ({ ...f.issues[index], id: `second-${index}`, workspace_id: "second-workspace" }));
  f.workspaceIssues.set("second", issues);
  await f.server.syncRpc(enable, { workspaceId: "second-workspace", enabled: true }, f.paseo);
  return issues;
}

it("syncs another Multica workspace while one snapshot is blocked and keeps each workspace's Issues and steps serial", async () => {
  const f = await fixture(60_000); f.remote.acknowledgeEvents = false;
  await f.server.syncRpc(enable, { workspaceId: "remote-workspace", enabled: true }, f.paseo);
  const second = await enableSecondWorkspace(f);
  f.issues[0].title = "等待第一个工作区";
  second[0].title = "第二个工作区第一项"; second[1].title = "第二个工作区第二项";
  const first = f.native.agents.find(agent => agent.labels["multica.issue"] === "second-0")!;
  const last = f.native.agents.find(agent => agent.labels["multica.issue"] === "second-1")!;
  let entered!: () => void, release!: () => void;
  const arrived = new Promise<void>(resolve => { entered = resolve; }), blocked = new Promise<void>(resolve => { release = resolve; });
  const title = f.host.setWorkspaceTitle.bind(f.host);
  const updating = vi.spyOn(f.host, "setWorkspaceTitle").mockImplementation(async (id, value) => {
    if (id === first.workspaceId) { entered(); await blocked; }
    return title(id, value);
  });
  f.remote.holdIssueReads = true; f.remote.holdIssueWorkspace = "product";
  let settled = false;
  const syncing = resync(f.server, f.paseo, "remote-workspace").finally(() => { settled = true; });
  try {
    await arrived;
    expect(f.heldIssueReads).toHaveLength(1);
    expect(updating.mock.calls.some(([id]) => id === last.workspaceId)).toBe(false);
    const local = Object.values((await new StateStore(join(f.home, "multica-provider")).read()).connections)[0];
    expect(local.issues["second-1"].title).not.toContain("第二项");
    release();
    await expect.poll(() => f.native.workspaces.find(workspace => workspace.id === last.workspaceId)!.title).toContain("第二项");
    await expect.poll(async () => (await f.server.rpc(connectionStatus, {}, f.paseo)).sync.completedWorkspaces).toBe(1);
    expect((await f.server.rpc(connectionStatus, {}, f.paseo)).sync).toMatchObject({ status: "syncing", stage: "issues", enabledWorkspaces: 2 });
    expect(settled).toBe(false);
    expect(f.native.workspaces[0].title).not.toContain("等待第一个工作区");
  } finally {
    release(); f.remote.holdIssueReads = false;
    for (const reply of f.heldIssueReads.splice(0)) reply();
    await syncing;
  }
  expect((await f.server.rpc(connectionStatus, {}, f.paseo)).sync).toMatchObject({ status: "ready", completedWorkspaces: 2, enabledWorkspaces: 2 });
  expect(f.native.workspaces[0].title).toContain("等待第一个工作区");
});

it("bounds parallel snapshots at four and waits for every in-flight worker after a fatal daemon mismatch before closing", async () => {
  const f = await fixture(60_000); f.remote.acknowledgeEvents = false;
  await f.server.syncRpc(enable, { workspaceId: "remote-workspace", enabled: true }, f.paseo);
  await enableSecondWorkspace(f);
  for (let i = 3; i <= 5; i++) {
    const id = `workspace-${i}`;
    f.workspaces.push({ id, name: id, slug: id });
    f.workspaceIssues.set(id, f.issues.map(issue => ({ ...issue, id: `${id}-${issue.id}`, workspace_id: id })));
    await f.server.syncRpc(enable, { workspaceId: id, enabled: true }, f.paseo);
  }
  let mismatch = false, fatalChecks = 0;
  const list = f.host.listHosts.bind(f.host);
  vi.spyOn(f.host, "listHosts").mockImplementation(async () => {
    const result = await list(); if (mismatch) { result.self.serverId = "different-daemon"; fatalChecks++; } return result;
  });
  f.remote.holdIssueReads = true; f.remote.issueStatus = 503;
  const before = f.scopes.length;
  const writes = vi.spyOn(f.host, "addProject");
  let closing: Promise<void> | undefined, closed = false;
  try {
    await f.server.rpc(workspaceRule, { workspaceId: "remote-workspace", rule: taskRuleSchema.parse({}) }, f.paseo);
    await expect.poll(() => f.heldIssueReads.length).toBe(4);
    mismatch = true;
    const index = f.heldIssueReads.findIndex(reply => reply.slug === "product");
    expect(index).toBeGreaterThanOrEqual(0); f.heldIssueReads.splice(index, 1)[0]();
    await expect.poll(() => fatalChecks).toBeGreaterThan(0);
    closing = Promise.resolve(f.dispose()).then(() => { closed = true; });
    await new Promise(resolve => setTimeout(resolve, 30));
    expect(closed).toBe(false);
    expect((await f.server.rpc(connectionStatus, {}, f.paseo)).sync.status).toBe("syncing");
    expect(writes).not.toHaveBeenCalled();
    expect(f.scopes.slice(before).filter(scope => scope.path.startsWith("/api/issues?")).map(scope => scope.slug).sort()).toEqual(["product", "second", "workspace-3", "workspace-4"]);
  } finally {
    f.remote.holdIssueReads = false;
    for (const reply of f.heldIssueReads.splice(0)) reply();
    await closing;
  }
  expect(closed).toBe(true); expect(writes).not.toHaveBeenCalled();
  const saved = await readFile(join(f.home, "multica-provider/state.json"), "utf8");
  await new Promise(resolve => setTimeout(resolve, 30));
  expect(await readFile(join(f.home, "multica-provider/state.json"), "utf8")).toBe(saved);
  expect(f.scopes.slice(before).some(scope => scope.slug === "workspace-5")).toBe(false);
});

it.each(["pagination", "missing"])("isolates a %s failure to one Multica workspace, retains its cache and clears partial status after recovery", async failure => {
  const f = await fixture(60_000);
  f.remote.acknowledgeEvents = false; // Observe the explicit full pass without a reconnect's later scoped auth_ack pass.
  await f.server.syncRpc(enable, { workspaceId: "remote-workspace", enabled: true }, f.paseo);
  const second = await enableSecondWorkspace(f);
  const before = (await f.server.rpc(connectionStatus, {}, f.paseo)).sync;
  const original = f.workspaces[0];
  const name = failure === "pagination" ? "已改名的产品开发" : "产品开发";
  if (failure === "pagination") { original.name = name; f.remote.nextPageFails = true; f.remote.failingWorkspace = "product"; }
  else f.workspaces.shift();
  f.issues[0].status_category = "done";
  // Keep a two-page snapshot, even with the cached task no longer matching.
  f.issues.push({ ...f.issues[1], id: "new-primary" });
  second[0].title = "第二个 Multica 工作区继续完成";
  await resync(f.server, f.paseo, "second-workspace");
  const status = (await f.server.rpc(connectionStatus, {}, f.paseo)).sync;
  expect(status).toMatchObject({ status: "unavailable", completedWorkspaces: 1, enabledWorkspaces: 2, lastSuccessAt: before.lastSuccessAt,
    message: `1 个 Multica 工作区同步失败：${name}`, failedWorkspaces: [{ workspaceId: "remote-workspace", name, message: expect.stringContaining(failure === "pagination" ? "HTTP 503" : "权限") }] });
  const local = Object.values((await new StateStore(join(f.home, "multica-provider")).read()).connections)[0];
  expect(local.issues["issue-one"].archiveReason).toBeUndefined();
  expect(local.issues["new-primary"]).toBeUndefined();
  expect(local.issues["second-0"].title).toContain("继续完成");
  expect(f.effects).toEqual([]);
  f.remote.issueStatus = 503;
  await resync(f.server, f.paseo, "second-workspace");
  expect((await f.server.rpc(connectionStatus, {}, f.paseo)).sync).toMatchObject({ status: "unavailable", lastSuccessAt: before.lastSuccessAt,
    message: `2 个 Multica 工作区同步失败：${name}、第二个 Multica 工作区`, failedWorkspaces: [
      { workspaceId: "remote-workspace", name }, { workspaceId: "second-workspace", name: "第二个 Multica 工作区" },
    ] });
  f.remote.issueStatus = 200;
  f.remote.nextPageFails = false;
  if (failure === "missing") f.workspaces.unshift(original);
  await resync(f.server, f.paseo, "second-workspace");
  expect((await f.server.rpc(connectionStatus, {}, f.paseo)).sync).toMatchObject({ status: "ready", completedWorkspaces: 2 });
  expect((await f.server.rpc(connectionStatus, {}, f.paseo)).sync.failedWorkspaces).toBeUndefined();
});

it("a missing Multica workspace without a cached project name falls back to its ID in the failure summary", async () => {
  const f = await fixture(60_000);
  const add = vi.spyOn(f.host, "addProject").mockRejectedValue(new Error("Import unavailable"));
  try {
    expect(await f.server.syncRpc(enable, { workspaceId: "remote-workspace", enabled: true }, f.paseo)).toMatchObject({ status: "unavailable" });
    add.mockRestore();
    f.workspaces.shift();
    await enableSecondWorkspace(f);
    expect((await f.server.rpc(connectionStatus, {}, f.paseo)).sync).toMatchObject({ status: "unavailable", completedWorkspaces: 1,
      message: "1 个 Multica 工作区同步失败：remote-workspace", failedWorkspaces: [{ workspaceId: "remote-workspace", name: "remote-workspace" }] });
  } finally { add.mockRestore(); }
});

it("revoking the CLI identity makes all concurrent snapshots yield without continuing pagination or writes", async () => {
  const f = await fixture(60_000); f.remote.acknowledgeEvents = false;
  await f.server.syncRpc(enable, { workspaceId: "remote-workspace", enabled: true }, f.paseo);
  await enableSecondWorkspace(f);
  f.remote.holdIssueReads = true;
  const before = f.scopes.length;
  try {
    await f.server.rpc(workspaceRule, { workspaceId: "remote-workspace", rule: taskRuleSchema.parse({}) }, f.paseo);
    await expect.poll(() => f.heldIssueReads.length).toBe(2);
    const path = join(f.home, ".multica/config.json");
    const config = JSON.parse(await readFile(path, "utf8"));
    await writeFile(path, JSON.stringify({ ...config, token: "replacement-token" }));
  } finally {
    f.remote.holdIssueReads = false;
    for (const reply of f.heldIssueReads.splice(0)) reply();
  }
  const status = await waitForSync(f.server, f.paseo);
  expect(status).toMatchObject({ status: "unavailable", message: expect.stringContaining("同步失败；已保存的规则与开关不受影响") });
  expect(status.failedWorkspaces).toBeUndefined();
  expect(f.scopes.slice(before).filter(scope => scope.path.startsWith("/api/issues?")).map(scope => scope.slug).sort()).toEqual(["product", "second"]);
});

it("superseded parallel snapshots all settle before a new pass applies the latest rule", async () => {
  const f = await fixture(60_000); f.remote.acknowledgeEvents = false;
  await f.server.syncRpc(enable, { workspaceId: "remote-workspace", enabled: true }, f.paseo);
  const second = await enableSecondWorkspace(f);
  second[0].title = "最新轮次"; f.issues[0].title = "旧轮次不应写入";
  f.remote.holdIssueReads = true;
  const before = f.scopes.length;
  try {
    await f.server.rpc(workspaceRule, { workspaceId: "remote-workspace", rule: taskRuleSchema.parse({}) }, f.paseo);
    await expect.poll(() => f.heldIssueReads.length).toBe(2);
    await f.server.rpc(workspaceRule, { workspaceId: "remote-workspace", rule: taskRuleSchema.parse({ labelIds: ["blue"] }) }, f.paseo);
    f.heldIssueReads.shift()!();
    await new Promise(resolve => setTimeout(resolve, 30));
    expect(f.scopes.slice(before).filter(scope => scope.path.startsWith("/api/issues?")).map(scope => scope.slug).sort()).toEqual(["product", "second"]);
    expect(f.heldIssueReads).toHaveLength(1);
    const local = Object.values((await new StateStore(join(f.home, "multica-provider")).read()).connections)[0];
    expect(local.issues["issue-one"].title).not.toContain("不应写入");
    expect(local.issues["second-0"].title).not.toContain("最新轮次");
  } finally {
    f.remote.holdIssueReads = false;
    for (const reply of f.heldIssueReads.splice(0)) reply();
  }
  expect((await waitForSync(f.server, f.paseo)).status).toBe("ready");
  expect(f.native.workspaces.find(workspace => workspace.title.includes("最新轮次"))).toBeDefined();
});

it("reimport continues after a workspace import fails, lists it in the failed rebuild and hides raw errors", async () => {
  const f = await fixture(60_000);
  await f.server.syncRpc(enable, { workspaceId: "remote-workspace", enabled: true }, f.paseo);
  await enableSecondWorkspace(f);
  const connectionKey = (await f.server.rpc(connectionStatus, {}, f.paseo)).connectionKey!;
  const add = f.host.addProject.bind(f.host);
  const failedCwd = f.native.projects[0].cwd;
  let fail = true;
  f.host.addProject = async (...args) => { if (fail && args[0] === failedCwd) { fail = false; throw new Error("private-token raw upstream body"); } return add(...args); };
  await f.server.rpc(rebuildStart, { connectionKey }, f.paseo);
  const result = await finishRebuild(f.server, f.paseo, connectionKey);
  expect(result).toMatchObject({ status: "failed", stage: "importing", completed: 2, total: 4, message: expect.stringContaining("产品开发") });
  expect(result.message).not.toContain("remote-workspace");
  expect(result.message).not.toContain("private-token");
  expect(f.native.agents.some(agent => agent.labels["multica.issue"] === "second-0")).toBe(true);
});

it("reimport preparation stays strict when an enabled Multica workspace is missing", async () => {
  const f = await fixture(60_000);
  await f.server.syncRpc(enable, { workspaceId: "remote-workspace", enabled: true }, f.paseo);
  await enableSecondWorkspace(f);
  const connectionKey = (await f.server.rpc(connectionStatus, {}, f.paseo)).connectionKey!;
  f.workspaces.shift();
  await f.server.rpc(rebuildStart, { connectionKey }, f.paseo);
  expect(await finishRebuild(f.server, f.paseo, connectionKey)).toMatchObject({ status: "failed", stage: "importing", completed: 0 });
  await waitForSync(f.server, f.paseo);
});

it("keeps cached tasks and reports incomplete recovery when an enabled workspace is absent from the accessible snapshot", async () => {
  const f = await fixture();
  await f.server.syncRpc(enable, { workspaceId: "remote-workspace", enabled: true }, f.paseo);
  const ids = f.native.agents.map(agent => agent.id);
  f.workspaces.splice(0);
  expect(await resync(f.server, f.paseo, "remote-workspace")).toMatchObject({ status: "unavailable" });
  expect(f.native.agents.map(agent => agent.id)).toEqual(ids);
  expect(f.native.workspaces.every(workspace => !workspace.archived)).toBe(true);
});

it("repeated successful bootstrap checks the daemon without requesting another remote snapshot", async () => {
  const f = await fixture(60_000);
  await f.server.syncRpc(enable, { workspaceId: "remote-workspace", enabled: true }, f.paseo);
  await new Promise(resolve => setTimeout(resolve, 70));
  const before = f.requests.length;
  await Promise.all([f.server.syncRpc(bootstrap, {}, f.paseo), f.server.syncRpc(bootstrap, {}, f.paseo)]);
  expect(f.requests).toHaveLength(before);
});

it("writes imported discussion metadata without scanning the directory again", async () => {
  const f = await fixture();
  await f.server.syncRpc(enable, { workspaceId: "remote-workspace", enabled: true }, f.paseo);
  const host = metadataHost(f.native.agents);
  await f.server.syncRpc(bootstrap, {}, host.paseo);
  await vi.waitFor(() => expect(host.writes).toHaveLength(2));
  f.issues.push({ ...f.issues[0], id: "new-issue", identifier: "PRD-3" });
  await resync(f.server, f.paseo, "remote-workspace");
  const agent = f.native.agents.find(agent => agent.labels["multica.issue"] === "new-issue")!;
  expect(host.writes).toContainEqual({ agentId: agent.id, patch: { "multica.connection": agent.labels["multica.connection"], "multica.issue": "new-issue" } });
  expect(host.listings).toHaveLength(1);
});

async function promptly<T>(operation: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([operation, new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error("RPC waited for background sync")), 1_000);
    })]);
  } finally { clearTimeout(timer); }
}

it.each([{ labels: [] }, { labels: ["blue"] }])("saves rules and switches promptly while an old snapshot is blocked: %j", async ({ labels }) => {
  const f = await fixture(60_000);
  await f.server.syncRpc(enable, { workspaceId: "remote-workspace", enabled: true }, f.paseo);
  const archive = vi.spyOn(f.host, "archiveWorkspace");
  const rule = taskRuleSchema.parse({ labelIds: labels });
  f.remote.holdIssueReads = true;
  try {
    expect(await promptly(f.server.rpc(workspaceRule, { workspaceId: "remote-workspace", rule }, f.paseo))).toMatchObject({ status: "saved", sync: { status: "syncing" } });
    await expect.poll(() => f.heldIssueReads.length).toBe(1);
    // All requests arrive before any of them finishes validation. The last rule wins.
    const updates = ["blue", "blue", "red"].map(label => promptly(f.server.rpc(workspaceRule,
      { workspaceId: "remote-workspace", rule: { ...rule, labelIds: [label] } }, f.paseo)));
    expect((await Promise.all(updates)).map(result => result.status)).toEqual(["saved", "saved", "saved"]);
    for (const enabled of [false, true]) {
      expect(await promptly(f.server.rpc(workspaceEnable, { workspaceId: "remote-workspace", enabled }, f.paseo))).toMatchObject({ status: "saved", sync: { status: "syncing" } });
    }
    expect(await promptly(f.server.rpc(bootstrap, {}, f.paseo))).toEqual({ status: "ready" });
    expect((await f.server.rpc(workspaceList, {}, f.paseo)).workspaces[0]).toMatchObject({ enabled: true, rule: { labelIds: ["red"] } });
    const disk = JSON.parse(await readFile(join(f.home, "multica-provider", "state.json"), "utf8")) as LocalState;
    expect(Object.values(disk.connections)[0].rules["remote-workspace"]).toMatchObject({ enabled: true, labelIds: ["red"] });
    expect((await f.server.rpc(connectionStatus, {}, f.paseo)).sync).toMatchObject({ status: "syncing", stage: "issues" });
    expect(archive).not.toHaveBeenCalled();
  } finally {
    f.remote.holdIssueReads = false;
    for (const reply of f.heldIssueReads.splice(0)) reply();
  }
  expect(await waitForSync(f.server, f.paseo)).toMatchObject({ status: "ready" });
  // A superseded snapshot must never archive the task now matched by red.
  expect(archive.mock.calls.map(([id]) => id)).toEqual([f.native.workspaces[1].id]);
  expect(f.native.workspaces.map(item => !!item.archived)).toEqual([false, true]);
});

it("keeps a saved rule readable after background failure and reloads it on restart", async () => {
  const f = await fixture(60_000);
  await f.server.syncRpc(enable, { workspaceId: "remote-workspace", enabled: true }, f.paseo);
  f.remote.invalidIssuePage = true;
  const rule = taskRuleSchema.parse({ labelIds: ["red"] });
  expect(await f.server.rpc(workspaceRule, { workspaceId: "remote-workspace", rule }, f.paseo)).toMatchObject({ status: "saved", sync: { status: "syncing" } });
  expect(await waitForSync(f.server, f.paseo)).toMatchObject({ status: "unavailable", stage: "idle", message: "1 个 Multica 工作区同步失败：产品开发", failedWorkspaces: [{ workspaceId: "remote-workspace", name: "产品开发", message: expect.any(String) }] });
  expect((await f.server.rpc(workspaceList, {}, f.paseo)).workspaces[0]).toMatchObject({ enabled: true, rule });
  expect(f.native.workspaces.every(item => !item.archived)).toBe(true);
  await f.dispose();
  const restarted = f.start();
  expect((await restarted.server.rpc(workspaceList, {}, f.paseo)).workspaces[0]).toMatchObject({ enabled: true, rule });
});

it.each([true, false])("saves rapid disable/enable switches while archive is blocked (final enabled=%s)", async finalEnabled => {
  const f = await fixture(60_000);
  await f.server.syncRpc(enable, { workspaceId: "remote-workspace", enabled: true }, f.paseo);
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const archive = f.host.archiveWorkspace.bind(f.host);
  const held = vi.spyOn(f.host, "archiveWorkspace").mockImplementation(async (...args) => { await gate; return archive(...args); });
  const remove = vi.spyOn(f.host, "removeProject");
  try {
    expect(await promptly(f.server.rpc(workspaceEnable, { workspaceId: "remote-workspace", enabled: false }, f.paseo))).toMatchObject({ status: "saved" });
    await expect.poll(() => held.mock.calls.length).toBe(1);
    expect((await f.server.rpc(connectionStatus, {}, f.paseo)).sync).toMatchObject({ status: "syncing", stage: "archiving", completedArchives: 0, pendingArchives: 2 });
    expect((await f.server.rpc(workspaceList, {}, f.paseo)).workspaces[0].enabled).toBe(false);
    expect(await promptly(f.server.rpc(workspaceEnable, { workspaceId: "remote-workspace", enabled: true }, f.paseo))).toMatchObject({ status: "saved" });
    if (!finalEnabled) expect(await promptly(f.server.rpc(workspaceEnable, { workspaceId: "remote-workspace", enabled: false }, f.paseo))).toMatchObject({ status: "saved" });
    expect(remove).not.toHaveBeenCalled();
  } finally { release(); }
  expect(await waitForSync(f.server, f.paseo)).toMatchObject({ status: "ready", pendingArchives: 0 });
  expect((await f.server.rpc(workspaceList, {}, f.paseo)).workspaces[0].enabled).toBe(finalEnabled);
  expect(f.native.workspaces.filter(item => !item.archived)).toHaveLength(finalEnabled ? 2 : 0);
  if (finalEnabled) { expect(held).toHaveBeenCalledTimes(1); expect(remove).not.toHaveBeenCalled(); }
  // Subsequent idle passes do not claim that completed archives are in progress.
  const stages: string[] = [];
  const listing = f.host.listProjects.bind(f.host);
  f.host.listProjects = async () => { stages.push((await f.server.rpc(connectionStatus, {}, f.paseo)).sync.stage); return listing(); };
  await resync(f.server, f.paseo, "remote-workspace");
  expect(stages).not.toContain("archiving");
});

it.each([true, false])("saves enable immediately during native import and honors the latest switch (final enabled=%s)", async finalEnabled => {
  const f = await fixture(60_000);
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const importing = f.host.importAgent.bind(f.host);
  const held = vi.spyOn(f.host, "importAgent").mockImplementation(async (...args) => { await gate; return importing(...args); });
  try {
    expect(await promptly(f.server.rpc(workspaceEnable, { workspaceId: "remote-workspace", enabled: true }, f.paseo))).toMatchObject({ status: "saved", sync: { status: "syncing" } });
    await expect.poll(() => held.mock.calls.length).toBe(1);
    expect(await promptly(f.server.rpc(workspaceEnable, { workspaceId: "remote-workspace", enabled: false }, f.paseo))).toMatchObject({ status: "saved" });
    if (finalEnabled) expect(await promptly(f.server.rpc(workspaceEnable, { workspaceId: "remote-workspace", enabled: true }, f.paseo))).toMatchObject({ status: "saved" });
  } finally { release(); }
  expect(await waitForSync(f.server, f.paseo)).toMatchObject({ status: "ready" });
  expect((await f.server.rpc(workspaceList, {}, f.paseo)).workspaces[0].enabled).toBe(finalEnabled);
  expect(f.native.workspaces.filter(item => !item.archived)).toHaveLength(finalEnabled ? 2 : 0);
  expect(f.native.agents.filter(item => !item.archivedAt)).toHaveLength(finalEnabled ? 2 : 0);
});

it("can save disable for a locally known workspace while the remote workspace list is unavailable", async () => {
  const f = await fixture(60_000);
  await f.server.syncRpc(enable, { workspaceId: "remote-workspace", enabled: true }, f.paseo);
  f.remote.workspacesStatus = 503;
  const before = f.requests.length;
  expect(await promptly(f.server.rpc(workspaceEnable, { workspaceId: "remote-workspace", enabled: false }, f.paseo))).toMatchObject({ status: "saved" });
  expect(await waitForSync(f.server, f.paseo)).toMatchObject({ status: "ready" });
  expect(f.requests.slice(before)).not.toContain("/api/workspaces");
  expect(f.native.workspaces.every(item => item.archived)).toBe(true);
  expect(await f.server.rpc(workspaceEnable, { workspaceId: "unknown", enabled: false }, f.paseo)).toMatchObject({ status: "unavailable", message: expect.stringContaining("保存失败") });
  expect(await f.server.rpc(workspaceEnable, { workspaceId: "remote-workspace", enabled: true }, f.paseo)).toMatchObject({ status: "unavailable" });
});

it("reports archive failure separately from the saved disabled switch and recovers on retry", async () => {
  const f = await fixture(60_000);
  await f.server.syncRpc(enable, { workspaceId: "remote-workspace", enabled: true }, f.paseo);
  vi.spyOn(f.host, "archiveWorkspace").mockRejectedValueOnce(new Error("native archive unavailable"));
  expect(await f.server.rpc(workspaceEnable, { workspaceId: "remote-workspace", enabled: false }, f.paseo)).toMatchObject({ status: "saved" });
  expect(await waitForSync(f.server, f.paseo)).toMatchObject({ status: "unavailable", stage: "archiving", pendingArchives: 2 });
  expect((await f.server.rpc(workspaceList, {}, f.paseo)).workspaces[0]).toMatchObject({ enabled: false });
  expect(await resync(f.server, f.paseo, "remote-workspace")).toEqual({ status: "ready" });
  expect(f.native.workspaces.every(item => item.archived)).toBe(true);
});

it("resets the returned sync progress before waiting behind a native operation", async () => {
  const f = await fixture(60_000);
  await f.server.syncRpc(enable, { workspaceId: "remote-workspace", enabled: true }, f.paseo);
  expect((await f.server.rpc(connectionStatus, {}, f.paseo)).sync).toMatchObject({ stage: "idle", completedWorkspaces: 1 });
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const fetch = f.host.fetchWorkspaces.bind(f.host);
  const held = vi.spyOn(f.host, "fetchWorkspaces").mockImplementation(async (...args) => { await gate; return fetch(...args); });
  const restoring = f.server.rpc(hiddenRestore, { connectionKey: f.native.agents[0].labels["multica.connection"], issueId: "issue-one" }, f.paseo);
  try {
    await expect.poll(() => held.mock.calls.length).toBe(1);
    const rule = await promptly(f.server.rpc(workspaceRule, { workspaceId: "remote-workspace", rule: taskRuleSchema.parse({}) }, f.paseo));
    expect(rule).toMatchObject({ status: "saved", sync: { status: "syncing", stage: "connection", completedWorkspaces: 0, completedArchives: 0, pendingArchives: 0 } });
    const disabled = await promptly(f.server.rpc(workspaceEnable, { workspaceId: "remote-workspace", enabled: false }, f.paseo));
    expect(disabled).toMatchObject({ status: "saved", sync: { status: "syncing", stage: "connection", completedWorkspaces: 0, completedArchives: 0, pendingArchives: 0 } });
  } finally { release(); await restoring; held.mockRestore(); }
  expect(await waitForSync(f.server, f.paseo)).toMatchObject({ status: "ready", pendingArchives: 0 });
});

it("does not subscribe a workspace disabled while its old workspace snapshot is in flight", async () => {
  const f = await fixture(60_000);
  await f.server.syncRpc(enable, { workspaceId: "remote-workspace", enabled: true }, f.paseo);
  await f.dispose();
  const restarted = f.start();
  const reads = () => f.requests.filter(path => path === "/api/workspaces").length;
  const before = reads();
  f.remote.holdWorkspaceReads = true;
  const reconcile = vi.spyOn(WorkspaceEvents.prototype, "reconcile");
  try {
    await restarted.server.rpc(bootstrap, {}, f.paseo);
    await expect.poll(reads).toBe(before + 1);
    expect(await promptly(restarted.server.rpc(workspaceEnable, { workspaceId: "remote-workspace", enabled: false }, f.paseo))).toMatchObject({ status: "saved" });
    f.remote.holdWorkspaceReads = false;
    for (const reply of f.heldWorkspaceReads.splice(0)) reply();
    expect(await waitForSync(restarted.server, f.paseo)).toMatchObject({ status: "ready" });
    expect(reconcile.mock.calls.length).toBeGreaterThan(0);
    expect(reconcile.mock.calls.every(([, workspaces]) => workspaces.length === 0)).toBe(true);
  } finally {
    f.remote.holdWorkspaceReads = false;
    for (const reply of f.heldWorkspaceReads.splice(0)) reply();
    reconcile.mockRestore();
  }
});

async function finishRebuild(server: FakeServer, paseo: PaseoApi, connectionKey: string) {
  await expect.poll(async () => (await server.rpc(rebuildStatus, { connectionKey }, paseo)).status).not.toBe("running");
  return server.rpc(rebuildStatus, { connectionKey }, paseo);
}

async function cachedRebuildFixture(issueId = "issue-one") {
  const f = await fixture(60_000);
  f.runs.push({ id: "cached-run", issue_id: issueId, agent_id: "agent-owned", status: "running" });
  await f.server.syncRpc(enable, { workspaceId: "remote-workspace", enabled: true }, f.paseo);
  const connectionKey = (await f.server.rpc(connectionStatus, {}, f.paseo)).connectionKey!;
  await f.dispose();
  return { ...f, connectionKey, store: new StateStore(join(f.home, "multica-provider")) };
}

it("rebuild preflight and start recheck every cached active Run and report its latest status without persisting active changes", async () => {
  const f = await fixture();
  f.runs.push(...["queued", "dispatched", "running", "waiting_local_directory", "deferred"].map((status, index) => ({ id: `run-${index}`, issue_id: "issue-one", agent_id: "agent-owned", status })));
  await f.server.syncRpc(enable, { workspaceId: "remote-workspace", enabled: true }, f.paseo);
  const connectionKey = (await f.server.rpc(connectionStatus, {}, f.paseo)).connectionKey!;
  const cachedStatuses = f.runs.map(run => run.status);
  f.runs[0].status = "running";
  const before = f.requests.length;
  const preview = await f.server.rpc(rebuildPreflight, { connectionKey }, f.paseo);
  expect(preview).toMatchObject({ projects: 1, workspaces: 2, discussions: 2, blockers: [{ title: "PRD-1 实现登录", discussion: "主讨论", runs: f.runs.map(run => ({ runId: run.id, status: run.status, agentName: "Builder", verification: "active" })) }] });
  expect(f.requests.slice(before)).toEqual(["/api/issues/issue-one/task-runs?view=timeline"]);
  const cached = (await new StateStore(join(f.home, "multica-provider")).read()).connections[connectionKey].issues["issue-one"].runs;
  expect(Object.values(cached).map(run => run.status)).toEqual(cachedStatuses);
  expect(await f.server.rpc(rebuildStart, { connectionKey }, f.paseo)).toMatchObject({ started: false, blockers: preview.blockers });
  expect(await f.server.rpc(rebuildStart, { connectionKey, acknowledgedRunIds: f.runs.map(run => run.id) }, f.paseo)).toMatchObject({ started: false, blockers: preview.blockers });
  expect(f.effects).toEqual([]);
  expect(f.requests.some(path => path.endsWith("/cancel"))).toBe(false);
  await expect(f.server.rpc(rebuildStart, { connectionKey: "other" }, f.paseo)).rejects.toThrow("连接已变化");
  f.remote.authStatus = 401;
  await writeFile(join(f.home, ".multica/config.json"), "{}");
  await expect(f.server.rpc(rebuildPreflight, { connectionKey }, f.paseo)).rejects.toThrow("unavailable");
});

it.each(["hidden", "filter_exit", "rule_disabled"] as const)("rebuild settles stale active Runs in %s tasks without changing ownership or other Run fields", async kind => {
  const f = await cachedRebuildFixture();
  await f.store.update(state => {
    const issue = state.connections[f.connectionKey].issues["issue-one"];
    if (kind === "hidden") issue.manualHidden = { workspace: true, discussions: ["main"] };
    else issue.archiveReason = kind;
    issue.runs["cached-run"].metadata = { error: "old", failure_reason: "preserved", work_dir: "cached", relative_work_dir: "relative" };
    issue.runs.terminal = { ...issue.runs["cached-run"], status: "completed" };
  });
  const previous = structuredClone((await f.store.read()).connections[f.connectionKey].issues["issue-one"].runs);
  f.runs[0] = { ...f.runs[0], agent_id: "changed-agent", status: "failed", completed_at: "2026-11-26T12:00:00Z", error: null, work_dir: "" };
  f.runs.push({ ...f.runs[0], id: "terminal" }, { ...f.runs[0], id: "not-cached", status: "running" });
  const observer = vi.spyOn(RunSynchronizer.prototype, "observe");
  try {
    const restarted = f.start(), before = f.requests.length;
    expect(await restarted.server.rpc(rebuildPreflight, { connectionKey: f.connectionKey }, f.paseo)).toMatchObject({ blockers: [] });
    expect(f.requests.slice(before).filter(path => path !== "/api/me")).toEqual(["/api/issues/issue-one/task-runs?view=timeline"]);
    const saved = (await new StateStore(f.store.directory).read()).connections[f.connectionKey].issues["issue-one"].runs;
    expect(saved).toEqual({ ...previous, "cached-run": { ...previous["cached-run"], status: "failed", completedAt: f.runs[0].completed_at,
      metadata: { error: null, failure_reason: "preserved", work_dir: "", relative_work_dir: "relative" } } });
    expect(observer).toHaveBeenCalledWith({ connectionKey: f.connectionKey, issueId: "issue-one", rootId: "main" });
    expect(await restarted.server.rpc(rebuildStart, { connectionKey: f.connectionKey }, f.paseo)).toMatchObject({ started: true });
    expect(await finishRebuild(restarted.server, f.paseo, f.connectionKey)).toMatchObject({ status: "completed" });
    expect(f.requests.some(path => path.endsWith("/cancel"))).toBe(false);
  } finally { observer.mockRestore(); }
});

it.each(["issue404", "workspace403", "missingRun", "missingWorkspace"])("rebuild requires explicit acknowledgement for %s and never cancels remote Runs", async kind => {
  const f = await cachedRebuildFixture();
  await f.store.update(state => {
    const local = state.connections[f.connectionKey];
    local.rules["remote-workspace"].enabled = false;
    if (kind === "missingWorkspace") delete local.projects["remote-workspace"].slug;
  });
  if (kind === "issue404") f.runResponses.set("issue-one", { status: 404 });
  if (kind === "workspace403") f.runResponses.set("issue-one", { status: 403 });
  if (kind === "missingRun") f.runs.length = 0;
  if (kind === "missingWorkspace") f.workspaces.length = 0;
  const { server } = f.start(), input = { connectionKey: f.connectionKey };
  const preview = await server.rpc(rebuildPreflight, input, f.paseo);
  expect(preview.blockers).toMatchObject([{ runs: [{ runId: "cached-run", verification: "unconfirmable", reason: expect.any(String) }] }]);
  expect(await server.rpc(rebuildStart, input, f.paseo)).toMatchObject({ started: false, blockers: preview.blockers });
  expect(await server.rpc(rebuildStart, { ...input, acknowledgedRunIds: ["other-run"] }, f.paseo)).toMatchObject({ started: false });
  expect(f.effects).toEqual([]);
  expect(await server.rpc(rebuildStart, { ...input, acknowledgedRunIds: ["cached-run"] }, f.paseo)).toMatchObject({ started: true });
  expect(await finishRebuild(server, f.paseo, f.connectionKey)).toMatchObject({ status: "completed", total: 0 });
  expect(f.requests.some(path => path.endsWith("/cancel"))).toBe(false);
});

it.each(["run503", "schema", "network", "workspace503", "workspaceList403"])("rebuild only permits retry after %s, even for acknowledged Runs", async kind => {
  const f = await cachedRebuildFixture();
  if (kind === "run503") f.runResponses.set("issue-one", { status: 503 });
  if (kind === "schema") f.runResponses.set("issue-one", { status: 200, body: [{ ...f.runs[0], status: "unknown" }] });
  if (kind === "network") f.remote.disconnectRuns = true;
  if (kind === "workspace503" || kind === "workspaceList403") {
    await f.store.update(state => { delete state.connections[f.connectionKey].projects["remote-workspace"].slug; });
    f.remote.workspacesStatus = kind === "workspaceList403" ? 403 : 503;
  }
  const { server } = f.start(), input = { connectionKey: f.connectionKey };
  const preview = await server.rpc(rebuildPreflight, input, f.paseo);
  expect(preview.blockers).toMatchObject([{ runs: [{ verification: "failed", reason: expect.any(String) }] }]);
  expect(await server.rpc(rebuildStart, { ...input, acknowledgedRunIds: ["cached-run"] }, f.paseo)).toMatchObject({ started: false, blockers: preview.blockers });
  expect(f.effects).toEqual([]);
  f.runResponses.clear(); f.remote.disconnectRuns = false; f.remote.workspacesStatus = 200; f.runs[0].status = "completed";
  expect(await server.rpc(rebuildPreflight, input, f.paseo)).toMatchObject({ blockers: [] });
  expect(f.requests.some(path => path.endsWith("/cancel"))).toBe(false);
});

it("rebuild resolves missing workspace slugs once and requests candidate Issues serially", async () => {
  const f = await cachedRebuildFixture();
  await f.store.update(state => {
    const local = state.connections[f.connectionKey];
    delete local.projects["remote-workspace"].slug;
    local.issues["issue-two"].runs.second = { ...local.issues["issue-one"].runs["cached-run"] };
  });
  f.runs.push({ ...f.runs[0], id: "second", issue_id: "issue-two" });
  const { server } = f.start(), before = f.requests.length;
  f.remote.holdRunReads = true;
  const inspecting = server.rpc(rebuildPreflight, { connectionKey: f.connectionKey }, f.paseo);
  try {
    await expect.poll(() => f.heldRunReads.length).toBe(1);
    expect(f.requests.slice(before).filter(path => path !== "/api/me")).toEqual(["/api/workspaces", "/api/issues/issue-one/task-runs?view=timeline"]);
    f.heldRunReads.shift()!();
    await expect.poll(() => f.heldRunReads.length).toBe(1);
    f.heldRunReads.shift()!();
    expect((await inspecting).blockers).toHaveLength(2);
    expect(f.requests.slice(before).filter(path => path !== "/api/me")).toEqual(["/api/workspaces", "/api/issues/issue-one/task-runs?view=timeline", "/api/issues/issue-two/task-runs?view=timeline"]);
    expect(f.scopes.filter(scope => scope.path.endsWith("task-runs?view=timeline")).every(scope => scope.slug === "product")).toBe(true);
  } finally { f.remote.holdRunReads = false; for (const reply of f.heldRunReads.splice(0)) reply(); await inspecting; }
});

it.each(["preflight", "start"])("rebuild %s fails as a whole if the CLI identity changes during remote verification", async phase => {
  const f = await cachedRebuildFixture();
  const { server } = f.start();
  f.remote.holdRunReads = true;
  const inspecting = phase === "preflight" ? server.rpc(rebuildPreflight, { connectionKey: f.connectionKey }, f.paseo)
    : server.rpc(rebuildStart, { connectionKey: f.connectionKey }, f.paseo);
  const rejected = expect(inspecting).rejects.toThrow("CLI 登录上下文已变化");
  try {
    await expect.poll(() => f.heldRunReads.length).toBe(1);
    await writeFile(join(f.home, ".multica/config.json"), "{}");
  } finally { f.remote.holdRunReads = false; for (const reply of f.heldRunReads.splice(0)) reply(); }
  await rejected;
  expect(f.effects).toEqual([]);
  expect((await new StateStore(f.store.directory).read()).connections[f.connectionKey].issues["issue-one"].runs["cached-run"].status).toBe("running");
  expect(f.requests.some(path => path.endsWith("/cancel"))).toBe(false);
});

it("rebuild start refuses a new unacknowledged blocker discovered after preflight", async () => {
  const f = await cachedRebuildFixture();
  f.runResponses.set("issue-one", { status: 404 });
  const restarted = f.start(), input = { connectionKey: f.connectionKey };
  expect((await restarted.server.rpc(rebuildPreflight, input, f.paseo)).blockers).toMatchObject([{ runs: [{ runId: "cached-run", verification: "unconfirmable" }] }]);
  await restarted.dispose();
  await f.store.update(state => { state.connections[f.connectionKey].issues["issue-two"].runs.new = { ...state.connections[f.connectionKey].issues["issue-one"].runs["cached-run"] }; });
  const { server } = f.start();
  const result = await server.rpc(rebuildStart, { ...input, acknowledgedRunIds: ["cached-run"] }, f.paseo);
  expect(result).toMatchObject({ started: false, blockers: [{ runs: [{ runId: "cached-run" }] }, { runs: [{ runId: "new", verification: "unconfirmable" }] }] });
  expect(f.effects).toEqual([]);
  expect(f.requests.some(path => path.endsWith("/cancel"))).toBe(false);
});

it("rebuild returns immediately then fails progress before deleting when exclusive finds new blockers from in-flight synchronization", async () => {
  const f = await cachedRebuildFixture("issue-two");
  const { server } = f.start(), input = { connectionKey: f.connectionKey };
  f.runResponses.set("issue-two", { status: 404 });
  expect((await server.rpc(rebuildPreflight, input, f.paseo)).blockers).toMatchObject([{ runs: [{ runId: "cached-run", verification: "unconfirmable" }] }]);
  f.runs.push({ ...f.runs[0], id: "new", issue_id: "issue-one" });
  f.remote.holdRunReads = true;
  const syncing = resync(server, f.paseo, "remote-workspace");
  await expect.poll(() => f.heldRunReads.length).toBe(1);
  const starting = server.rpc(rebuildStart, { ...input, acknowledgedRunIds: ["cached-run"] }, f.paseo);
  try {
    await expect.poll(() => f.heldRunReads.length).toBe(2);
    // Finish the start check while the earlier sync still holds the native queue.
    f.heldRunReads.pop()!();
    expect(await starting).toMatchObject({ started: true, blockers: [], progress: { status: "running", step: "等待后台同步" } });
    expect(f.heldRunReads).toHaveLength(1);
    expect(f.effects).toEqual([]);
    f.remote.holdRunReads = false;
    f.heldRunReads.shift()!();
    f.runResponses.set("issue-one", { status: 404 });
    const progress = await finishRebuild(server, f.paseo, f.connectionKey);
    expect(progress).toMatchObject({ status: "failed", stage: "deleting", completed: 0, total: 0 });
    expect(progress.message).toContain("PRD-1 实现登录 · 主讨论：new（无法确认）");
    expect(progress.message).toContain("PRD-2 修复同步 · 主讨论：cached-run（无法确认）");
    expect(progress.message).toContain("请重新打开重建以重新复核");
    expect(f.effects).toEqual([]);
    expect(f.requests.some(path => path.endsWith("/cancel"))).toBe(false);
  } finally { f.remote.holdRunReads = false; for (const reply of f.heldRunReads.splice(0)) reply(); await starting; await syncing; }
});

it("rebuild terminal writeback preserves a terminal result written while its remote read was in flight", async () => {
  const f = await cachedRebuildFixture();
  const { server_url: apiUrl } = JSON.parse(await readFile(join(f.home, ".multica/config.json"), "utf8")) as { server_url: string };
  const runs = new RunSynchronizer(f.store);
  f.runs[0].status = "failed";
  f.remote.holdRunReads = true;
  const checking = runs.recheck({ apiUrl, token: "private-token", connectionKey: f.connectionKey, userId: "user-42" }, f.workspaces[0], "issue-one", ["cached-run"]);
  try {
    await expect.poll(() => f.heldRunReads.length).toBe(1);
    await f.store.update(state => {
      const run = state.connections[f.connectionKey].issues["issue-one"].runs["cached-run"];
      run.status = "cancelled"; run.completedAt = "from-concurrent-sync"; run.metadata = { error: "keep" };
    });
    f.heldRunReads.shift()!(); await checking;
    expect((await f.store.read()).connections[f.connectionKey].issues["issue-one"].runs["cached-run"]).toMatchObject({ status: "cancelled", completedAt: "from-concurrent-sync", metadata: { error: "keep" } });
  } finally { f.remote.holdRunReads = false; for (const reply of f.heldRunReads.splice(0)) reply(); await checking; runs.close(); }
});

it.each([
  { rootId: "main", discovery: "omitted from the directory" },
  { rootId: "rebuild-thread", discovery: "omitted from the directory" },
  { rootId: "main", discovery: "missing labels" },
  { rootId: "rebuild-thread", discovery: "missing labels" },
])("rebuild counts, holds and deletes cached $rootId discussions when $discovery", async ({ rootId, discovery }) => {
  const f = await fixture(60_000); f.remote.acknowledgeEvents = false;
  f.comments.push({ id: "rebuild-thread", issue_id: "issue-one", content: "重建讨论" });
  await f.server.syncRpc(enable, { workspaceId: "remote-workspace", enabled: true }, f.paseo);
  const connectionKey = (await f.server.rpc(connectionStatus, {}, f.paseo)).connectionKey!;
  const cached = f.native.agents.find(agent => agent.labels["multica.issue"] === "issue-one" && agent.labels["multica.discussion"] === rootId)!;
  const cwd = cached.cwd;
  await f.dispose();
  const store = new StateStore(join(f.home, "multica-provider"));
  await store.update(state => {
    const local = state.connections[connectionKey];
    local.rules["remote-workspace"].enabled = false;
    local.issues["issue-one"].threads.duplicate = { ...local.issues["issue-one"].threads["rebuild-thread"], agentId: cached.id };
  });
  // The recovered agent's workspace is absent from the cache and has no plugin directory prefix.
  const recoveredWorkspace = { ...f.native.workspaces[0], id: "recovered-workspace", cwd: "/legacy-workspace" };
  f.native.workspaces.push(recoveredWorkspace);
  cached.workspaceId = recoveredWorkspace.id;
  if (discovery === "missing labels") cached.labels = {};
  else {
    cached.cwd = "/legacy-discussion";
    cached.labels = { ...cached.labels, "multica.issue": "stale-issue", "multica.discussion": "stale-root" };
  }
  const list = f.host.fetchAgents.bind(f.host);
  vi.spyOn(f.host, "fetchAgents").mockImplementation(async input => {
    const page = await list(input);
    const entries = page.entries.filter(({ agent }) => discovery === "missing labels" || agent.id !== cached.id);
    return { ...page, entries };
  });
  const { server } = f.start();
  const provider = await server.providers.get("multica")!.connect({ versions: [1], capabilities: [] });
  cleanup.push(() => provider.close());
  const events: ProviderEvent[] = []; provider.onEvent(event => events.push(event));
  const remove = f.host.deleteAgent.bind(f.host);
  vi.spyOn(f.host, "deleteAgent").mockImplementation(async id => {
    if (id === cached.id) await provider.send({ type: "session.open", requestId: "rebuild-racing-open", sessionId: "rebuild-racing-open", history: "replay",
      persistence: JSON.parse(cached.handle.slice(7)), config: { cwd, env: {}, mcpServers: {}, settings: {}, persist: true } });
    return remove(id);
  });
  expect(await server.rpc(rebuildPreflight, { connectionKey }, f.paseo)).toMatchObject({ projects: 1, workspaces: 3, discussions: 3, blockers: [] });
  expect(await server.rpc(rebuildStart, { connectionKey }, f.paseo)).toMatchObject({ started: true });
  expect(await finishRebuild(server, f.paseo, connectionKey)).toMatchObject({ status: "completed", total: 0 });
  expect(f.effects.filter(effect => effect === `deleteAgent:${cached.id}`)).toHaveLength(1);
  expect(f.native.agents.some(agent => agent.id === cached.id)).toBe(false);
  expect(events).toContainEqual(expect.objectContaining({ type: "request.failed", requestId: "rebuild-racing-open", error: expect.objectContaining({ code: "discussion_unavailable" }) }));
  expect(f.effects).toContain(`archiveWorkspace:${recoveredWorkspace.id}`);
});

it.each(["multica.issue", "multica.discussion"])("rebuild deletes uncached plugin discussions and holds cached discussions missing the %s label", async missing => {
  const f = await fixture(60_000); f.remote.acknowledgeEvents = false;
  await f.server.syncRpc(enable, { workspaceId: "remote-workspace", enabled: true }, f.paseo);
  const connectionKey = (await f.server.rpc(connectionStatus, {}, f.paseo)).connectionKey!;
  const cached = f.native.agents[0];
  const orphan = { ...cached, id: "orphan", handle: "orphan", labels: { ...cached.labels } };
  delete cached.labels[missing]; delete orphan.labels[missing];
  f.native.agents.push(orphan);
  const provider = await f.server.providers.get("multica")!.connect({ versions: [1], capabilities: [] });
  cleanup.push(() => provider.close());
  const events: ProviderEvent[] = []; provider.onEvent(event => events.push(event));
  const remove = f.host.deleteAgent.bind(f.host);
  vi.spyOn(f.host, "deleteAgent").mockImplementation(async id => {
    if (id === cached.id) await provider.send({ type: "session.open", requestId: "partial-label-open", sessionId: "partial-label-open", history: "replay",
      persistence: JSON.parse(cached.handle.slice(7)), config: { cwd: cached.cwd, env: {}, mcpServers: {}, settings: {}, persist: true } });
    return remove(id);
  });
  expect(await f.server.rpc(rebuildPreflight, { connectionKey }, f.paseo)).toMatchObject({ projects: 1, workspaces: 2, discussions: 3, blockers: [] });
  expect(await f.server.rpc(rebuildStart, { connectionKey }, f.paseo)).toMatchObject({ started: true });
  expect(await finishRebuild(f.server, f.paseo, connectionKey)).toMatchObject({ status: "completed", completed: 2, total: 2 });
  expect(f.effects.filter(effect => effect === `deleteAgent:${orphan.id}`)).toHaveLength(1);
  expect(f.native.agents.some(agent => agent.id === orphan.id)).toBe(false);
  expect(events).toContainEqual(expect.objectContaining({ type: "request.failed", requestId: "partial-label-open", error: expect.objectContaining({ code: "discussion_unavailable" }) }));
});

it("rebuild deletes discussions including archived orphans before workspaces and projects, preserves rules and only resets its connection", async () => {
  const f = await fixture();
  await f.server.syncRpc(enable, { workspaceId: "remote-workspace", enabled: true }, f.paseo);
  const connectionKey = (await f.server.rpc(connectionStatus, {}, f.paseo)).connectionKey!;
  const store = new StateStore(join(f.home, "multica-provider"));
  await f.dispose();
  await store.update(state => {
    const local = state.connections[connectionKey];
    local.issues["issue-one"].manualHidden = { workspace: true, discussions: ["main"] };
    local.issues["issue-one"].commentRoots.old = "main";
    state.connections.other = structuredClone(local);
  });
  for (const key of [connectionKey, "other"]) {
    await mkdir(store.runDetailsDirectory(key), { recursive: true });
    await writeFile(join(store.runDetailsDirectory(key), "cached.json"), "cached");
  }
  const otherBefore = structuredClone((await store.read()).connections.other);
  const rulesBefore = structuredClone((await store.read()).connections[connectionKey].rules);
  const oldIds = f.native.agents.map(agent => agent.id), oldCreations = [...f.creations];
  f.native.agents[0].archivedAt = "2026-11-24T10:00:00Z";
  f.native.agents.push({ ...f.native.agents[0], id: "orphan", handle: "orphan", labels: { ...f.native.agents[0].labels, "multica.discussion": "orphan" } });
  f.native.agents.push({ ...f.native.agents[0], id: "other-agent", handle: "other-handle", labels: { ...f.native.agents[0].labels, "multica.connection": "other" }, workspaceId: "other-workspace" });
  const restarted = f.start();
  expect(await restarted.server.rpc(rebuildPreflight, { connectionKey }, f.paseo)).toMatchObject({ projects: 1, workspaces: 2, discussions: 3, blockers: [] });
  expect(await restarted.server.rpc(rebuildStart, { connectionKey }, f.paseo)).toMatchObject({ started: true, progress: { status: "running", stage: "deleting" } });
  expect(await finishRebuild(restarted.server, f.paseo, connectionKey)).toMatchObject({ status: "completed", stage: "importing", completed: 2, total: 2 });
  expect(f.effects.slice(0, 3)).toEqual([...oldIds, "orphan"].map(id => `deleteAgent:${id}`));
  expect(f.effects.slice(3, 5).every(effect => effect.startsWith("archiveWorkspace:"))).toBe(true);
  expect(f.effects[5]).toMatch(/^removeProject:/);
  const saved = await new StateStore(store.directory).read();
  expect(saved.owner).toEqual({ profile: "" });
  expect(saved.connections[connectionKey].rebuildGeneration).toBe(1);
  expect(saved.connections.other).toEqual(otherBefore);
  await expect(stat(store.runDetailsDirectory(connectionKey))).rejects.toMatchObject({ code: "ENOENT" });
  expect(await readFile(join(store.runDetailsDirectory("other"), "cached.json"), "utf8")).toBe("cached");
  expect(saved.connections[connectionKey].rules).toEqual(rulesBefore);
  expect(saved.connections[connectionKey].issues["issue-one"].manualHidden).toEqual({ workspace: false, discussions: [] });
  expect(saved.connections[connectionKey].issues["issue-one"].commentRoots).not.toHaveProperty("old");
  expect(f.native.agents.some(agent => agent.id === "other-agent")).toBe(true);
  expect(f.native.agents.filter(agent => oldIds.includes(agent.id))).toEqual([]);
  for (const creation of f.creations.slice(oldCreations.length)) {
    expect(oldCreations.some(old => old.workspaceId === creation.workspaceId || old.idempotencyKey === creation.idempotencyKey)).toBe(false);
  }
  expect(f.requests.every(path => !path.endsWith("/cancel"))).toBe(true);
});

it.each(["missing", "missing its ID"])("rebuild identifies Paseo projects through cached issue.projectId when the project mapping is %s", async mapping => {
  const f = await fixture(60_000); f.remote.acknowledgeEvents = false;
  await f.server.syncRpc(enable, { workspaceId: "remote-workspace", enabled: true }, f.paseo);
  const connectionKey = (await f.server.rpc(connectionStatus, {}, f.paseo)).connectionKey!;
  const project = f.native.projects[0];
  project.cwd = join(f.home, "legacy-project");
  await f.dispose();
  const store = new StateStore(join(f.home, "multica-provider"));
  await store.update(state => {
    const local = state.connections[connectionKey];
    local.rules["remote-workspace"].enabled = false;
    if (mapping === "missing") {
      local.projects = {};
      for (const [issueId, issue] of Object.entries(local.issues)) issue.cwd = join(project.cwd, issueId);
    } else {
      delete local.projects["remote-workspace"].projectId;
      local.projects["remote-workspace"].cwd = project.cwd;
    }
  });
  const { server } = f.start();
  expect(await server.rpc(rebuildPreflight, { connectionKey }, f.paseo)).toMatchObject({ projects: 1, workspaces: 2, discussions: 2, blockers: [] });
  expect(await server.rpc(rebuildStart, { connectionKey }, f.paseo)).toMatchObject({ started: true });
  expect(await finishRebuild(server, f.paseo, connectionKey)).toMatchObject({ status: "completed", total: 0 });
  expect(f.effects.filter(effect => effect === `removeProject:${project.projectId}`)).toHaveLength(1);
  expect(f.native.projects).toEqual([]);
});

it("rebuild preserves a project containing a user workspace and supports cleanup with zero enabled rules", async () => {
  const f = await fixture();
  await f.server.syncRpc(enable, { workspaceId: "remote-workspace", enabled: true }, f.paseo);
  const connectionKey = (await f.server.rpc(connectionStatus, {}, f.paseo)).connectionKey!;
  f.native.workspaces.unshift({ id: "user-workspace", projectId: f.native.projects[0].projectId, cwd: "/user", title: "Mine" });
  f.native.workspacePageSize = 1;
  await f.dispose();
  const store = new StateStore(join(f.home, "multica-provider"));
  await store.update(state => { state.connections[connectionKey].rules["remote-workspace"].enabled = false; });
  const restarted = f.start();
  expect(await restarted.server.rpc(rebuildPreflight, { connectionKey }, f.paseo)).toMatchObject({ projects: 0, workspaces: 2, discussions: 2 });
  const before = f.requests.filter(path => path.startsWith("/api/issues?")).length;
  await restarted.server.rpc(rebuildStart, { connectionKey }, f.paseo);
  expect(await finishRebuild(restarted.server, f.paseo, connectionKey)).toMatchObject({ status: "completed", completed: 0, total: 0 });
  expect(f.requests.filter(path => path.startsWith("/api/issues?"))).toHaveLength(before);
  expect(f.effects.some(effect => effect.startsWith("removeProject:"))).toBe(false);
  expect(f.native.workspaces.find(workspace => workspace.id === "user-workspace")!.archived).toBeUndefined();
  expect((await new StateStore(store.directory).read()).connections[connectionKey]).toMatchObject({ projects: {}, issues: {}, rules: { "remote-workspace": { enabled: false } } });
});

it("rebuild rechecks initially retained projects and removes them when their user workspace is archived before removal", async () => {
  const f = await fixture(60_000); f.remote.acknowledgeEvents = false;
  await f.server.syncRpc(enable, { workspaceId: "remote-workspace", enabled: true }, f.paseo);
  const connectionKey = (await f.server.rpc(connectionStatus, {}, f.paseo)).connectionKey!;
  const project = f.native.projects[0], pluginWorkspace = f.native.workspaces[0];
  const userWorkspace = { id: "user-workspace", projectId: project.projectId, cwd: project.cwd, title: "Mine", archived: false };
  f.native.workspaces.push(userWorkspace);
  const marker = join(project.cwd, "removed-marker"); await writeFile(marker, "remove");
  await f.dispose();
  await new StateStore(join(f.home, "multica-provider")).update(state => { state.connections[connectionKey].rules["remote-workspace"].enabled = false; });
  const archive = f.host.archiveWorkspace.bind(f.host);
  vi.spyOn(f.host, "archiveWorkspace").mockImplementation(async id => {
    const result = await archive(id);
    if (id === pluginWorkspace.id) userWorkspace.archived = true;
    return result;
  });
  const { server } = f.start();
  expect(await server.rpc(rebuildPreflight, { connectionKey }, f.paseo)).toMatchObject({ projects: 0, workspaces: 2, discussions: 2, blockers: [] });
  expect(await server.rpc(rebuildStart, { connectionKey }, f.paseo)).toMatchObject({ started: true });
  expect(await finishRebuild(server, f.paseo, connectionKey)).toMatchObject({ status: "completed", total: 0 });
  expect(f.effects).toContain(`removeProject:${project.projectId}`);
  expect(f.native.projects).toEqual([]);
  await expect(readFile(marker)).rejects.toMatchObject({ code: "ENOENT" });
});

it.each(["discovery", "recheck"])("rebuild removes local placeholder files while preserving projects retained during %s and other connections", async phase => {
  const f = await fixture(60_000); f.remote.acknowledgeEvents = false;
  await f.server.syncRpc(enable, { workspaceId: "remote-workspace", enabled: true }, f.paseo);
  await enableSecondWorkspace(f);
  const connectionKey = (await f.server.rpc(connectionStatus, {}, f.paseo)).connectionKey!;
  const [removedProject, retainedProject] = f.native.projects;
  const removedMarker = join(removedProject.cwd, "removed-marker"), retainedMarker = join(retainedProject.cwd, "retained-marker");
  const otherDirectory = join(f.home, "multica-provider/placeholders", "f".repeat(20), "other-project");
  const otherMarker = join(otherDirectory, "other-marker");
  await mkdir(otherDirectory, { recursive: true });
  await writeFile(removedMarker, "remove"); await writeFile(retainedMarker, "retain"); await writeFile(otherMarker, "other");
  const userWorkspace = { id: "user-workspace", projectId: retainedProject.projectId, cwd: retainedProject.cwd, title: "Mine" };
  if (phase === "discovery") f.native.workspaces.push(userWorkspace);
  else {
    const trigger = f.native.workspaces.find(workspace => workspace.projectId === retainedProject.projectId)!.id;
    const archive = f.host.archiveWorkspace.bind(f.host);
    vi.spyOn(f.host, "archiveWorkspace").mockImplementation(async id => {
      const result = await archive(id);
      if (id === trigger) f.native.workspaces.push(userWorkspace);
      return result;
    });
  }
  expect(await f.server.rpc(rebuildPreflight, { connectionKey }, f.paseo)).toMatchObject({ projects: phase === "discovery" ? 1 : 2, workspaces: 4, discussions: 4 });
  expect(await f.server.rpc(rebuildStart, { connectionKey }, f.paseo)).toMatchObject({ started: true });
  expect(await finishRebuild(f.server, f.paseo, connectionKey)).toMatchObject({ status: "completed", completed: 4, total: 4 });
  expect(f.effects).toContain(`removeProject:${removedProject.projectId}`);
  expect(f.effects).not.toContain(`removeProject:${retainedProject.projectId}`);
  await expect(readFile(removedMarker)).rejects.toMatchObject({ code: "ENOENT" });
  expect((await stat(removedProject.cwd)).isDirectory()).toBe(true);
  expect(await readFile(retainedMarker, "utf8")).toBe("retain");
  expect(await readFile(otherMarker, "utf8")).toBe("other");
});

it("rebuild fails before resetting local state when placeholder cleanup fails and retries after the scope is repaired", async () => {
  const f = await fixture(60_000); f.remote.acknowledgeEvents = false;
  await f.server.syncRpc(enable, { workspaceId: "remote-workspace", enabled: true }, f.paseo);
  const connectionKey = (await f.server.rpc(connectionStatus, {}, f.paseo)).connectionKey!;
  await f.dispose();
  const store = new StateStore(join(f.home, "multica-provider"));
  await store.update(state => { state.connections[connectionKey].rules["remote-workspace"].enabled = false; });
  await mkdir(store.runDetailsDirectory(connectionKey), { recursive: true });
  const detailsMarker = join(store.runDetailsDirectory(connectionKey), "cached.json");
  await writeFile(detailsMarker, "preserved until cleanup succeeds");
  const scope = join(store.directory, "placeholders", connectionKey.slice(0, 20));
  const remove = f.host.removeProject.bind(f.host);
  const corruptScope = vi.spyOn(f.host, "removeProject").mockImplementation(async id => {
    const result = await remove(id);
    await rm(scope, { recursive: true, force: true });
    await writeFile(scope, "not a directory");
    return result;
  });
  const { server } = f.start();
  expect(await server.rpc(rebuildStart, { connectionKey }, f.paseo)).toMatchObject({ started: true });
  expect(await finishRebuild(server, f.paseo, connectionKey)).toMatchObject({ status: "failed", step: "清理本地占位目录", message: expect.stringContaining("ENOTDIR") });
  const local = (await new StateStore(store.directory).read()).connections[connectionKey];
  expect(local.rebuildGeneration).toBeUndefined();
  expect(Object.keys(local.issues)).toHaveLength(2);
  expect(await readFile(detailsMarker, "utf8")).toBe("preserved until cleanup succeeds");
  corruptScope.mockRestore();
  await rm(scope); await mkdir(scope);
  expect(await server.rpc(rebuildStart, { connectionKey }, f.paseo)).toMatchObject({ started: true });
  expect(await finishRebuild(server, f.paseo, connectionKey)).toMatchObject({ status: "completed", total: 0 });
  expect((await new StateStore(store.directory).read()).connections[connectionKey].rebuildGeneration).toBe(1);
  await expect(stat(store.runDetailsDirectory(connectionKey))).rejects.toMatchObject({ code: "ENOENT" });
});

it("rebuild waits for in-flight synchronization, reports failures and restarts cleanup from the beginning", async () => {
  const f = await fixture();
  await f.server.syncRpc(enable, { workspaceId: "remote-workspace", enabled: true }, f.paseo);
  const connectionKey = (await f.server.rpc(connectionStatus, {}, f.paseo)).connectionKey!;
  const archive = f.host.archiveWorkspace.bind(f.host);
  let fail = true;
  f.host.archiveWorkspace = async (...args) => { if (fail) throw new Error("synthetic archive failure"); return archive(...args); };
  f.remote.holdIssueReads = true;
  const syncing = resync(f.server, f.paseo, "remote-workspace");
  await expect.poll(() => f.heldIssueReads.length).toBeGreaterThan(0);
  expect(await f.server.rpc(rebuildStart, { connectionKey }, f.paseo)).toMatchObject({ started: true, progress: { status: "running", step: "等待后台同步" } });
  expect(f.effects).toEqual([]);
  await expect(f.server.rpc(rebuildStart, { connectionKey }, f.paseo)).rejects.toThrow("正在进行");
  f.remote.holdIssueReads = false;
  for (const reply of f.heldIssueReads.splice(0)) reply();
  expect(await finishRebuild(f.server, f.paseo, connectionKey)).toMatchObject({ status: "failed", stage: "deleting", step: "归档 Paseo 工作区", message: expect.stringContaining("synthetic archive failure") });
  await syncing;
  fail = false;
  f.effects.length = 0;
  await f.server.rpc(rebuildStart, { connectionKey }, f.paseo);
  expect(await finishRebuild(f.server, f.paseo, connectionKey)).toMatchObject({ status: "completed", completed: 2, total: 2 });
  expect(f.effects.filter(effect => effect.startsWith("archiveWorkspace:"))).toHaveLength(2);
  expect(f.effects.some(effect => effect.startsWith("removeProject:"))).toBe(true);
});

it("rebuild finds active plugin directories without discussions and skips archived workspaces", async () => {
  const f = await fixture();
  await f.server.syncRpc(enable, { workspaceId: "remote-workspace", enabled: true }, f.paseo);
  const connectionKey = (await f.server.rpc(connectionStatus, {}, f.paseo)).connectionKey!;
  const first = f.native.workspaces[0], archived = f.native.workspaces[1];
  archived.archived = true;
  f.native.agents.length = 0;
  f.native.workspaces.push({ ...first, id: "empty-orphan", workspaceDirectory: join(f.native.projects[0].cwd, "orphan") });
  await f.dispose();
  const store = new StateStore(join(f.home, "multica-provider"));
  await store.update(state => {
    // Simulate a retry after local mappings and all native discussions are gone.
    state.connections[connectionKey] = { rules: {}, projects: {}, issues: {} };
  });
  first.workspaceDirectory = first.cwd;
  const restarted = f.start();
  expect(await restarted.server.rpc(rebuildPreflight, { connectionKey }, f.paseo)).toMatchObject({ projects: 1, workspaces: 2, discussions: 0 });
  await restarted.server.rpc(rebuildStart, { connectionKey }, f.paseo);
  expect(await finishRebuild(restarted.server, f.paseo, connectionKey)).toMatchObject({ status: "completed", total: 0 });
  expect(f.effects).toEqual([`archiveWorkspace:${first.id}`, "archiveWorkspace:empty-orphan", `removeProject:${first.projectId}`]);
  expect(f.effects).not.toContain(`archiveWorkspace:${archived.id}`);
});

it("zero-rule rebuild generations survive restart and keep later ordinary imports off archived IDs and keys", async () => {
  const f = await fixture();
  await f.server.syncRpc(enable, { workspaceId: "remote-workspace", enabled: true }, f.paseo);
  const connectionKey = (await f.server.rpc(connectionStatus, {}, f.paseo)).connectionKey!;
  const original = [...f.creations];
  await f.dispose();
  const store = new StateStore(join(f.home, "multica-provider"));
  await store.update(state => { state.connections[connectionKey].rules["remote-workspace"].enabled = false; });
  const first = f.start();
  for (let generation = 1; generation <= 2; generation++) {
    await first.server.rpc(rebuildStart, { connectionKey }, f.paseo);
    expect(await finishRebuild(first.server, f.paseo, connectionKey)).toMatchObject({ status: "completed", total: 0 });
    expect((await new StateStore(store.directory).read()).connections[connectionKey].rebuildGeneration).toBe(generation);
  }
  await first.dispose();
  const restarted = f.start();
  expect(await restarted.server.syncRpc(enable, { workspaceId: "remote-workspace", enabled: true }, f.paseo)).toMatchObject({ status: "ready" });
  expect(f.creations.slice(original.length)).toHaveLength(2);
  for (const creation of f.creations.slice(original.length)) expect(original.some(old => old.workspaceId === creation.workspaceId || old.idempotencyKey === creation.idempotencyKey)).toBe(false);
});

it("uses the persisted generation when an archived task matches only after rebuild", async () => {
  const f = await fixture();
  await f.server.syncRpc(enable, { workspaceId: "remote-workspace", enabled: true }, f.paseo);
  const connectionKey = (await f.server.rpc(connectionStatus, {}, f.paseo)).connectionKey!;
  const original = [...f.creations];
  f.issues[1].status_category = "done";
  await resync(f.server, f.paseo, "remote-workspace");
  await f.server.rpc(rebuildStart, { connectionKey }, f.paseo);
  expect(await finishRebuild(f.server, f.paseo, connectionKey)).toMatchObject({ status: "completed", completed: 1, total: 1 });
  f.issues[1].status_category = "started";
  expect(await resync(f.server, f.paseo, "remote-workspace")).toMatchObject({ status: "ready" });
  expect(f.creations.slice(original.length)).toHaveLength(2);
  for (const creation of f.creations.slice(original.length)) expect(original.some(old => old.workspaceId === creation.workspaceId || old.idempotencyKey === creation.idempotencyKey)).toBe(false);
});

it("ordinary sync after an import failure uses the rebuild generation and a retry starts a new one", async () => {
  const f = await fixture();
  await f.server.syncRpc(enable, { workspaceId: "remote-workspace", enabled: true }, f.paseo);
  const connectionKey = (await f.server.rpc(connectionStatus, {}, f.paseo)).connectionKey!;
  const original = [...f.creations], add = f.host.addProject.bind(f.host);
  let fail = true;
  f.host.addProject = async (...args) => { if (fail) { fail = false; throw new Error("one import failure"); } return add(...args); };
  await f.server.rpc(rebuildStart, { connectionKey }, f.paseo);
  expect(await finishRebuild(f.server, f.paseo, connectionKey)).toMatchObject({ status: "failed", stage: "importing", message: expect.stringContaining("产品开发") });
  expect((await waitForSync(f.server, f.paseo)).status).toBe("ready");
  const first = f.creations.slice(original.length);
  expect(first).toHaveLength(2);
  for (const creation of first) expect(original.some(old => old.workspaceId === creation.workspaceId || old.idempotencyKey === creation.idempotencyKey)).toBe(false);
  await f.server.rpc(rebuildStart, { connectionKey }, f.paseo);
  expect(await finishRebuild(f.server, f.paseo, connectionKey)).toMatchObject({ status: "completed", total: 2 });
  const allPrevious = [...original, ...first];
  for (const creation of f.creations.slice(allPrevious.length)) expect(allPrevious.some(old => old.workspaceId === creation.workspaceId || old.idempotencyKey === creation.idempotencyKey)).toBe(false);
});

it("a profile switch during reimport fails the rebuild and lets the queued profile purge finish", async () => {
  const f = await fixture();
  await f.server.syncRpc(enable, { workspaceId: "remote-workspace", enabled: true }, f.paseo);
  const connectionKey = (await f.server.rpc(connectionStatus, {}, f.paseo)).connectionKey!;
  await mkdir(join(f.home, ".multica/profiles/office"), { recursive: true });
  await writeFile(join(f.home, ".multica/profiles/office/config.json"), await readFile(join(f.home, ".multica/config.json")));
  f.remote.holdIssueReads = true;
  await f.server.rpc(rebuildStart, { connectionKey }, f.paseo);
  try {
    await expect.poll(() => f.heldIssueReads.length).toBeGreaterThan(0);
    expect(await f.server.rpc(rebuildStatus, { connectionKey }, f.paseo)).toMatchObject({ status: "running", stage: "importing" });
    f.server.setSettings(multicaSettings.id, { profile: "office" });
    expect(await f.server.rpc(connectionStatus, {}, f.paseo)).toMatchObject({ profile: "office" });
  } finally {
    f.remote.holdIssueReads = false;
    for (const reply of f.heldIssueReads.splice(0)) reply();
  }
  expect(await finishRebuild(f.server, f.paseo, connectionKey)).toMatchObject({ status: "failed", stage: "importing", step: "按筛选规则导入", message: expect.stringMatching(/^按筛选规则导入失败：/) });
  expect((await waitForSync(f.server, f.paseo)).status).toBe("ready");
  expect(await new StateStore(join(f.home, "multica-provider")).read()).toMatchObject({ owner: { profile: "office" }, connections: {} });
  expect(f.requests.some(path => path.endsWith("/cancel"))).toBe(false);
});

it("excludes known archived workspace mappings even when their archived discussions are discovered", async () => {
  const f = await fixture();
  await f.server.syncRpc(enable, { workspaceId: "remote-workspace", enabled: true }, f.paseo);
  const connectionKey = (await f.server.rpc(connectionStatus, {}, f.paseo)).connectionKey!;
  const archived = f.native.workspaces[1];
  archived.archived = true;
  f.native.agents[1].archivedAt = "2026-11-25T12:00:00Z";
  expect(await f.server.rpc(rebuildPreflight, { connectionKey }, f.paseo)).toMatchObject({ projects: 1, workspaces: 1, discussions: 2 });
  await f.server.rpc(rebuildStart, { connectionKey }, f.paseo);
  expect(await finishRebuild(f.server, f.paseo, connectionKey)).toMatchObject({ status: "completed" });
  expect(f.effects.filter(effect => effect.startsWith("archiveWorkspace:"))).toEqual([`archiveWorkspace:${f.native.workspaces[0].id}`]);
  expect(f.effects).not.toContain(`archiveWorkspace:${archived.id}`);
});

it("skips unchanged state writes and native renames across polls and restart, retries changed titles and reapplies on restore", async () => {
  const f = await fixture();
  await f.server.syncRpc(enable, { workspaceId: "remote-workspace", enabled: true }, f.paseo);
  const title = vi.spyOn(f.host, "setWorkspaceTitle"), name = vi.spyOn(f.host, "updateAgent"), projectName = vi.spyOn(f.host, "renameProject");
  const file = join(f.home, "multica-provider", "state.json");
  const before = await stat(file);
  f.native.workspaces[0].title = "My workspace";
  f.native.agents[0].name = "My discussion";
  await resync(f.server, f.paseo, "remote-workspace");
  expect((await stat(file)).ino).toBe(before.ino);
  expect(title).not.toHaveBeenCalled(); expect(name).not.toHaveBeenCalled(); expect(projectName).not.toHaveBeenCalled();
  await f.dispose();
  const restarted = f.start();
  await resync(restarted.server, f.paseo, "remote-workspace");
  expect((await stat(file)).ino).toBe(before.ino);
  expect(title).not.toHaveBeenCalled(); expect(name).not.toHaveBeenCalled();
  expect(projectName).not.toHaveBeenCalled();
  expect(f.native.workspaces[0].title).toBe("My workspace");
  expect(f.native.agents[0].name).toBe("My discussion");
  f.workspaces[0].name = "研发协作";
  f.issues[0].title = "New remote title";
  title.mockRejectedValueOnce(new Error("host unavailable"));
  expect(await resync(restarted.server, f.paseo, "remote-workspace")).toMatchObject({ status: "unavailable" });
  await resync(restarted.server, f.paseo, "remote-workspace");
  expect(title).toHaveBeenCalledTimes(2);
  expect(f.native.workspaces[0].title).toBe("PRD-1 New remote title");
  expect(f.native.projects[0].name).toBe("Multica · 研发协作");
  expect(projectName).toHaveBeenCalledTimes(1);
  expect(name).not.toHaveBeenCalled();
  await restarted.server.syncRpc(enable, { workspaceId: "remote-workspace", enabled: false }, f.paseo);
  await restarted.server.syncRpc(enable, { workspaceId: "remote-workspace", enabled: true }, f.paseo);
  expect(name).toHaveBeenCalledTimes(2);
  expect(f.native.agents[0].name).toBe("主讨论");
});
