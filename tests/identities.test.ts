import { rebuildPreflight, rebuildStart } from "../shared/rebuild.js";
import { createServer } from "node:http";
import { createRequire } from "node:module";
import { randomUUID } from "node:crypto";
import { mkdtemp, mkdir, writeFile, readFile, rm, rename } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import type { PaseoApi } from "@getpaseo/client";
import type { DaemonClient } from "@getpaseo/client/internal/daemon-client";
import type { ProviderConnection, ProviderEvent } from "@getpaseo/plugin/server/provider";
import { workspaceEnable, syncBootstrap, connectionStatus, multicaSettings, workspaceList, workspaceRule, taskRuleSchema } from "../shared/contracts.js";
import { deliveryMentions } from "../shared/delivery.js";
import { threadOpen } from "../shared/threads.js";
import { createServerContribution } from "../server/contribute.js";
import { StateStore } from "../server/state.js";
import type { LocalState } from "../server/state.js";
import { FakeServer, hiddenObjects, waitForSync } from "./support/fake-server.js";
import { askuserObserve, askuserReopen } from "../shared/askuser.js";
import { hiddenRestore } from "../shared/hiding.js";
import { defineRpc } from "@getpaseo/plugin";
import { z } from "zod";

const cleanup: Array<() => void | Promise<void>> = [];
afterEach(async () => { for (const dispose of cleanup.splice(0).reverse()) await dispose(); });
const pause = () => {
  let release!: () => void, reached!: () => void;
  const blocked = new Promise<void>(resolve => { release = resolve; });
  const waiting = new Promise<void>(resolve => { reached = resolve; });
  return { release, waiting, handler: async () => { reached(); await blocked; } };
};

