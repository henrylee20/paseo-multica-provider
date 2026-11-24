import { createServer } from "node:http";
import { mkdtemp, mkdir, writeFile, rm, stat, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import type { PaseoApi } from "@getpaseo/client";
import type { DaemonClient } from "@getpaseo/client/internal/daemon-client";
import type { ProviderEvent } from "@getpaseo/plugin/server/provider";
import { defineRpc } from "@getpaseo/plugin";
import { z } from "zod";
import { createServerContribution } from "../server/contribute.js";
import { FakeServer } from "./support/fake-server.js";

const bootstrap = defineRpc({ name: "sync.bootstrap", input: z.object({}), output: z.object({ status: z.string() }) });
const management = defineRpc({ name: "workspace.list", input: z.object({}), output: z.object({ workspaces: z.array(z.object({ id: z.string(), name: z.string(), enabled: z.boolean() })) }) });
const enable = defineRpc({ name: "workspace.enable", input: z.object({ workspaceId: z.string(), enabled: z.boolean() }), output: z.object({ status: z.string() }) });
const cleanup: Array<() => void | Promise<void>> = [];
afterEach(async () => { for (const dispose of cleanup.splice(0).reverse()) await dispose(); });

async function fixture(syncIntervalMs = 15_000) {
  const home = await mkdtemp(join(tmpdir(), "multica-sidebar-"));
  cleanup.push(() => rm(home, { recursive: true, force: true }));
  const requests: string[] = [];
  const issues = [
    { id: "issue-one", workspace_id: "remote-workspace", identifier: "PRD-1", title: "实现登录", description: "用户可以使用现有 CLI 登录。", status: "custom-ready", status_category: "unstarted", updated_at: "2026-11-24T12:00:00Z" },
    { id: "issue-two", workspace_id: "remote-workspace", identifier: "PRD-2", title: "修复同步", description: "保留任务身份。", status: "custom-review", status_category: "started", updated_at: "2026-11-24T12:00:00Z" },
  ];
  const http = createServer((request, response) => {
    requests.push(request.url!);
    response.setHeader("Content-Type", "application/json");
    const url = new URL(request.url!, "http://localhost");
    response.end(JSON.stringify(url.pathname === "/api/me" ? { id: "user-42", name: "Lin" }
      : url.pathname.endsWith("/comments") ? []
      : url.pathname === "/api/issues" ? { issues: issues.slice(Number(url.searchParams.get("offset")), Number(url.searchParams.get("offset")) + 1), total: issues.length }
      : [{ id: "remote-workspace", name: "产品开发", slug: "product" }]));
  });
  await new Promise<void>(resolve => http.listen(0, "127.0.0.1", resolve));
  cleanup.push(() => new Promise<void>(resolve => { http.close(() => resolve()); http.closeAllConnections(); }));
  const address = http.address() as { port: number };
  await mkdir(join(home, ".multica"));
  await writeFile(join(home, ".multica", "config.json"), JSON.stringify({ server_url: `http://127.0.0.1:${address.port}`, token: "private-token" }));
  const native = { projects: [] as Array<{ projectId: string; cwd: string; name: string }>, workspaces: [] as Array<{ id: string; projectId: string; cwd: string; title: string; archived?: boolean }>, agents: [] as Array<{ id: string; workspaceId: string; cwd: string; labels: Record<string, string>; name?: string; handle: string; archivedAt?: string | null }> };
  const host = {
    listHosts: async () => ({ self: { serverId: "owning-daemon" } }),
    addProject: async (cwd: string) => {
      let project = native.projects.find(item => item.cwd === cwd);
      if (!project) { project = { projectId: "native-project", cwd, name: "" }; native.projects.push(project); }
      return { project, error: null };
    },
    renameProject: async (id: string, name: string) => { native.projects.find(item => item.projectId === id)!.name = name; },
    fetchWorkspaces: async () => ({ entries: native.workspaces, pageInfo: { hasMore: false, nextCursor: null } }),
    createWorkspace: async (input: { source: { path: string; projectId: string }; workspaceId: string; title: string }) => {
      if (!input.source.projectId) throw new Error("Explicit parent project required");
      const workspace = { id: input.workspaceId, projectId: input.source.projectId, cwd: input.source.path, title: input.title };
      native.workspaces.push(workspace);
      return { workspace, error: null };
    },
    setWorkspaceTitle: async (id: string, title: string) => { native.workspaces.find(item => item.id === id)!.title = title; },
    fetchAgents: async () => ({ entries: native.agents.map(agent => ({ agent })), pageInfo: { hasMore: false, nextCursor: null } }),
    importAgent: async (input: { workspaceId: string; cwd: string; providerHandleId: string; labels: Record<string, string> }) => {
      const agent = { id: `native-agent-${native.agents.length + 1}`, workspaceId: input.workspaceId, cwd: input.cwd, labels: input.labels, handle: input.providerHandleId };
      native.agents.push(agent); return agent;
    },
    updateAgent: async (id: string, updates: { name: string }) => { native.agents.find(item => item.id === id)!.name = updates.name; },
    archiveWorkspace: async (id: string) => {
      native.workspaces.find(item => item.id === id)!.archived = true;
      for (const agent of native.agents.filter(item => item.workspaceId === id)) agent.archivedAt = "2026-11-24T12:00:00Z";
      return { error: null };
    },
    restoreWorkspace: async (id: string) => { native.workspaces.find(item => item.id === id)!.archived = false; },
    fetchAgent: async (id: string) => ({ agent: native.agents.find(item => item.id === id) }),
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
  return { server, requests, paseo, native, home, issues, start, dispose, host };
}

it("client bootstrap leaves the native sidebar empty until a workspace rule is explicitly enabled", async () => {
  const f = await fixture();
  expect(await f.server.rpc(bootstrap, {}, f.paseo)).toMatchObject({ status: "ready" });
  expect(await f.server.rpc(management, {}, f.paseo)).toEqual({ workspaces: [{ id: "remote-workspace", name: "产品开发", enabled: false }] });
  expect(f.requests.some(path => path.startsWith("/api/issues"))).toBe(false);
});

it("turning a workspace rule off and back on archives and restores the same native records", async () => {
  const f = await fixture();
  await f.server.rpc(enable, { workspaceId: "remote-workspace", enabled: true }, f.paseo);
  const ids = f.native.workspaces.map(item => item.id);
  const agents = f.native.agents.map(item => item.id);
  await f.server.rpc(enable, { workspaceId: "remote-workspace", enabled: false }, f.paseo);
  expect(f.native.workspaces.every(item => item.archived)).toBe(true);
  await f.server.rpc(enable, { workspaceId: "remote-workspace", enabled: true }, f.paseo);
  expect(f.native.workspaces.every(item => !item.archived)).toBe(true);
  expect(f.native.agents.every(item => !item.archivedAt)).toBe(true);
  expect(f.native.workspaces.map(item => item.id)).toEqual(ids);
  expect(f.native.agents.map(item => item.id)).toEqual(agents);
});

it("a failed rule archive remains retryable and reenable does not refresh a previously hidden main tab", async () => {
  const f = await fixture();
  await f.server.rpc(enable, { workspaceId: "remote-workspace", enabled: true }, f.paseo);
  f.native.agents[0].archivedAt = "already-hidden";
  const archive = f.host.archiveWorkspace.bind(f.host);
  f.host.archiveWorkspace = async () => { throw new Error("temporarily disconnected"); };
  expect(await f.server.rpc(enable, { workspaceId: "remote-workspace", enabled: false }, f.paseo)).toMatchObject({ status: "unavailable" });
  f.host.archiveWorkspace = archive;
  await f.server.rpc(bootstrap, {}, f.paseo);
  expect(f.native.workspaces.every(item => item.archived)).toBe(true);
  await f.server.rpc(enable, { workspaceId: "remote-workspace", enabled: true }, f.paseo);
  expect(f.native.agents[0].archivedAt).toBeTruthy();
  expect(f.native.agents[1].archivedAt).toBeNull();
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
  await Promise.all([f.server.rpc(bootstrap, {}, f.paseo), f.server.rpc(bootstrap, {}, f.paseo)]);
  f.dispose();
  const restarted = f.start();
  expect(await restarted.server.rpc(bootstrap, {}, f.paseo)).toMatchObject({ status: "ready" });
  expect(await restarted.server.rpc(management, {}, f.paseo)).toMatchObject({ workspaces: [{ id: "remote-workspace", enabled: true }] });
  expect(f.native.workspaces.map(item => item.id)).toEqual(workspaceIds);
  expect(f.native.agents.map(item => item.id)).toEqual(agentIds);
  expect(f.native.workspaces[0].title).toBe("PRD-1 登录标题已修改");
  expect(await readFile(join(f.home, "multica-provider", "state.json"), "utf8")).not.toContain("private-token");
});

it("a lost native workspace creation response is reconciled before retrying after restart", async () => {
  const f = await fixture();
  const create = f.host.createWorkspace.bind(f.host);
  f.host.createWorkspace = async (...args) => { await create(...args); throw new Error("response lost"); };
  expect(await f.server.rpc(enable, { workspaceId: "remote-workspace", enabled: true }, f.paseo)).toMatchObject({ status: "unavailable" });
  expect(f.native.workspaces).toHaveLength(1);
  f.host.createWorkspace = create;
  f.dispose();
  const restarted = f.start();
  expect(await restarted.server.rpc(bootstrap, {}, f.paseo)).toMatchObject({ status: "ready" });
  expect(f.native.workspaces).toHaveLength(2);
  expect(f.native.agents).toHaveLength(2);
});

it("a lost native import response is reconciled through stable labels without importing the active handle again", async () => {
  const f = await fixture();
  const importAgent = f.host.importAgent.bind(f.host);
  f.host.importAgent = async input => { await importAgent(input); throw new Error("response lost"); };
  expect(await f.server.rpc(enable, { workspaceId: "remote-workspace", enabled: true }, f.paseo)).toMatchObject({ status: "unavailable" });
  expect(f.native.agents).toHaveLength(1);
  f.host.importAgent = importAgent;
  f.dispose();
  const restarted = f.start();
  expect(await restarted.server.rpc(bootstrap, {}, f.paseo)).toMatchObject({ status: "ready" });
  expect(f.native.workspaces).toHaveLength(2);
  expect(f.native.agents).toHaveLength(2);
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
  expect(pages.map(url => url.searchParams.get("offset"))).toEqual(["0", "1"]);
  expect(pages.every(url => url.searchParams.get("status_categories") === "unstarted,started" && !url.searchParams.has("open_only") && !url.searchParams.has("statuses"))).toBe(true);
});

it("the imported provider main discussion replays the task description and closes without creating remote comments", async () => {
  const f = await fixture();
  await f.server.rpc(enable, { workspaceId: "remote-workspace", enabled: true }, f.paseo);
  const registration = f.server.providers.get("multica");
  expect(registration).toBeDefined();
  const connection = await registration!.connect({ versions: [1], capabilities: ["session.persistence", "session.list"] });
  const events: ProviderEvent[] = [];
  connection.onEvent(event => events.push(event));
  const agent = f.native.agents[0];
  await connection.send({ type: "session.open", requestId: "open", sessionId: "main", history: "replay",
    persistence: JSON.parse(agent.handle.slice("plugin:".length)),
    config: { cwd: agent.cwd, env: {}, mcpServers: {}, settings: {}, persist: true } });
  expect(events).toContainEqual(expect.objectContaining({ type: "session.opened", description: "用户可以使用现有 CLI 登录。", title: "PRD-1 实现登录" }));
  expect(events).toContainEqual(expect.objectContaining({ type: "timeline.item", item: expect.objectContaining({ type: "notification", level: "info", message: "任务描述\n\n用户可以使用现有 CLI 登录。" }) }));
  expect(events.some(event => event.type === "timeline.item" && (event.item.type === "assistant_message" || event.item.type === "user_message"))).toBe(false);
  expect(events.at(-1)).toEqual({ type: "session.ready", requestId: "open", sessionId: "main" });
  const beforeClose = f.requests.length;
  await connection.send({ type: "session.close", requestId: "close", sessionId: "main" });
  await connection.close();
  expect(f.requests).toHaveLength(beforeClose);
});
