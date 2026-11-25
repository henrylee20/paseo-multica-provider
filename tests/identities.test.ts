import { createServer } from "node:http";
import { createRequire } from "node:module";
import { randomUUID } from "node:crypto";
import { mkdtemp, mkdir, writeFile, readFile, rm, rename } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import type { PaseoApi } from "@getpaseo/client";
import type { DaemonClient } from "@getpaseo/client/internal/daemon-client";
import type { ProviderConnection, ProviderEvent } from "@getpaseo/plugin/server/provider";
import { workspaceEnable, syncBootstrap, connectionStatus, multicaSettings, workspaceList } from "../shared/contracts.js";
import { deliveryMentions } from "../shared/delivery.js";
import { hiddenList } from "../shared/hiding.js";
import { threadOpen } from "../shared/threads.js";
import { createServerContribution } from "../server/contribute.js";
import type { LocalState } from "../server/state.js";
import { FakeServer } from "./support/fake-server.js";
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

async function fixture() {
  const home = await mkdtemp(join(tmpdir(), "multica-identities-"));
  cleanup.push(() => rm(home, { recursive: true, force: true }));
  // Ephemeral opaque fixture credentials are compared only as booleans, never
  // printed by assertion diffs or returned through the contribution boundary.
  const credentials = [randomUUID(), randomUUID(), randomUUID()];
  const requests: Array<{ path: string; actor: string; method: string }> = [];
  const posts: Array<{ actor: string; path: string }> = [];
  let beforeWorkspaces: (() => Promise<void>) | undefined;
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
      } else if (url.pathname === "/api/me") body = { id: actor, name: actor === "me" ? "Lin" : "Kai" };
      else if (url.pathname === "/api/workspaces") { await beforeWorkspaces?.(); body = [{ id: "workspace", name: "Product", slug: "product" }]; }
      else if (url.pathname === "/api/issues") body = { issues: [{ id: "issue", workspace_id: "workspace", title: "Task", description: "Description", status: "todo" }], total: 1 };
      else if (url.pathname === "/api/issues/issue/task-runs") body = [{ id: "run", issue_id: "issue", agent_id: "agent", status: "running", trigger_comment_id: "root" }];
      else if (url.pathname === "/api/issues/issue/comments") body = [{ id: "root", issue_id: "issue", parent_id: null, content: "Original Lin comment", author_id: "me", author_type: "member", type: "comment", created_at: "2026-11-24T10:00:00Z", updated_at: "2026-11-24T10:00:00Z", attachments: [] }];
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
  const projects: Array<{ projectId: string; cwd: string }> = [];
  const workspaces: Array<{ id: string }> = [];
  const agents: Array<{ id: string; workspaceId: string; cwd: string; labels: Record<string, string>; archivedAt?: string }> = [];
  let provider: ProviderConnection | undefined;
  const server = new FakeServer();
  const connect = async () => {
    if (!provider) { provider = await server.providers.get("multica")!.connect({ versions: [1], capabilities: ["session.persistence", "prompt.message", "prompt.steer", "timeline.plugin"] }); provider.onEvent(event => { events.push(event); }); }
    return provider;
  };
  const host = {
    listHosts: async () => ({ self: { serverId: "daemon" } }),
    listProjects: async () => ({ projects: [] }),
    addProject: async (cwd: string) => { let project = projects.find(value => value.cwd === cwd); if (!project) { project = { projectId: `project-${projects.length}`, cwd }; projects.push(project); } return { project: { ...project, projectKind: "non_git" } }; },
    renameProject: async () => {}, fetchWorkspaces: async () => ({ entries: workspaces, pageInfo: { hasMore: false } }),
    createWorkspace: async (input: { workspaceId: string }) => { const workspace = { id: input.workspaceId }; workspaces.push(workspace); return { workspace }; }, setWorkspaceTitle: async () => {},
    fetchAgents: async () => ({ entries: agents.map(agent => ({ agent: { provider: "multica", ...agent } })), pageInfo: { hasMore: false } }),
    fetchAgent: async (id: string) => ({ agent: agents.find(agent => agent.id === id)! }),
    fetchAgentTimeline: async (agentId: string) => ({ agentId, epoch: "epoch", entries: [], hasOlder: false, hasNewer: false }),
    importAgent: async (input: { workspaceId: string; cwd: string; labels: Record<string, string>; providerHandleId: string }) => {
      const agent = { id: `native-${agents.length}`, workspaceId: input.workspaceId, cwd: input.cwd, labels: input.labels }; agents.push(agent);
      await (await connect()).send({ type: "session.open", requestId: agent.id, sessionId: agent.id, history: "replay", persistence: JSON.parse(input.providerHandleId.slice(7)), config: { cwd: agent.cwd, env: {}, mcpServers: {}, settings: {}, persist: true } }); return agent;
    }, updateAgent: async () => {}, close: async () => {},
  } as unknown as DaemonClient;
  const paseo = { agents: { ref: () => ({}) }, hosts: { list: async () => ({ self: { serverId: "daemon" } }) } } as unknown as PaseoApi;
  const dispose = createServerContribution({ homeDirectory: home, stateDirectory: join(home, "state"), workingDirectory: home, environment: { PASEO_HOME: home }, connectHost: async () => host, syncIntervalMs: 60_000 })(server.context);
  cleanup.push(dispose); cleanup.push(async () => { await provider?.close(); });
  await server.rpc(workspaceEnable, { workspaceId: "workspace", enabled: true }, paseo);
  const address = (connectionKey = agents[0].labels["multica.connection"]) => ({ connectionKey, issueId: "issue", rootId: "root" });
  const send = async (clientMessageId: string) => {
    const agent = agents.find(agent => agent.labels["multica.connection"] === address().connectionKey && agent.labels["multica.discussion"] === "root")!;
    await (await connect()).send({ type: "session.prompt", sessionId: agent.id, prompt: { clientMessageId, delivery: "steer", input: { type: "message", content: [{ type: "text", text: "Preserve original input" }] } } });
  };
  return { home, server, paseo, events, projects, workspaces, agents, posts, requests, address, send, login, primary, secondary, connect,
    historyReader: () => {
      const server = new FakeServer();
      cleanup.push(createServerContribution({ homeDirectory: home, stateDirectory: join(home, "state"), workingDirectory: home, environment: { PASEO_HOME: home } })(server.context));
      return server;
    },
    blockWorkspaces: (handler?: () => Promise<void>) => { beforeWorkspaces = handler; },
    secretAbsent: (value: unknown) => credentials.every(credential => !JSON.stringify(value).includes(credential)),
    persisted: () => readFile(join(home, "state/state.json"), "utf8") };
}