async function fixture(options: { askuser?: boolean; empty?: boolean; respectVisibility?: boolean } = {}) {
  const home = await mkdtemp(join(tmpdir(), "multica-identities-"));
  cleanup.push(() => rm(home, { recursive: true, force: true }));
  // Ephemeral opaque fixture credentials are compared only as booleans, never
  // printed by assertion diffs or returned through the contribution boundary.
  const credentials = [randomUUID(), randomUUID(), randomUUID()];
  const requests: Array<{ path: string; actor: string; method: string }> = [];
  const posts: Array<{ actor: string; path: string }> = [];
  const runState = { status: "running" };
  const messages: Array<{ task_id: string; issue_id: string; seq: number; type: string; content: string }> = [];
  let beforeIdentity: (() => Promise<void>) | undefined;
  const remote = async () => {
    const http = createServer(async (request, response) => {
      const actor = request.headers.authorization === `Bearer ${credentials[2]}` ? "other" : "me";
      const url = new URL(request.url!, "http://localhost");
      requests.push({ path: url.pathname, actor, method: request.method! });
      response.setHeader("Content-Type", "application/json");
      let body: unknown;
      if (request.method === "POST") {
        for await (const _chunk of request) { /* Consume ordinary comment body. */ }
        posts.push({ actor, path: url.pathname });
        response.statusCode = 503; body = {};
      } else if (url.pathname === "/api/me") { await beforeIdentity?.(); body = { id: actor, name: actor === "me" ? "Lin" : "Kai" }; }
      else if (url.pathname === "/api/workspaces") { body = [{ id: "workspace", name: "Product", slug: "product" }]; }
      else if (url.pathname === "/api/issues")
        body = { issues: [{ id: "issue", workspace_id: "workspace", title: "Task", description: "Description", status: "todo" }], total: 1 };
      else if (url.pathname === "/api/issues/issue/task-runs")
        body = [{ id: "run", issue_id: "issue", agent_id: "agent", status: runState.status, trigger_comment_id: "root" }];
      else if (url.pathname === "/api/tasks/run/messages") body = messages;
      else if (url.pathname === "/api/issues/issue/comments")
        body = [{ id: "root", issue_id: "issue", parent_id: null, content: "Original Lin comment", author_id: "me", author_type: "member", type: "comment", created_at: "2026-11-24T10:00:00Z", updated_at: "2026-11-24T10:00:00Z", attachments: options.askuser ? [{ id: "question", filename: "askuser.json", content_type: "application/json", download_url: "/api/attachments/question/download" }] : [] }];
      else if (url.pathname === "/api/attachments/question/download") body = { version: "1", title: "发布确认", questions: [{ id: "reason", type: "text", title: "理由" }] };
      else if (url.pathname === "/api/issues/issue") body = { id: "issue", workspace_id: "workspace" };
      else if (url.pathname === "/api/issues/issue/timeline") body = [];
      else if (url.pathname === "/api/agents") body = [{ id: "agent", name: "Agent" }];
      else if (url.pathname.endsWith("/members")) body = [{ user_id: "me", name: "Lin" }];
      else { response.statusCode = 404; body = {}; }
      response.end(JSON.stringify(body));
    });
    await new Promise<void>(resolve => http.listen(0, "127.0.0.1", resolve));
    cleanup.push(() => new Promise<void>(resolve => { http.close(() => resolve()); http.closeAllConnections(); }));
    type Socket = { close(): void; send(data: string): void; on(type: "message", callback: (data: { toString(): string }) => void): void };
    const { WebSocketServer } = createRequire(import.meta.url)("ws") as { WebSocketServer: new (options: { server: typeof http }) => {
      clients: Set<Socket>; close(): void; on(type: "connection", callback: (socket: Socket) => void): void;
    } };
    const ws = new WebSocketServer({ server: http });
    ws.on("connection", socket => { socket.on("message", () => { socket.send(JSON.stringify({ type: "auth_ack", payload: {} })); }); });
    cleanup.push(() => { for (const socket of ws.clients) socket.close(); ws.close(); });
    return { apiUrl: `http://127.0.0.1:${(http.address() as { port: number }).port}`, ws };
  };
  const primary = await remote(), secondary = await remote();
  const path = join(home, ".multica/config.json");
  const login = async (credential: number | null, apiUrl = primary.apiUrl, profile = "") => {
    const file = profile ? join(home, ".multica/profiles", profile, "config.json") : path;
    await mkdir(join(file, ".."), { recursive: true });
    await writeFile(`${file}.next`, JSON.stringify({ server_url: apiUrl, app_url: "https://front.example.test", ...(credential === null ? {} : { token: credentials[credential] }) }));
    await rename(`${file}.next`, file);
  };
  await login(0);
  const events: ProviderEvent[] = [];
  const projects: Array<{ projectId: string; cwd: string; projectRootPath: string; projectKind: string; projectDisplayName?: string }> = [];
  const workspaces: Array<{ id: string; projectId: string; archived?: boolean; background?: boolean; internal?: boolean; workspaceDirectory?: string }> = [];
  const agents: Array<{ provider: string; id: string; workspaceId: string; cwd: string; labels: Record<string, string>; archivedAt?: string; internal?: boolean }> = [];
  const visibleInDirectory = (entry: { background?: boolean; internal?: boolean }, input?: unknown) => {
    const filter = (input as { filter?: { includeBackground?: boolean; includeInternal?: boolean } } | undefined)?.filter;
    return !options.respectVisibility || ((!entry.background || filter?.includeBackground === true) && (!entry.internal || filter?.includeInternal === true));
  };
  let provider: ProviderConnection | undefined;
  let server = new FakeServer();
  const connect = async () => {
    if (!provider) {
      provider = await server.providers.get("multica")!.connect({ versions: [1], capabilities: ["session.subsession", "session.persistence", "prompt.message", "prompt.steer", "timeline.plugin"] });
      provider.onEvent(event => {
        events.push(event);
      });
    }
    return provider;
  };
  let nextProject = 0, nextAgent = 0;
  const host = {
    listHosts: async () => ({ self: { serverId: "daemon" } }),
    listProjects: vi.fn(async () => ({ projects })),
    addProject: async (cwd: string) => {
      let project = projects.find(value => value.cwd === cwd);
      if (!project) {
        project = { projectId: `project-${nextProject++}`, cwd, projectRootPath: cwd, projectKind: "non_git" };
        projects.push(project);
      }
      return { project: { ...project, projectKind: "non_git" } };
    },
    removeProject: vi.fn(async (id: string) => {
      projects.splice(projects.findIndex(project => project.projectId === id), 1);
      for (const workspace of workspaces) if (workspace.projectId === id) workspace.archived = true;
    }),
    archiveWorkspace: vi.fn(async (id: string) => { workspaces.find(workspace => workspace.id === id)!.archived = true; return { error: null as string | null }; }),
    renameProject: async () => {}, fetchWorkspaces: vi.fn(async (input?: unknown) => ({ entries: workspaces.filter(workspace => !workspace.archived && visibleInDirectory(workspace, input)), pageInfo: { hasMore: false, nextCursor: undefined as string | undefined } })),
    createWorkspace: async (input: { workspaceId: string; source: { projectId: string } }) => {
      const workspace = { id: input.workspaceId, projectId: input.source.projectId };
      workspaces.push(workspace);
      return { workspace };
    }, setWorkspaceTitle: async () => {},
    fetchAgents: vi.fn(async (input?: unknown) => ({ entries: agents.filter(agent => visibleInDirectory(agent, input) && visibleInDirectory(workspaces.find(workspace => workspace.id === agent.workspaceId) ?? {}, input)).map(agent => ({ agent })), pageInfo: { hasMore: false, nextCursor: undefined as string | undefined } })),
    deleteAgent: vi.fn(async (id: string) => { const index = agents.findIndex(agent => agent.id === id); if (index >= 0) agents.splice(index, 1); }),
    fetchAgent: vi.fn(async (id: string) => ({ agent: agents.find(agent => agent.id === id) })),
    fetchAgentTimeline: async (agentId: string) => ({ agentId, epoch: "epoch", entries: [], hasOlder: false, hasNewer: false }),
    importAgent: async (input: { workspaceId: string; cwd: string; labels: Record<string, string>; providerHandleId: string }) => {
      const agent = { provider: "multica", id: `native-${nextAgent++}`, workspaceId: input.workspaceId, cwd: input.cwd, labels: input.labels }; agents.push(agent);
      await (await connect()).send({ type: "session.open", requestId: agent.id, sessionId: agent.id, history: "replay", persistence: JSON.parse(input.providerHandleId.slice(7)), config: { cwd: agent.cwd, env: {}, mcpServers: {}, settings: {}, persist: true } });
      return agent;
    }, updateAgent: async () => {}, close: async () => {},
  };
  const paseo = { agents: { ref: () => ({}) }, hosts: { list: async () => ({ self: { serverId: "daemon" } }) } } as unknown as PaseoApi;
  const start = () => createServerContribution({ homeDirectory: home, stateDirectory: join(home, "state"), workingDirectory: home, environment: { PASEO_HOME: home }, connectHost: async () => host as unknown as DaemonClient, syncIntervalMs: 60_000 })(server.context);
  let dispose = start();
  cleanup.push(() => dispose()); cleanup.push(async () => { await provider?.close(); });
  if (!options.empty) await server.syncRpc(workspaceEnable, { workspaceId: "workspace", enabled: true }, paseo);
  const address = (connectionKey = agents[0].labels["multica.connection"]) => ({ connectionKey, issueId: "issue", rootId: "root" });
  const send = async (clientMessageId: string) => {
    const agent = agents.find(agent => agent.labels["multica.connection"] === address().connectionKey && agent.labels["multica.discussion"] === "root")!;
    await (await connect()).send({ type: "session.prompt", sessionId: agent.id, prompt: { clientMessageId, delivery: "steer", input: { type: "message", content: [{ type: "text", text: "Preserve original input" }] } } });
  };
  return { runState, messages, home, get server() { return server; }, host, paseo,
    restart: async (legacy = false) => {
      await provider?.close(); provider = undefined; await dispose();
      if (legacy) {
        const state = JSON.parse(await readFile(join(home, "state/state.json"), "utf8"));
        delete state.owner;
        await writeFile(join(home, "state/state.json"), JSON.stringify(state));
      }
      server = new FakeServer(); dispose = start();
    }, events, projects, workspaces, agents, posts, requests, address, send, login, primary, secondary, connect,
    historyReader: () => {
      const server = new FakeServer();
      cleanup.push(createServerContribution({ homeDirectory: home, stateDirectory: join(home, "state"), workingDirectory: home, environment: { PASEO_HOME: home } })(server.context));
      return server;
    },
    blockIdentity: (handler?: () => Promise<void>) => { beforeIdentity = handler; },
    secretAbsent: (value: unknown) => credentials.every(credential => !JSON.stringify(value).includes(credential)),
    persisted: () => readFile(join(home, "state/state.json"), "utf8") };
}

