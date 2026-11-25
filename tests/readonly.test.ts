import { createServer } from "node:http";
import { mkdtemp, mkdir, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import type { PaseoApi } from "@getpaseo/client";
import type { DaemonClient } from "@getpaseo/client/internal/daemon-client";
import type { ProviderConnection, ProviderEvent } from "@getpaseo/plugin/server/provider";
import { defineRpc } from "@getpaseo/plugin";
import { z } from "zod";
import { workspaceEnable, syncBootstrap, syncStatus } from "../shared/contracts.js";
import { threadOpen } from "../shared/threads.js";
import { runOpen, runRead } from "../shared/runs.js";
import { hiddenList, hiddenRestore } from "../shared/hiding.js";
import { createServerContribution } from "../server/contribute.js";
import { FakeServer, resync } from "./support/fake-server.js";

const cleanup: Array<() => void | Promise<void>> = [];
afterEach(async () => { for (const dispose of cleanup.splice(0).reverse()) await dispose(); });
const stamp = "2026-11-24T10:00:00Z";
const comment = (id: string, parent_id: string | null, content: string) => ({ id, parent_id, content, author_id: "me", author_type: "member", issue_id: "issue", type: "comment", created_at: stamp, updated_at: stamp, attachments: [] });
const deliveryMentions = defineRpc({ name: "delivery.mentions", input: z.object({ connectionKey: z.string(), issueId: z.string() }), output: z.object({ agents: z.array(z.object({ id: z.string(), name: z.string(), reference: z.string() })) }) });
async function fixture(active = false, idempotent = false) {
  const home = await mkdtemp(join(tmpdir(), "multica-delivery-"));
  cleanup.push(() => rm(home, { recursive: true, force: true }));
  const comments = [comment("root", null, "Existing root")];
  const runs = active ? [{ id: "run", issue_id: "issue", agent_id: "agent", status: "running", trigger_comment_id: "root" }] : [];
  const posts: Array<{ path: string; body: unknown; key?: string; slug?: string }> = [];
  const receipts = new Map<string, ReturnType<typeof comment>>();
  const lookups: string[] = [];
  const deletedReceipts = new Set<string>();
  let lookupFailure: number | undefined;
  let clock = new Date("2026-11-24T10:00:00Z");
  let beforeLookup: ((key: string) => Promise<void>) | undefined;
  let identity = "me";
  const remote = { visible: true, objectStatus: 200, invalidObject: false, listStatus: 200, authStatus: 200, disconnect: false, denial: "issue not found", expireOnObject: false };
  const issue = { id: "issue", workspace_id: "workspace", title: "Task", description: "Description", status: "todo" };
  let beforeMe: (() => Promise<void>) | undefined;
  let beforeWorkspaces: (() => Promise<void>) | undefined;
  let beforeCancel: (() => Promise<void>) | undefined;
  const requests: string[] = [];
  let post: (body: { content: string; parent_id?: string }) => Promise<{ status?: number; body?: unknown; disconnect?: boolean }> = async body => {
    const saved = comment(`saved-${posts.length}`, body.parent_id ?? null, body.content); comments.push(saved); return { body: saved };
  };
  const http = createServer(async (request, response) => {
    requests.push(request.url!);
    response.setHeader("Content-Type", "application/json");
    const url = new URL(request.url!, "http://localhost");
    let body: unknown;
    if (remote.authStatus !== 200) { response.statusCode = remote.authStatus; body = { error: "authentication failed" }; }
    else if (request.method === "POST") {
      let text = ""; for await (const chunk of request) text += chunk;
      const input = text ? JSON.parse(text) : {};
      posts.push({ path: url.pathname, body: input, key: request.headers["idempotency-key"] as string, slug: request.headers["x-workspace-slug"] as string });
      if (url.pathname.endsWith("/cancel")) { await beforeCancel?.(); runs[0].status = "cancelled"; body = runs[0]; }
      else {
        const key = request.headers["idempotency-key"] as string;
        const existing = idempotent ? receipts.get(key) : undefined;
        const result = existing ? { body: existing } : await post(input);
        if (idempotent && result.body && (result.body as { type?: string }).type === "comment") receipts.set(key, result.body as ReturnType<typeof comment>);
        if (result.disconnect) { response.destroy(); return; } response.statusCode = result.status ?? 200; body = result.body ?? {}; }
    } else if (url.pathname === "/api/me") { await beforeMe?.(); response.statusCode = remote.authStatus; body = { id: identity, name: "Lin" }; }
    else if (url.pathname === "/api/issues/issue") { response.statusCode = remote.objectStatus; body = remote.objectStatus === 200 ? remote.invalidObject ? {} : issue : { error: remote.denial }; if (remote.expireOnObject) remote.authStatus = 401; }
    else if (url.pathname === "/api/workspaces") { const hold = beforeWorkspaces; beforeWorkspaces = undefined; await hold?.(); body = [{ id: "workspace", name: "Product", slug: "product" }]; }
    else if (url.pathname === "/api/issues") { if (remote.disconnect) { response.destroy(); return; } response.statusCode = remote.listStatus; body = { issues: remote.visible ? [issue] : [], total: remote.visible ? 1 : 0 }; }
    else if (url.pathname === "/api/tasks/run/messages") body = [{ task_id: "run", issue_id: "issue", seq: 1, type: "text", content: "Cached execution output" }];
    else if (url.pathname === "/api/issues/issue/task-runs") body = runs;
    else if (url.pathname === "/api/issues/issue/comments/idempotent" && idempotent) {
      const key = request.headers["idempotency-key"] as string; lookups.push(key); await beforeLookup?.(key);
      const receipt = receipts.get(key);
      if (lookupFailure) { response.statusCode = lookupFailure; body = {}; }
      else if (deletedReceipts.has(key)) { response.statusCode = 409; body = { error: "the comment created with this Idempotency-Key has been deleted" }; }
      else if (receipt) { response.setHeader("Idempotent-Replayed", "true"); body = receipt; }
      else { response.statusCode = 404; body = { error: "no comment has been posted with this Idempotency-Key" }; }
    }
    else if (url.pathname === "/api/issues/issue/comments") body = url.searchParams.has("thread") ? comments.filter(c => c.id === url.searchParams.get("thread") || c.parent_id === url.searchParams.get("thread")) : comments;
    else if (url.pathname === "/api/agents") body = [{ id: "12345678-1234-4234-9234-123456789abc", name: "Agent [A]" }, { id: "22345678-1234-4234-9234-123456789abc", name: "Agent [A]" }];
    else { response.statusCode = 404; body = {}; }
    response.end(JSON.stringify(body));
  });
  await new Promise<void>(resolve => http.listen(0, "127.0.0.1", resolve));
  cleanup.push(() => new Promise<void>(resolve => { http.close(() => resolve()); http.closeAllConnections(); }));
  await mkdir(join(home, ".multica"));
  await writeFile(join(home, ".multica/config.json"), JSON.stringify({ server_url: `http://127.0.0.1:${(http.address() as { port: number }).port}`, token: "synthetic" }));
  const events: ProviderEvent[] = [];
  const canonical = new Map<string, Array<{ seqStart: number; seqEnd: number; item: Record<string, unknown> }>>();
  const nativeHistory = { persistOriginals: true };
  const agents: Array<{ id: string; provider: string; status: string; activeTurn?: { turnId: string } | null; workspaceId: string; cwd: string; labels: Record<string, string>; handle: string; archivedAt?: string | null }> = [];
  const native = { archived: false, restoreAgents: false, archiveStamp: "", archiveSequence: 0, completionReads: 0 };
  const nativeCompletions: Array<() => void> = [];
  let server: FakeServer;
  let provider: ProviderConnection | undefined;
  async function connect() {
    if (provider) return provider;
    provider = await server.providers.get("multica")!.connect({ versions: [1], capabilities: ["session.persistence", "prompt.message", "prompt.steer", "timeline.plugin"] });
    provider.onEvent(event => {
      events.push(event);
      if (event.type === "session.turn") {
        const agent = agents.find(agent => agent.id === event.sessionId)!;
        const apply = () => {
          agent.activeTurn = event.state === "started" ? { turnId: event.turnId } : null;
          agent.status = event.state === "started" ? "running" : "idle";
        };
        if (event.state !== "started" && native.completionReads > 0) nativeCompletions.push(apply); else apply();
      }
      if (event.type !== "timeline.item") return;
      const entries = canonical.get(event.sessionId) ?? [];
      const item = event.item;
      if (!nativeHistory.persistOriginals && (item.type === "user_message" || item.type === "assistant_message")) return;
      const existing = entries.find(entry => item.type === "user_message" && item.clientMessageId ? entry.item.clientMessageId === item.clientMessageId : entry.item.id === item.id);
      if (existing) existing.item = { ...item }; else entries.push({ seqStart: entries.length, seqEnd: entries.length, item: { ...item } });
      canonical.set(event.sessionId, entries);
    }); return provider;
  }
  const host = {
    listHosts: async () => ({ self: { serverId: "daemon" } }),
    listProjects: async () => ({ projects: [] }),
    addProject: async () => ({ project: { projectId: "project", projectKind: "non_git" } }), renameProject: async () => {},
    fetchWorkspaces: async () => ({ entries: native.archived || !agents.length ? [] : [{ id: agents[0].workspaceId }], pageInfo: { hasMore: false } }),
    archiveWorkspace: async () => {
      // Native archive-by-workspace skips contents when its record is already archived.
      if (native.archived) return {};
      native.archived = true;
      native.archiveStamp = new Date(Date.parse(stamp) + ++native.archiveSequence * 1000).toISOString();
      for (const agent of agents) {
        if (agent.archivedAt) continue;
        agent.archivedAt = native.archiveStamp;
        await server.hook("agent.archive.after", { agent: { ...agent, provider: "multica" } } as never, paseo);
      }
      await server.hook("workspace.archive.after", { workspace: { id: agents[0].workspaceId } } as never, paseo);
      return {};
    },
    restoreWorkspace: async () => {
      if (!native.archived) throw new Error("Already active");
      native.archived = false;
      if (!native.restoreAgents) return;
      // Current hosts restore exact workspace archive stamps, with a legacy
      // sixty-second fallback when every exact-stamped record was reopened.
      const exact = agents.filter(agent => agent.archivedAt === native.archiveStamp);
      const restored = exact.length ? exact : agents.filter(agent => agent.archivedAt &&
        Date.parse(native.archiveStamp) - Date.parse(agent.archivedAt) >= 0 && Date.parse(native.archiveStamp) - Date.parse(agent.archivedAt) <= 60_000);
      for (const agent of restored) agent.archivedAt = null;
    },
    fetchAgent: async (id: string) => {
      if (native.completionReads > 0) native.completionReads--;
      else for (const complete of nativeCompletions.splice(0)) complete();
      return { agent: agents.find(agent => agent.id === id) };
    },
    archiveAgent: async (id: string) => {
      const agent = agents.find(agent => agent.id === id)!;
      if (agent.status === "running" || agent.activeTurn) await (await connect()).send({ type: "session.interrupt", requestId: `archive-${id}`, sessionId: id });
      agent.archivedAt = new Date(Date.parse(stamp) + ++native.archiveSequence * 1000).toISOString();
      await server.hook("agent.archive.after", { agent: { ...agent, provider: "multica" } } as never, paseo);
      return { archivedAt: agent.archivedAt };
    },
    refreshAgent: async (id: string) => { const agent = agents.find(agent => agent.id === id)!; if (!agent.archivedAt) throw new Error("Active refresh interrupts"); agent.archivedAt = null; return { agent }; },
    createWorkspace: async (input: { workspaceId: string }) => ({ workspace: { id: input.workspaceId } }), setWorkspaceTitle: async () => {},
    fetchAgents: async () => ({ entries: agents.map(agent => ({ agent })), pageInfo: { hasMore: false } }),
    fetchAgentTimeline: async (agentId: string) => ({ agentId, epoch: "epoch", entries: canonical.get(agentId) ?? [], hasOlder: false, hasNewer: false }),
    importAgent: async (input: { workspaceId: string; cwd: string; labels: Record<string, string>; providerHandleId: string }) => {
      const agent = { id: `native-${agents.length}`, provider: "multica", status: "idle", workspaceId: input.workspaceId, cwd: input.cwd, labels: input.labels, handle: input.providerHandleId }; agents.push(agent);
      await (await connect()).send({ type: "session.open", requestId: agent.id, sessionId: agent.id, history: "replay", persistence: JSON.parse(agent.handle.slice(7)), config: { cwd: agent.cwd, env: {}, mcpServers: {}, settings: {}, persist: true } }); return agent;
    }, updateAgent: async () => {}, close: async () => {},
  } as unknown as DaemonClient;
  const paseo = { hosts: { list: async () => ({ self: { serverId: "daemon" } }) } } as unknown as PaseoApi;
  const start = () => { provider = undefined; server = new FakeServer(); const dispose = createServerContribution({ homeDirectory: home, workingDirectory: home, environment: { PASEO_HOME: home }, now: () => clock, connectHost: async () => host })(server.context); cleanup.push(dispose); return { server, dispose }; };
  const started = start(); cleanup.push(async () => { await provider?.close(); });
  await server!.rpc(workspaceEnable, { workspaceId: "workspace", enabled: true }, paseo);
  const send = async (rootId: string, text: string, clientMessageId: string, delivery: "auto" | "steer" = "auto") => {
    const agent = agents.find(agent => agent.labels["multica.discussion"] === rootId)!;
    await (await connect()).send({ type: "session.prompt", sessionId: agent.id, prompt: { clientMessageId, delivery, input: { type: "message", content: [{ type: "text", text }] } } });
  };
  return { ...started, native, host, remote, requests, home, paseo, agents, events, canonical, nativeHistory, comments, runs, posts, lookups, receipts, deletedReceipts, connect, send, start, lookupFailure: (status?: number) => { lookupFailure = status; }, advance: (milliseconds: number) => { clock = new Date(clock.getTime() + milliseconds); }, beforeLookup: (handler: typeof beforeLookup) => { beforeLookup = handler; }, identity: (id: string) => { identity = id; }, beforeMe: (handler?: () => Promise<void>) => { beforeMe = handler; }, beforeWorkspaces: (handler: () => Promise<void>) => { beforeWorkspaces = handler; }, beforeCancel: (handler: typeof beforeCancel) => { beforeCancel = handler; }, post: (handler: typeof post) => { post = handler; } };
}

it.each(["list failure", "network", "authentication"])("%s preserves active mappings without archiving cached issues", async failure => {
  const f = await fixture();
  if (failure === "list failure") f.remote.listStatus = 503;
  if (failure === "network") f.remote.disconnect = true;
  if (failure === "authentication") f.remote.authStatus = 401;
  expect(await resync(f.server, f.paseo, "workspace")).toMatchObject({ status: "unavailable" });
  expect(f.native.archived).toBe(false);
  if (failure !== "authentication") expect(await f.server.rpc(syncStatus, {}, f.paseo)).toMatchObject({ status: "unavailable" });
});

it.each(["all", "one"])("reconciles %s host-reopened filtered discussions without losing hidden tabs when the Issue returns to the filter", async reopened => {
  const f = await fixture(true);
  f.native.restoreAgents = true;
  if (reopened === "one") {
    f.comments.push(comment("other-visible", null, "Other visible discussion"));
    await resync(f.server, f.paseo, "workspace");
  }
  const main = f.agents.find(agent => agent.labels["multica.discussion"] === "main")!;
  const thread = f.agents.find(agent => agent.labels["multica.discussion"] === "root")!;
  const address = { connectionKey: main.labels["multica.connection"], issueId: "issue" };
  thread.archivedAt = stamp;
  await f.server.hook("agent.archive.after", { agent: { ...thread, provider: "multica" } } as never, f.paseo);
  const hidden = await f.server.rpc(hiddenList, {}, f.paseo);
  const identities = f.agents.map(agent => ({ id: agent.id, cwd: agent.cwd, handle: agent.handle }));
  f.remote.visible = false; f.remote.objectStatus = 404;
  await resync(f.server, f.paseo, "workspace");
  expect(f.native.archived).toBe(true);
  expect(main.archivedAt).toBeTruthy();

  // The native prompt route unarchives the agent before the provider can reject it.
  main.archivedAt = null;
  const history = structuredClone([...f.canonical]);
  f.remote.objectStatus = 200;
  await resync(f.server, f.paseo, "workspace");
  expect(main.archivedAt).toBeTruthy();
  expect(f.native.archived).toBe(true);
  await resync(f.server, f.paseo, "workspace");
  expect(f.posts).toEqual([]);
  expect(await f.server.rpc(hiddenList, {}, f.paseo)).toEqual(hidden);
  expect([...f.canonical]).toEqual(history);
  expect(f.agents.map(agent => ({ id: agent.id, cwd: agent.cwd, handle: agent.handle }))).toEqual(identities);

  f.remote.visible = true;
  await resync(f.server, f.paseo, "workspace");
  expect(f.native.archived).toBe(false);
  expect(main.archivedAt).toBeNull();
  expect(thread.archivedAt).toBeTruthy();
  expect(f.agents.filter(agent => agent !== thread).every(agent => !agent.archivedAt)).toBe(true);
  expect(await f.server.rpc(hiddenList, {}, f.paseo)).toEqual(hidden);
});

it("a successful list row restores a filtered issue without object reads", async () => {
  const f = await fixture();
  const main = f.agents.find(agent => agent.labels["multica.discussion"] === "main")!;
  f.remote.visible = false; f.remote.objectStatus = 404;
  await resync(f.server, f.paseo, "workspace");
  main.archivedAt = null;
  f.remote.visible = true; f.remote.objectStatus = 200; f.remote.invalidObject = true;
  const reads = f.requests.filter(path => path === "/api/issues/issue").length;
  await resync(f.server, f.paseo, "workspace");
  expect(main.archivedAt).toBeNull();
  expect(f.native.archived).toBe(false);
  expect(f.requests.filter(path => path === "/api/issues/issue")).toHaveLength(reads);
  expect(f.posts).toEqual([]);
});

it.each(["filter_exit", "rule_disabled"])("reconciles native reopen after %s across restart and retains the original discussion restore set", async reason => {
  const f = await fixture(true);
  const identities = f.agents.map(agent => ({ id: agent.id, cwd: agent.cwd, handle: agent.handle }));
  const main = f.agents.find(agent => agent.labels["multica.discussion"] === "main")!;
  if (reason === "rule_disabled") await f.server.rpc(workspaceEnable, { workspaceId: "workspace", enabled: false }, f.paseo);
  else {
    f.remote.visible = false;
    await resync(f.server, f.paseo, "workspace");
  }
  main.archivedAt = null;
  await f.dispose();
  const restarted = f.start();
  await resync(restarted.server, f.paseo, "workspace");
  expect(f.native.archived).toBe(true);
  expect(f.agents.every(agent => !!agent.archivedAt)).toBe(true);
  expect(f.posts).toEqual([]);
  f.remote.visible = true; f.remote.objectStatus = 200;
  if (reason === "rule_disabled") await restarted.server.rpc(workspaceEnable, { workspaceId: "workspace", enabled: true }, f.paseo);
  else await resync(restarted.server, f.paseo, "workspace");
  expect(f.native.archived).toBe(false);
  expect(f.agents.every(agent => !agent.archivedAt)).toBe(true);
  expect(f.agents.map(agent => ({ id: agent.id, cwd: agent.cwd, handle: agent.handle }))).toEqual(identities);
});

it("closes only the hidden projection before rearchiving a host-restored tab and rejects racing opens without Stop", async () => {
  const f = await fixture(true);
  f.native.restoreAgents = true;
  const main = f.agents.find(agent => agent.labels["multica.discussion"] === "main")!;
  const thread = f.agents.find(agent => agent.labels["multica.discussion"] === "root")!;
  const address = { connectionKey: thread.labels["multica.connection"], issueId: "issue", rootId: "root" };
  thread.archivedAt = stamp;
  await f.server.hook("agent.archive.after", { agent: { ...thread, provider: "multica" } } as never, f.paseo);
  f.remote.visible = false; f.remote.objectStatus = 404;
  await resync(f.server, f.paseo, "workspace");
  main.archivedAt = null;
  f.remote.objectStatus = 200;
  await resync(f.server, f.paseo, "workspace");
  f.native.completionReads = 2;
  const archive = f.host.archiveAgent.bind(f.host);
  f.host.archiveAgent = async id => {
    // This native command would interrupt a still-active aggregate. Native
    // snapshot reads must acknowledge its completion before we get here.
    expect(thread.status).toBe("idle");
    expect(thread.activeTurn).toBeNull();
    const connection = await f.connect();
    await connection.send({ type: "session.open", requestId: "racing-hidden-open", sessionId: id, history: "skip", persistence: JSON.parse(thread.handle.slice(7)), config: { cwd: thread.cwd, env: {}, mcpServers: {}, settings: {}, persist: true } });
    await connection.send({ type: "session.interrupt", requestId: "late-closed-interrupt", sessionId: id });
    return archive(id);
  };
  const before = f.events.length;
  f.remote.visible = true;
  await resync(f.server, f.paseo, "workspace");
  expect(thread.archivedAt).toBeTruthy();
  expect(f.events.slice(before)).toContainEqual({ type: "session.closed", sessionId: thread.id });
  expect(f.events.slice(before).some(event => event.type === "session.closed" && event.sessionId === main.id)).toBe(false);
  expect(f.events).toContainEqual(expect.objectContaining({ type: "request.failed", requestId: "racing-hidden-open", error: expect.objectContaining({ code: "discussion_unavailable" }) }));
  expect(f.events).toContainEqual(expect.objectContaining({ type: "request.failed", requestId: "late-closed-interrupt" }));
  expect(f.posts).toEqual([]);
  expect(f.runs[0].status).toBe("running");
  expect((await f.server.rpc(hiddenList, {}, f.paseo)).objects).toContainEqual(expect.objectContaining({ ...address, agentId: thread.id }));
  await (await f.connect()).send({ type: "session.open", requestId: "cached-hidden-open", sessionId: thread.id, history: "skip", persistence: JSON.parse(thread.handle.slice(7)), config: { cwd: thread.cwd, env: {}, mcpServers: {}, settings: {}, persist: true } });
  expect(f.events).toContainEqual(expect.objectContaining({ type: "session.opened", requestId: "cached-hidden-open" }));
});

it.each([undefined, "main"])("manual restore of %s preserves every unselected hide after the host's legacy timestamp fallback", async selectedRoot => {
  const f = await fixture(true);
  f.native.restoreAgents = true;
  f.comments.push(comment("other", null, "Other discussion"));
  await resync(f.server, f.paseo, "workspace");
  const original = f.agents.map(agent => ({ id: agent.id, cwd: agent.cwd, handle: agent.handle }));
  const main = f.agents.find(agent => agent.labels["multica.discussion"] === "main")!;
  const thread = f.agents.find(agent => agent.labels["multica.discussion"] === "root")!;
  const other = f.agents.find(agent => agent.labels["multica.discussion"] === "other")!;
  const address = { connectionKey: thread.labels["multica.connection"], issueId: "issue" };
  thread.archivedAt = stamp;
  await f.server.hook("agent.archive.after", { agent: { ...thread, provider: "multica" } } as never, f.paseo);
  await f.host.archiveWorkspace(main.workspaceId);
  // All exact workspace-stamp matches are reopened while its record remains
  // archived. The modern host now falls back to the earlier hidden Run tab.
  await f.host.refreshAgent(main.id); await f.host.refreshAgent(other.id);
  expect(f.native.archived).toBe(true);
  expect(f.agents.some(agent => agent.archivedAt === f.native.archiveStamp)).toBe(false);
  expect(await f.server.rpc(hiddenRestore, { ...address, ...(selectedRoot ? { rootId: selectedRoot } : {}) }, f.paseo)).toEqual({ status: "ready" });
  expect(f.native.archived).toBe(false);
  expect(thread.archivedAt).toBeTruthy();
  expect(other.archivedAt).toBeTruthy();
  expect(!!main.archivedAt).toBe(selectedRoot === undefined);
  expect((await f.server.rpc(hiddenList, {}, f.paseo)).objects.map(object => object.rootId).sort()).toEqual(selectedRoot ? ["other", "root"] : ["main", "other", "root"]);
  expect(f.agents.map(agent => ({ id: agent.id, cwd: agent.cwd, handle: agent.handle }))).toEqual(original);
  expect(f.runs[0].status).toBe("running"); expect(f.posts).toEqual([]);
});

it.each(["automatic", "manual"])("an explicit Stop accepted before %s hidden projection closure finishes independently", async restore => {
  const f = await fixture(true);
  f.native.restoreAgents = true;
  const main = f.agents.find(agent => agent.labels["multica.discussion"] === "main")!;
  const thread = f.agents.find(agent => agent.labels["multica.discussion"] === "root")!;
  thread.archivedAt = stamp;
  await f.server.hook("agent.archive.after", { agent: { ...thread, provider: "multica" } } as never, f.paseo);
  if (restore === "manual") await f.host.archiveWorkspace(main.workspaceId);
  else { f.remote.visible = false; await resync(f.server, f.paseo, "workspace"); }
  main.archivedAt = null;
  await resync(f.server, f.paseo, "workspace");
  let release!: () => void;
  let received!: () => void;
  const waiting = new Promise<void>(resolve => { received = resolve; });
  f.beforeCancel(async () => { received(); await new Promise<void>(resolve => { release = resolve; }); });
  const stopping = (await f.connect()).send({ type: "session.interrupt", requestId: "accepted-explicit-stop", sessionId: thread.id });
  await waiting;
  f.remote.visible = true;
  const restoring = restore === "manual" ? f.server.rpc(hiddenRestore, { connectionKey: thread.labels["multica.connection"], issueId: "issue" }, f.paseo) : resync(f.server, f.paseo, "workspace");
  try {
    await expect.poll(async () => {
      await (await f.connect()).send({ type: "session.open", requestId: "stop-drain-probe", sessionId: thread.id, history: "skip", persistence: JSON.parse(thread.handle.slice(7)), config: { cwd: thread.cwd, env: {}, mcpServers: {}, settings: {}, persist: true } });
      const response = f.events.filter(event => "requestId" in event && event.requestId === "stop-drain-probe").at(-1);
      return response?.type === "request.failed" ? response.error.code : undefined;
    }).toBe("discussion_unavailable");
    expect(f.events.some(event => event.type === "session.closed" && event.sessionId === thread.id)).toBe(false);
  } finally { release(); }
  await stopping;
  await restoring;
  expect(thread.archivedAt).toBeTruthy();
  expect(f.events).toContainEqual({ type: "session.closed", sessionId: thread.id });
  expect(f.posts.map(post => post.path)).toEqual(["/api/issues/issue/tasks/run/cancel"]);
  expect(f.events).toContainEqual({ type: "request.completed", requestId: "accepted-explicit-stop" });
});

it("a lost workspace restore acknowledgement still reapplies unselected hiding before releasing its guard", async () => {
  const f = await fixture(true);
  f.native.restoreAgents = true;
  const main = f.agents.find(agent => agent.labels["multica.discussion"] === "main")!;
  const thread = f.agents.find(agent => agent.labels["multica.discussion"] === "root")!;
  thread.archivedAt = stamp;
  await f.server.hook("agent.archive.after", { agent: { ...thread, provider: "multica" } } as never, f.paseo);
  await f.host.archiveWorkspace(main.workspaceId);
  await f.host.refreshAgent(main.id);
  const restore = f.host.restoreWorkspace.bind(f.host);
  f.host.restoreWorkspace = async id => { await restore(id); throw new Error("Acknowledgement lost"); };
  const address = { connectionKey: thread.labels["multica.connection"], issueId: "issue" };
  expect(await f.server.rpc(hiddenRestore, address, f.paseo)).toMatchObject({ status: "unavailable" });
  expect(f.agents.every(agent => agent.archivedAt)).toBe(true);
  expect((await f.server.rpc(hiddenList, {}, f.paseo)).objects.map(object => object.kind).sort()).toEqual(["main", "thread", "workspace"]);
  expect(f.posts).toEqual([]); expect(f.runs[0].status).toBe("running");
});