it("logout during connection setup prevents an accepted old input from reaching the remote service", async () => {
  const f = await fixture();
  const gate = pause(); f.blockWorkspaces(gate.handler);
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
  await f.server.rpc(syncBootstrap, {}, f.paseo);
  await expect(f.server.rpc(deliveryMentions, { connectionKey: f.address().connectionKey, issueId: "issue" }, f.paseo)).rejects.toThrow();
  expect(f.requests.length).toBe(before);
});

it("credential rotation reuses history while account and service switches isolate mappings, roles, hiding and pending work", async () => {
  const f = await fixture();
  const original = f.address();
  const originalThread = f.agents.find(agent => agent.labels["multica.discussion"] === "root")!;
  await f.server.rpc(threadOpen, original, f.paseo);
  await (await f.connect()).send({ type: "session.interrupt", requestId: "stop-original", sessionId: originalThread.id });
  originalThread.archivedAt = "2026-11-24T10:05:00Z";
  await f.server.hook("agent.archive.after", { agent: { id: originalThread.id, provider: "multica", workspaceId: originalThread.workspaceId, cwd: originalThread.cwd, parentAgentId: null, title: null }, archivedAt: originalThread.archivedAt }, f.paseo);
  const hidden = await f.server.rpc(hiddenList, {}, f.paseo);
  const originalIds = { projects: f.projects.map(value => value.projectId), workspaces: f.workspaces.map(value => value.id), agents: f.agents.map(value => value.id) };

  await f.login(1);
  expect(await f.server.rpc(connectionStatus, {}, f.paseo)).toMatchObject({ connectionKey: original.connectionKey });
  await f.server.rpc(syncBootstrap, {}, f.paseo);
  expect({ projects: f.projects.map(value => value.projectId), workspaces: f.workspaces.map(value => value.id), agents: f.agents.map(value => value.id) }).toEqual(originalIds);
  expect(await f.server.rpc(hiddenList, {}, f.paseo)).toEqual(hidden);
  await f.login(1, f.primary.apiUrl, "same-account");
  f.server.setSettings(multicaSettings.id, { profile: "same-account" });
  await f.server.rpc(syncBootstrap, {}, f.paseo);
  expect((await f.server.rpc(connectionStatus, {}, f.paseo)).connectionKey).toBe(original.connectionKey);
  expect(f.agents.map(value => value.id)).toEqual(originalIds.agents);

  await f.login(2, f.primary.apiUrl, "office");
  f.server.setSettings(multicaSettings.id, { profile: "office" });
  const other = await f.server.rpc(connectionStatus, {}, f.paseo);
  expect(other.connectionKey).not.toBe(original.connectionKey);
  expect((await f.server.rpc(workspaceList, {}, f.paseo)).workspaces[0].enabled).toBe(false);
  await f.server.rpc(workspaceEnable, { workspaceId: "workspace", enabled: true }, f.paseo);
  const otherThread = f.agents.find(agent => agent.labels["multica.connection"] === other.connectionKey && agent.labels["multica.discussion"] === "root")!;
  expect(otherThread.workspaceId).not.toBe(originalThread.workspaceId);
  await f.server.rpc(threadOpen, f.address(other.connectionKey), f.paseo);
  expect(f.events).toContainEqual(expect.objectContaining({ type: "timeline.item", sessionId: otherThread.id, item: expect.objectContaining({ type: "assistant_message", text: "Lin: \n\nOriginal Lin comment" }) }));
  const beforeRetry = f.posts.length;
  await f.send("old-tab-new-account");
  await expect.poll(() => f.events.some(event => event.type === "timeline.item" && event.item.type === "error")).toBe(true);
  expect(f.posts.length).toBe(beforeRetry);

  f.server.setSettings(multicaSettings.id, { profile: "" });
  await f.login(0, f.secondary.apiUrl);
  const otherService = await f.server.rpc(connectionStatus, {}, f.paseo);
  expect(otherService.connectionKey).not.toBe(original.connectionKey);
  expect(otherService.connectionKey).not.toBe(other.connectionKey);
  expect((await f.server.rpc(workspaceList, {}, f.paseo)).workspaces[0].enabled).toBe(false);
  await f.server.rpc(workspaceEnable, { workspaceId: "workspace", enabled: true }, f.paseo);
  expect(f.projects).toHaveLength(3);
  expect(f.workspaces).toHaveLength(3);
  expect(f.agents).toHaveLength(6);

  // Replaying the original namespace while another service is current keeps
  // both native author semantics and the original Run owner.
  await (await f.connect()).send({ type: "session.open", requestId: "old-replay", sessionId: "old-replay", history: "replay", persistence: { version: 1, data: { connectionKey: original.connectionKey, issueId: "issue", discussion: "thread", rootId: "root" } }, config: { cwd: originalThread.cwd, env: {}, mcpServers: {}, settings: {}, persist: true } });
  expect(f.events).toContainEqual(expect.objectContaining({ type: "timeline.item", sessionId: "old-replay", item: expect.objectContaining({ type: "user_message", messageId: "root", text: "Original Lin comment" }) }));
  expect(f.events).toContainEqual(expect.objectContaining({ type: "timeline.item", sessionId: "old-replay", item: expect.objectContaining({ type: "plugin", kind: "run-summary", data: expect.objectContaining({ ...original, runId: "run" }) }) }));
  expect(await f.server.rpc(hiddenList, {}, f.paseo)).toEqual(hidden);

  await f.login(1);
  await f.server.rpc(syncBootstrap, {}, f.paseo);
  expect((await f.server.rpc(connectionStatus, {}, f.paseo)).connectionKey).toBe(original.connectionKey);
  expect(f.agents).toHaveLength(6);
  expect(originalThread.archivedAt).toBeTruthy();
  expect(f.secretAbsent([f.events, await f.persisted()])).toBe(true);
});

it("an account switch during Stop setup fails without sending an old cancellation", async () => {
  const f = await fixture();
  const gate = pause(); f.blockWorkspaces(gate.handler);
  const thread = f.agents.find(agent => agent.labels["multica.discussion"] === "root")!;
  const stopping = (await f.connect()).send({ type: "session.interrupt", requestId: "switch-during-stop", sessionId: thread.id });
  await gate.waiting; await f.login(2); gate.release(); await stopping;
  expect(f.posts).toEqual([]);
  expect(f.events).toContainEqual(expect.objectContaining({ type: "request.failed", requestId: "switch-during-stop" }));
});

it("a management action opened under an old account cannot enable rules for a newly selected account", async () => {
  const f = await fixture();
  const original = f.address().connectionKey;
  await f.login(2);
  const enable = defineRpc({ name: "workspace.enable", input: workspaceEnable.input.extend({ connectionKey: z.string() }), output: workspaceEnable.output });
  expect(await f.server.rpc(enable, { workspaceId: "workspace", enabled: true, connectionKey: original }, f.paseo)).toMatchObject({ status: "unavailable" });
  expect((await f.server.rpc(workspaceList, {}, f.paseo)).workspaces[0].enabled).toBe(false);
});