it("logout during connection setup prevents an accepted old input from reaching the remote service", async () => {
  const f = await fixture();
  await f.login(1);
  const gate = pause(); f.blockIdentity(gate.handler);
  await f.send("logout-input"); await gate.waiting;
  await f.login(null); gate.release();
  await expect.poll(() => f.events.some(event => event.type === "timeline.item" && event.item.type === "error")).toBe(true);
  expect(f.posts).toEqual([]);
});

it("logout retires the authenticated workspace socket and leaves no old-cache requests", async () => {
  const f = await fixture();
  await expect.poll(() => f.primary.ws.clients.size).toBe(1);
  await f.login(null);
  expect(await f.server.rpc(connectionStatus, {}, f.paseo)).toMatchObject({ status: "not_logged_in" });
  await expect.poll(() => f.primary.ws.clients.size).toBe(0);
  const before = f.requests.length;
  await f.server.syncRpc(syncBootstrap, {}, f.paseo);
  await expect(f.server.rpc(deliveryMentions, { connectionKey: f.address().connectionKey, issueId: "issue" }, f.paseo)).rejects.toThrow();
  expect(f.requests.length).toBe(before);
});

it("same-profile token rotation reuses data and CLI account changes keep both connections until a profile switch", async () => {
  const f = await fixture();
  const original = f.address();
  const ids = f.agents.map(agent => agent.id);
  await f.login(1);
  expect(await f.server.rpc(connectionStatus, {}, f.paseo)).toMatchObject({ connectionKey: original.connectionKey });
  await f.server.syncRpc(syncBootstrap, {}, f.paseo);
  expect(f.agents.map(agent => agent.id)).toEqual(ids);
  await f.login(2);
  const other = await f.server.rpc(connectionStatus, {}, f.paseo);
  expect(other.connectionKey).not.toBe(original.connectionKey);
  expect((await f.server.rpc(workspaceList, {}, f.paseo)).workspaces[0].enabled).toBe(false);
  await f.server.syncRpc(workspaceEnable, { workspaceId: "workspace", enabled: true }, f.paseo);
  expect(Object.keys(JSON.parse(await f.persisted()).connections)).toHaveLength(2);
  const allIds = f.agents.map(agent => agent.id);
  await f.login(1, f.primary.apiUrl, "office");
  f.server.setSettings(multicaSettings.id, { profile: "office" });
  expect((await waitForSync(f.server, f.paseo)).status).toBe("ready");
  expect(f.host.deleteAgent.mock.calls.map(([id]) => id).sort()).toEqual(allIds.sort());
  expect(f.host.removeProject).toHaveBeenCalledTimes(2);
  expect(JSON.parse(await f.persisted())).toMatchObject({ owner: { profile: "office" }, connections: {} });
  expect(f.posts).toEqual([]);
  expect(f.secretAbsent([f.events, await f.persisted()])).toBe(true);
});

it("same-account profile switches and switching back purge discussions, rules, hidden data, AskUser caches and directories without cancelling an active Run", async () => {
  const f = await fixture({ askuser: true });
  const original = f.address();
  const card = { connectionKey: original.connectionKey, issueId: "issue", commentId: "root", attachmentId: "question" };
  expect(await f.server.rpc(askuserObserve, card, f.paseo)).toMatchObject({ status: "pending", readOnly: false });
  const thread = f.agents.find(agent => agent.labels["multica.discussion"] === "root")!;
  await f.server.hook("agent.archive.after", { agent: { ...thread, parentAgentId: null, title: null }, archivedAt: "2026-11-24T10:05:00Z" }, f.paseo);
  expect((await hiddenObjects(f.server, f.paseo)).length).toBe(1);
  expect((await f.server.rpc(connectionStatus, {}, f.paseo)).localData).toEqual({ projects: 1, issues: 1, discussions: 2 });
  await f.login(1, f.primary.apiUrl, "same-account");
  f.server.setSettings(multicaSettings.id, { profile: "same-account" });
  expect((await waitForSync(f.server, f.paseo)).status).toBe("ready");
  expect(f.agents).toEqual([]); expect(f.projects).toEqual([]);
  await expect(readFile(join(f.home, "state/placeholders"))).rejects.toMatchObject({ code: "ENOENT" });
  expect(await hiddenObjects(f.server, f.paseo)).toEqual([]);
  await expect(f.server.rpc(askuserObserve, card, f.paseo)).rejects.toThrow();
  expect((await f.server.rpc(workspaceList, {}, f.paseo)).workspaces[0]).toMatchObject({ enabled: false, importedCount: 0 });
  await f.server.syncRpc(workspaceEnable, { workspaceId: "workspace", enabled: true }, f.paseo);
  // Reusing this connectionKey must rediscover the card rather than keep stale per-card permissions.
  expect(await f.server.rpc(askuserObserve, card, f.paseo)).toMatchObject({ status: "pending", readOnly: false, collapsed: false });
  f.server.setSettings(multicaSettings.id, { profile: "" });
  await f.server.syncRpc(syncBootstrap, {}, f.paseo);
  expect(JSON.parse(await f.persisted())).toEqual({ version: 1, owner: { profile: "" }, connections: {} });
  expect(f.host.deleteAgent).toHaveBeenCalledTimes(4);
  expect(f.posts).toEqual([]);
  expect(f.events.some(event => event.type === "session.closed")).toBe(true);
});

it("an account switch during Stop setup fails without sending an old cancellation", async () => {
  const f = await fixture();
  await f.login(1);
  const gate = pause(); f.blockIdentity(gate.handler);
  const thread = f.agents.find(agent => agent.labels["multica.discussion"] === "root")!;
  const stopping = (await f.connect()).send({ type: "session.interrupt", requestId: "switch-during-stop", sessionId: thread.id });
  await gate.waiting; await f.login(2); gate.release(); await stopping;
  expect(f.posts).toEqual([]);
  expect(f.events).toContainEqual(expect.objectContaining({ type: "request.failed", requestId: "switch-during-stop" }));
});

it("a settings action opened under an old account cannot enable rules for a newly selected account", async () => {
  const f = await fixture();
  const original = f.address().connectionKey;
  await f.login(2);
  const enable = defineRpc({ name: "workspace.enable", input: workspaceEnable.input.extend({ connectionKey: z.string() }), output: workspaceEnable.output });
  expect(await f.server.syncRpc(enable, { workspaceId: "workspace", enabled: true, connectionKey: original }, f.paseo)).toMatchObject({ status: "unavailable" });
  expect((await f.server.rpc(workspaceList, {}, f.paseo)).workspaces[0].enabled).toBe(false);
});

it("retains Projects with user-created active workspaces, archives plugin workspaces and reports retained paths", async () => {
  const f = await fixture();
  const project = f.projects[0], pluginWorkspace = f.workspaces[0];
  f.workspaces.push({ id: "user-workspace", projectId: project.projectId });
  await writeFile(join(project.cwd, "user-file"), "preserved");
  const obsolete = join(f.home, "state/placeholders/obsolete/child");
  await mkdir(obsolete, { recursive: true });
  await f.login(1, f.primary.apiUrl, "office");
  f.server.setSettings(multicaSettings.id, { profile: "office" });
  await waitForSync(f.server, f.paseo);
  expect(f.host.removeProject).not.toHaveBeenCalled();
  expect(f.host.archiveWorkspace).toHaveBeenCalledExactlyOnceWith(pluginWorkspace.id);
  expect(f.workspaces.find(workspace => workspace.id === "user-workspace")?.archived).toBeUndefined();
  expect(f.agents).toEqual([]);
  expect(await readFile(join(project.cwd, "user-file"), "utf8")).toBe("preserved");
  await expect(readFile(obsolete)).rejects.toMatchObject({ code: "ENOENT" });
  expect(await f.server.rpc(connectionStatus, {}, f.paseo)).toMatchObject({
    sync: { status: "ready", retainedProjects: [{ name: "Product", cwd: project.cwd }] }, localData: { projects: 0, issues: 0, discussions: 0 },
  });
});

it.each(["background", "internal"] as const)("profile purge retains Paseo projects with %s user-created active workspaces", async visibility => {
  const f = await fixture({ respectVisibility: true });
  const project = f.projects[0], pluginWorkspace = f.workspaces[0];
  const userWorkspace = { id: "user-workspace", projectId: project.projectId, [visibility]: true };
  f.workspaces.push(userWorkspace);
  expect((await f.host.fetchWorkspaces()).entries.map(workspace => workspace.id)).not.toContain(userWorkspace.id);
  await f.login(1, f.primary.apiUrl, "office");
  f.server.setSettings(multicaSettings.id, { profile: "office" });
  expect((await waitForSync(f.server, f.paseo)).status).toBe("ready");
  expect(f.host.removeProject).not.toHaveBeenCalled();
  expect(f.projects).toContainEqual(project);
  expect(f.host.archiveWorkspace).toHaveBeenCalledExactlyOnceWith(pluginWorkspace.id);
  expect(f.workspaces.find(workspace => workspace.id === userWorkspace.id)?.archived).toBeUndefined();
});

it("profile purge deletes uncached internal Multica discussions tagged with the connection", async () => {
  const f = await fixture({ respectVisibility: true });
  const internalDiscussion = { ...f.agents[0], id: "internal-discussion", internal: true,
    labels: { ...f.agents[0].labels, "multica.discussion": "internal-thread" } };
  f.agents.push(internalDiscussion);
  expect((await f.host.fetchAgents()).entries.map(({ agent }) => agent.id)).not.toContain(internalDiscussion.id);
  await f.login(1, f.primary.apiUrl, "office");
  f.server.setSettings(multicaSettings.id, { profile: "office" });
  expect((await waitForSync(f.server, f.paseo)).status).toBe("ready");
  expect(f.host.deleteAgent).toHaveBeenCalledWith(internalDiscussion.id);
  expect(f.agents).toEqual([]);
});

it.each(["removes", "retains"] as const)("profile purge %s uncached Paseo projects and cleans workspaces under the placeholder root", async action => {
  const f = await fixture();
  const project = f.projects[0], workspace = f.workspaces[0];
  project.projectDisplayName = "Recovered project";
  workspace.workspaceDirectory = f.agents[0].cwd;
  f.workspaces.push({ id: "detached-workspace", projectId: "missing-project", workspaceDirectory: join(project.cwd, "detached") });
  if (action === "retains") f.workspaces.push({ id: "user-workspace", projectId: project.projectId });
  await writeFile(join(project.cwd, "user-file"), "preserved");
  const state = JSON.parse(await f.persisted()) as LocalState;
  for (const conn of Object.values(state.connections)) { conn.projects = {}; conn.issues = {}; }
  await writeFile(join(f.home, "state/state.json"), JSON.stringify(state));
  f.agents.length = 0;
  await f.restart();
  await f.login(1, f.primary.apiUrl, "office");
  f.server.setSettings(multicaSettings.id, { profile: "office" });
  expect(await f.server.syncRpc(syncBootstrap, {}, f.paseo)).toEqual({ status: "ready" });
  if (action === "removes") {
    expect(f.host.removeProject).toHaveBeenCalledExactlyOnceWith(project.projectId);
    expect(f.host.archiveWorkspace).toHaveBeenCalledWith(workspace.id);
    await expect(readFile(join(project.cwd, "user-file"))).rejects.toMatchObject({ code: "ENOENT" });
  } else {
    expect(f.host.removeProject).not.toHaveBeenCalled();
    expect(f.host.archiveWorkspace).toHaveBeenCalledWith(workspace.id);
    expect(f.workspaces.find(workspace => workspace.id === "user-workspace")?.archived).toBeUndefined();
    expect(await f.server.rpc(connectionStatus, {}, f.paseo)).toMatchObject({ sync: { retainedProjects: [{ name: project.projectDisplayName, cwd: project.projectRootPath }] } });
    expect(await readFile(join(project.cwd, "user-file"), "utf8")).toBe("preserved");
  }
  expect(workspace.archived).toBe(true);
  expect(f.host.archiveWorkspace).toHaveBeenCalledWith("detached-workspace");
});

it.each(["directory", "cached ID"])("profile purge archives workspaces identified by discussions discovered through %s", async source => {
  const f = await fixture();
  const project = f.projects[0], cachedWorkspace = f.workspaces[0], discussion = f.agents[0];
  project.projectRootPath = join(f.home, "user-project");
  f.workspaces.push({ id: "discussion-workspace", projectId: project.projectId });
  discussion.workspaceId = "discussion-workspace";
  if (source === "cached ID") {
    const list = f.host.fetchAgents.getMockImplementation()!;
    f.host.fetchAgents.mockImplementation(async input => {
      const page = await list(input);
      return { ...page, entries: page.entries.filter(({ agent }) => agent.id !== discussion.id) };
    });
  }
  await f.login(1, f.primary.apiUrl, "office");
  f.server.setSettings(multicaSettings.id, { profile: "office" });
  expect((await waitForSync(f.server, f.paseo)).status).toBe("ready");
  expect(f.host.removeProject).not.toHaveBeenCalled();
  expect(f.host.archiveWorkspace.mock.calls.map(([id]) => id).sort()).toEqual([cachedWorkspace.id, "discussion-workspace"].sort());
});

it("profile purge deletes all discussions and archives all plugin workspaces before removing any Paseo project", async () => {
  const f = await fixture();
  await f.login(2);
  await f.server.syncRpc(workspaceEnable, { workspaceId: "workspace", enabled: true }, f.paseo);
  const agentIds = f.agents.map(agent => agent.id), workspaceIds = f.workspaces.map(workspace => workspace.id);
  const removedProject = f.projects[0], retainedProject = f.projects[1];
  f.workspaces.push({ id: "user-workspace", projectId: retainedProject.projectId });
  const effects: string[] = [];
  const removeAgent = f.host.deleteAgent.getMockImplementation()!, archive = f.host.archiveWorkspace.getMockImplementation()!, removeProject = f.host.removeProject.getMockImplementation()!;
  f.host.deleteAgent.mockImplementation(async id => { effects.push(`deleteAgent:${id}`); await removeAgent(id); });
  f.host.archiveWorkspace.mockImplementation(async id => { effects.push(`archiveWorkspace:${id}`); return archive(id); });
  f.host.removeProject.mockImplementation(async id => { effects.push(`removeProject:${id}`); await removeProject(id); });
  await f.login(1, f.primary.apiUrl, "office");
  f.server.setSettings(multicaSettings.id, { profile: "office" });
  expect((await waitForSync(f.server, f.paseo)).status).toBe("ready");
  expect(effects).toEqual([
    ...agentIds.map(id => `deleteAgent:${id}`),
    ...workspaceIds.map(id => `archiveWorkspace:${id}`),
    `removeProject:${removedProject.projectId}`,
  ]);
  expect(f.projects).toEqual([retainedProject]);
  expect(f.workspaces.find(workspace => workspace.id === "user-workspace")?.archived).toBeUndefined();
});

it("profile purge rechecks every active workspace page after archive and retains a project with a newly created internal user workspace", async () => {
  const f = await fixture({ respectVisibility: true });
  const project = f.projects[0], pluginWorkspace = f.workspaces[0];
  f.workspaces.push({ id: "unrelated-workspace", projectId: "user-project" });
  const list = f.host.fetchWorkspaces.getMockImplementation()!;
  f.host.fetchWorkspaces.mockImplementation(async input => {
    const page = await list(input);
    const offset = Number((input as { page?: { cursor?: string } } | undefined)?.page?.cursor ?? 0);
    const hasMore = offset + 1 < page.entries.length;
    return { entries: page.entries.slice(offset, offset + 1), pageInfo: { hasMore, nextCursor: hasMore ? String(offset + 1) : undefined } };
  });
  const archive = f.host.archiveWorkspace.getMockImplementation()!;
  f.host.archiveWorkspace.mockImplementation(async id => {
    const result = await archive(id);
    if (id === pluginWorkspace.id) f.workspaces.push({ id: "new-user-workspace", projectId: project.projectId, internal: true });
    return result;
  });
  await f.login(1, f.primary.apiUrl, "office");
  f.server.setSettings(multicaSettings.id, { profile: "office" });
  expect((await waitForSync(f.server, f.paseo)).status).toBe("ready");
  expect(f.host.archiveWorkspace).toHaveBeenCalledExactlyOnceWith(pluginWorkspace.id);
  expect(f.host.removeProject).not.toHaveBeenCalled();
  const userWorkspace = f.workspaces.find(workspace => workspace.id === "new-user-workspace");
  expect(userWorkspace).toMatchObject({ internal: true });
  expect(userWorkspace?.archived).toBeUndefined();
  expect(f.host.fetchWorkspaces).toHaveBeenLastCalledWith({ filter: { includeBackground: true, includeInternal: true }, page: { limit: 100, cursor: "1" } });
  expect(await f.server.rpc(connectionStatus, {}, f.paseo)).toMatchObject({ sync: { retainedProjects: [{ name: "Product", cwd: project.cwd }] } });
});

it("a failed partial purge preserves its owner, blocks synchronization, restores and rule writes, then resumes on bootstrap", async () => {
  const f = await fixture({ askuser: true });
  const original = f.address();
  const store = new StateStore(join(f.home, "state"));
  const detailsDirectory = store.runDetailsDirectory(original.connectionKey);
  await mkdir(detailsDirectory, { recursive: true });
  await writeFile(join(detailsDirectory, "cached.json"), "cached");
  const oldIds = f.agents.map(agent => agent.id);
  const remove = f.host.deleteAgent.getMockImplementation()!;
  let attempts = 0;
  f.host.deleteAgent.mockImplementation(async id => { if (++attempts > 1) throw new Error("native storage unavailable"); await remove(id); });
  await f.login(1, f.primary.apiUrl, "office");
  const reads = f.requests.filter(request => request.path === "/api/issues").length;
  f.server.setSettings(multicaSettings.id, { profile: "office" });
  expect(await waitForSync(f.server, f.paseo)).toMatchObject({ status: "unavailable", stage: "purging", message: expect.stringContaining("清理旧 profile 本地数据失败") });
  expect(JSON.parse(await f.persisted()).owner).toEqual({ profile: "" });
  expect(f.agents).toHaveLength(1);
  expect((await f.server.rpc(workspaceList, {}, f.paseo)).workspaces[0]).toMatchObject({ enabled: false, importedCount: 0 });
  expect(await hiddenObjects(f.server, f.paseo)).toEqual([]);
  expect(await f.server.rpc(workspaceRule, { workspaceId: "workspace", rule: taskRuleSchema.parse({}) }, f.paseo)).toMatchObject({ status: "unavailable" });
  expect(await f.server.rpc(workspaceEnable, { workspaceId: "workspace", enabled: true }, f.paseo)).toMatchObject({ status: "unavailable" });
  expect(await f.server.rpc(hiddenRestore, original, f.paseo)).toMatchObject({ status: "unavailable" });
  await expect(f.server.rpc(askuserReopen, { ...original, commentId: "root", attachmentId: "question" }, f.paseo)).rejects.toThrow("正在清理");
  expect(f.requests.filter(request => request.path === "/api/issues")).toHaveLength(reads);
  expect(JSON.parse(await f.persisted()).owner).toEqual({ profile: "" });
  f.host.deleteAgent.mockImplementation(remove);
  await f.server.syncRpc(syncBootstrap, {}, f.paseo);
  expect(JSON.parse(await f.persisted())).toEqual({ version: 1, owner: { profile: "office" }, connections: {} });
  await expect(readFile(join(detailsDirectory, "cached.json"))).rejects.toMatchObject({ code: "ENOENT" });
  expect(f.host.deleteAgent.mock.calls.map(([id]) => id)).toEqual(expect.arrayContaining(oldIds));
  expect(f.agents).toEqual([]); expect(f.projects).toEqual([]); expect(f.posts).toEqual([]);
});

it("legacy state adopts the first ready profile without deleting any connections, then purges on its first switch", async () => {
  const f = await fixture();
  await f.login(2);
  await f.server.syncRpc(workspaceEnable, { workspaceId: "workspace", enabled: true }, f.paseo);
  await f.restart(true);
  expect(JSON.parse(await f.persisted()).owner).toBeUndefined();
  await f.server.rpc(connectionStatus, {}, f.paseo);
  expect(JSON.parse(await f.persisted()).owner).toEqual({ profile: "" });
  expect(Object.keys(JSON.parse(await f.persisted()).connections)).toHaveLength(2);
  expect(f.host.deleteAgent).not.toHaveBeenCalled();
  await f.login(1, f.primary.apiUrl, "office");
  f.server.setSettings(multicaSettings.id, { profile: "office" });
  await f.server.syncRpc(syncBootstrap, {}, f.paseo);
  expect(f.host.deleteAgent).toHaveBeenCalledTimes(4);
  expect(f.host.removeProject).toHaveBeenCalledTimes(2);
  expect(JSON.parse(await f.persisted())).toMatchObject({ owner: { profile: "office" }, connections: {} });
});

it("read-only status and bootstrap on an empty state do not create state.json, and invalid settings never purge", async () => {
  const f = await fixture({ empty: true });
  await f.server.rpc(connectionStatus, {}, f.paseo);
  await f.server.syncRpc(syncBootstrap, {}, f.paseo);
  await expect(f.persisted()).rejects.toMatchObject({ code: "ENOENT" });
  await f.server.syncRpc(workspaceEnable, { workspaceId: "workspace", enabled: true }, f.paseo);
  f.server.setSettings(multicaSettings.id, { profile: "../invalid" });
  expect(await f.server.rpc(connectionStatus, {}, f.paseo)).toMatchObject({ status: "invalid_settings" });
  await f.server.syncRpc(syncBootstrap, {}, f.paseo);
  expect(f.host.deleteAgent).not.toHaveBeenCalled();
  expect(JSON.parse(await f.persisted()).owner).toEqual({ profile: "" });
});

it("purges mapped discussions omitted from the directory and archives plugin workspaces whose Project is already absent", async () => {
  const f = await fixture();
  f.projects.length = 0;
  f.host.fetchAgents.mockResolvedValue({ entries: [], pageInfo: { hasMore: false, nextCursor: undefined } });
  await f.login(1, f.primary.apiUrl, "office");
  f.server.setSettings(multicaSettings.id, { profile: "office" });
  await waitForSync(f.server, f.paseo);
  expect(f.host.deleteAgent).toHaveBeenCalledTimes(2);
  expect(f.host.archiveWorkspace).toHaveBeenCalledExactlyOnceWith(f.workspaces[0].id);
  expect(JSON.parse(await f.persisted())).toMatchObject({ owner: { profile: "office" }, connections: {} });
});

it.each(["agents", "workspaces"])("cyclic %s pagination keeps ownership and can be retried without incomplete cleanup", async directory => {
  const f = await fixture();
  const method = directory === "agents" ? f.host.fetchAgents : f.host.fetchWorkspaces;
  const original = method.getMockImplementation()!;
  method.mockImplementation(async () => ({ entries: [], pageInfo: { hasMore: true, nextCursor: "cycle" } }));
  await f.login(1, f.primary.apiUrl, "office");
  f.server.setSettings(multicaSettings.id, { profile: "office" });
  expect(await waitForSync(f.server, f.paseo)).toMatchObject({ status: "unavailable", stage: "purging" });
  expect(JSON.parse(await f.persisted()).owner).toEqual({ profile: "" });
  expect(f.host.removeProject).not.toHaveBeenCalled();
  method.mockImplementation(original as never);
  await f.server.syncRpc(syncBootstrap, {}, f.paseo);
  expect(JSON.parse(await f.persisted())).toMatchObject({ owner: { profile: "office" }, connections: {} });
});

it("scans every native page, deletes only matching Multica discussions and holds them throughout deletion", async () => {
  const f = await fixture();
  const original = f.address();
  const pluginAgents = [...f.agents];
  const otherProvider = { ...pluginAgents[0], id: "user-agent", provider: "codex" };
  const otherConnection = { ...pluginAgents[0], id: "foreign-agent", labels: { ...pluginAgents[0].labels, "multica.connection": "foreign" } };
  f.agents.push(otherProvider, otherConnection);
  f.host.fetchAgents.mockImplementation(async input => {
    const cursor = (input as { page: { cursor?: string } }).page.cursor;
    return { entries: (cursor ? [pluginAgents[1]] : [pluginAgents[0], otherProvider, otherConnection]).map(agent => ({ agent })),
      pageInfo: { hasMore: !cursor, nextCursor: cursor ? undefined : "second" } };
  });
  const userWorkspace = { id: "user-workspace", projectId: f.projects[0].projectId };
  f.workspaces.push(userWorkspace);
  const pluginWorkspace = f.workspaces[0];
  f.host.fetchWorkspaces.mockImplementation(async input => {
    const cursor = (input as { page: { cursor?: string } }).page.cursor;
    return { entries: cursor ? [userWorkspace] : [pluginWorkspace], pageInfo: { hasMore: !cursor, nextCursor: cursor ? undefined : "second" } };
  });
  const remove = f.host.deleteAgent.getMockImplementation()!;
  f.host.deleteAgent.mockImplementation(async id => {
    const agent = pluginAgents.find(agent => agent.id === id)!;
    await (await f.connect()).send({ type: "session.open", requestId: "racing-purge-open", sessionId: `racing-${id}`, history: "replay",
      persistence: { version: 1, data: { ...original, discussion: "thread" } }, config: { cwd: agent.cwd, env: {}, mcpServers: {}, settings: {}, persist: true } });
    await remove(id);
  });
  await f.login(1, f.primary.apiUrl, "office");
  f.server.setSettings(multicaSettings.id, { profile: "office" });
  await waitForSync(f.server, f.paseo);
  expect(f.host.deleteAgent.mock.calls.map(([id]) => id)).toEqual(pluginAgents.map(agent => agent.id));
  expect(f.agents.map(agent => agent.id)).toEqual([otherProvider.id, otherConnection.id]);
  expect(f.events).toContainEqual(expect.objectContaining({ type: "request.failed", requestId: "racing-purge-open", error: expect.objectContaining({ code: "discussion_unavailable" }) }));
  expect(f.host.removeProject).not.toHaveBeenCalled();
  expect(f.host.archiveWorkspace).toHaveBeenCalledExactlyOnceWith(pluginWorkspace.id);
  expect(f.posts).toEqual([]);
});

it("an archive failure retains ownership and the user Project directory until bootstrap can retry", async () => {
  const f = await fixture();
  const project = f.projects[0];
  f.workspaces.push({ id: "user-workspace", projectId: project.projectId });
  f.host.archiveWorkspace.mockResolvedValueOnce({ error: "native archive failed" });
  await f.login(1, f.primary.apiUrl, "office");
  f.server.setSettings(multicaSettings.id, { profile: "office" });
  expect(await waitForSync(f.server, f.paseo)).toMatchObject({ status: "unavailable", stage: "purging" });
  expect(JSON.parse(await f.persisted()).owner).toEqual({ profile: "" });
  await writeFile(join(project.cwd, "user-file"), "preserved");
  await f.server.syncRpc(syncBootstrap, {}, f.paseo);
  expect(JSON.parse(await f.persisted()).owner).toEqual({ profile: "office" });
  expect(await readFile(join(project.cwd, "user-file"), "utf8")).toBe("preserved");
  expect((await f.server.rpc(connectionStatus, {}, f.paseo)).sync.retainedProjects).toEqual([{ name: "Product", cwd: project.cwd }]);
});

it("cleans the old profile before attempting to authenticate an unavailable target profile", async () => {
  const f = await fixture();
  f.server.setSettings(multicaSettings.id, { profile: "missing" });
  expect(await waitForSync(f.server, f.paseo)).toMatchObject({ status: "unavailable", stage: "connection" });
  expect(JSON.parse(await f.persisted())).toEqual({ version: 1, owner: { profile: "missing" }, connections: {} });
  expect(f.host.deleteAgent).toHaveBeenCalledTimes(2);
  expect(f.host.removeProject).toHaveBeenCalledTimes(1);
  expect(f.posts).toEqual([]);
});

it("excludes previously removed Projects from the confirmation counts", async () => {
  const f = await fixture();
  await f.server.syncRpc(workspaceEnable, { workspaceId: "workspace", enabled: false }, f.paseo);
  expect(f.host.removeProject).toHaveBeenCalledTimes(1);
  expect((await f.server.rpc(connectionStatus, {}, f.paseo)).localData?.projects).toBe(0);
});

it.each(["different root", "git", "missing project IDs"])("archives plugin workspaces when Project removal is skipped for %s", async reason => {
  const f = await fixture();
  const project = f.projects[0], workspace = f.workspaces[0];
  f.workspaces.push({ id: "user-workspace", projectId: project.projectId });
  if (reason === "different root") project.projectRootPath = join(f.home, "user-project");
  else if (reason === "git") project.projectKind = "git";
  else {
    const state = JSON.parse(await f.persisted()) as LocalState;
    for (const conn of Object.values(state.connections)) {
      for (const project of Object.values(conn.projects)) delete project.projectId;
      for (const issue of Object.values(conn.issues)) delete issue.projectId;
    }
    await writeFile(join(f.home, "state/state.json"), JSON.stringify(state));
    await f.restart();
  }
  await f.login(1, f.primary.apiUrl, "office");
  f.server.setSettings(multicaSettings.id, { profile: "office" });
  expect(await f.server.syncRpc(syncBootstrap, {}, f.paseo)).toEqual({ status: "ready" });
  expect(f.host.removeProject).not.toHaveBeenCalled();
  expect(f.host.archiveWorkspace).toHaveBeenCalledExactlyOnceWith(workspace.id);
  expect(f.workspaces.find(workspace => workspace.id === "user-workspace")?.archived).toBeUndefined();
  expect(JSON.parse(await f.persisted()).connections).toEqual({});
});

it("rejects rebuild during profile purge, retains its owner, and keeps Run polling alive for the next profile", async () => {
  const f = await fixture();
  const connectionKey = f.address().connectionKey;
  await f.login(1, f.primary.apiUrl, "office");
  const gate = pause(), remove = f.host.deleteAgent.getMockImplementation()!;
  f.host.deleteAgent.mockImplementation(async id => { await gate.handler(); await remove(id); });
  f.server.setSettings(multicaSettings.id, { profile: "office" });
  try {
    await gate.waiting;
    expect(JSON.parse(await f.persisted()).owner).toEqual({ profile: "" });
    await expect(f.server.rpc(rebuildPreflight, { connectionKey }, f.paseo)).rejects.toThrow("清理旧 profile");
    await expect(f.server.rpc(rebuildStart, { connectionKey }, f.paseo)).rejects.toThrow("清理旧 profile");
  } finally { gate.release(); }
  await waitForSync(f.server, f.paseo);
  expect(JSON.parse(await f.persisted()).owner).toEqual({ profile: "office" });
  await f.server.syncRpc(workspaceEnable, { workspaceId: "workspace", enabled: true }, f.paseo);
  const parent = f.agents.find(agent => agent.labels["multica.discussion"] === "root")!;
  await f.server.rpc(threadOpen, f.address(), f.paseo);
  f.messages.push({ task_id: "run", issue_id: "issue", seq: 1, type: "text", content: "New profile periodic output" });
  await expect.poll(() => f.events.some(event => event.type === "timeline.item" && event.sessionId === `${parent.id}:run:run` && event.item.type === "assistant_message" && event.item.text === "New profile periodic output"), { timeout: 4000 }).toBe(true);
});
