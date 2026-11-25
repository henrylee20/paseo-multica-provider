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
import { workspaceEnable, syncBootstrap } from "../shared/contracts.js";
import { threadOpen } from "../shared/threads.js";
import { createServerContribution } from "../server/contribute.js";
import { FakeServer } from "./support/fake-server.js";

const cleanup: Array<() => void | Promise<void>> = [];
afterEach(async () => { for (const dispose of cleanup.splice(0).reverse()) await dispose(); });
const stamp = "2026-11-24T10:00:00Z";
const comment = (id: string, parent_id: string | null, content: string) => ({ id, parent_id, content, author_id: "me", author_type: "member", issue_id: "issue", type: "comment", created_at: stamp, updated_at: stamp, attachments: [] });
const deliveryList = defineRpc({ name: "delivery.list", input: z.object({}), output: z.object({ records: z.array(z.object({
  connectionKey: z.string(), issueId: z.string(), rootId: z.string(), clientMessageId: z.string(), retryOf: z.string().optional(), idempotencyKey: z.string(), body: z.string(), createdAt: z.string(),
  status: z.enum(["received", "saved", "failed", "pending_verification"]), commentId: z.string().optional(), threadRootId: z.string().optional(), threadAgentId: z.string().optional(), message: z.string().optional(),
})) }) });
const actionAddress = z.object({ connectionKey: z.string(), issueId: z.string(), rootId: z.string(), clientMessageId: z.string() });
const deliveryVerify = defineRpc({ name: "delivery.verify", input: actionAddress, output: z.object({ status: z.enum(["saved", "pending_verification"]), message: z.string().optional() }) });
const deliveryResend = defineRpc({ name: "delivery.resend", input: actionAddress.extend({ requestId: z.string(), acknowledgeDuplicateRisk: z.literal(true) }), output: z.object({ clientMessageId: z.string(), idempotencyKey: z.string() }) });
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
  let beforeMe: (() => Promise<void>) | undefined;
  let post: (body: { content: string; parent_id?: string }) => Promise<{ status?: number; body?: unknown; disconnect?: boolean }> = async body => {
    const saved = comment(`saved-${posts.length}`, body.parent_id ?? null, body.content); comments.push(saved); return { body: saved };
  };
  const http = createServer(async (request, response) => {
    response.setHeader("Content-Type", "application/json");
    const url = new URL(request.url!, "http://localhost");
    let body: unknown;
    if (request.method === "POST") {
      let text = ""; for await (const chunk of request) text += chunk;
      const input = text ? JSON.parse(text) : {};
      posts.push({ path: url.pathname, body: input, key: request.headers["idempotency-key"] as string, slug: request.headers["x-workspace-slug"] as string });
      if (url.pathname.endsWith("/cancel")) { runs[0].status = "cancelled"; body = runs[0]; }
      else {
        const key = request.headers["idempotency-key"] as string;
        const existing = idempotent ? receipts.get(key) : undefined;
        const result = existing ? { body: existing } : await post(input);
        if (idempotent && result.body && (result.body as { type?: string }).type === "comment") receipts.set(key, result.body as ReturnType<typeof comment>);
        if (result.disconnect) { response.destroy(); return; } response.statusCode = result.status ?? 200; body = result.body ?? {}; }
    } else if (url.pathname === "/api/me") { await beforeMe?.(); body = { id: identity, name: "Lin" }; }
    else if (url.pathname === "/api/workspaces") body = [{ id: "workspace", name: "Product", slug: "product" }];
    else if (url.pathname === "/api/issues") body = { issues: [{ id: "issue", workspace_id: "workspace", title: "Task", description: "Description", status: "todo" }], total: 1 };
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
  const agents: Array<{ id: string; workspaceId: string; cwd: string; labels: Record<string, string>; handle: string }> = [];
  let server: FakeServer;
  let provider: ProviderConnection | undefined;
  async function connect() {
    if (provider) return provider;
    provider = await server.providers.get("multica")!.connect({ versions: [1], capabilities: ["session.persistence", "prompt.message", "prompt.steer", "timeline.plugin"] });
    provider.onEvent(event => {
      events.push(event);
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
    fetchWorkspaces: async () => ({ entries: [], pageInfo: { hasMore: false } }),
    createWorkspace: async (input: { workspaceId: string }) => ({ workspace: { id: input.workspaceId } }), setWorkspaceTitle: async () => {},
    fetchAgents: async () => ({ entries: agents.map(agent => ({ agent: { provider: "multica", ...agent } })), pageInfo: { hasMore: false } }),
    fetchAgentTimeline: async (agentId: string) => ({ agentId, epoch: "epoch", entries: canonical.get(agentId) ?? [], hasOlder: false, hasNewer: false }),
    importAgent: async (input: { workspaceId: string; cwd: string; labels: Record<string, string>; providerHandleId: string }) => {
      const agent = { id: `native-${agents.length}`, workspaceId: input.workspaceId, cwd: input.cwd, labels: input.labels, handle: input.providerHandleId }; agents.push(agent);
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
  return { ...started, home, paseo, agents, events, canonical, nativeHistory, comments, runs, posts, lookups, receipts, deletedReceipts, connect, send, start, lookupFailure: (status?: number) => { lookupFailure = status; }, advance: (milliseconds: number) => { clock = new Date(clock.getTime() + milliseconds); }, beforeLookup: (handler: typeof beforeLookup) => { beforeLookup = handler; }, identity: (id: string) => { identity = id; }, beforeMe: (handler?: () => Promise<void>) => { beforeMe = handler; }, post: (handler: typeof post) => { post = handler; } };
}

it("main discussion saves an ordinary text comment, preserves its identity and offers the new Thread", async () => {
  const f = await fixture();
  await f.send("main", "Hello @ambiguous", "input-main");
  await expect.poll(async () => (await f.server.rpc(deliveryList, {}, f.paseo)).records[0]?.status).toBe("saved");
  const record = (await f.server.rpc(deliveryList, {}, f.paseo)).records[0];
  expect(record).toMatchObject({ rootId: "main", clientMessageId: "input-main", body: "Hello @ambiguous", status: "saved", commentId: "saved-1", threadRootId: "saved-1" });
  expect(Number.isFinite(Date.parse(record.createdAt))).toBe(true);
  expect(f.posts).toEqual([{ path: "/api/issues/issue/comments", body: { content: "Hello @ambiguous", type: "comment" }, key: record.idempotencyKey, slug: "product" }]);
  await expect.poll(async () => (await f.server.rpc(deliveryList, {}, f.paseo)).records[0]?.threadAgentId).toBe("native-2");
  expect(f.events.some(event => event.type === "session.turn")).toBe(false);
  expect(f.events).toContainEqual(expect.objectContaining({ type: "session.prompt_result", clientMessageId: "input-main", result: { type: "completed" } }));
});

it("a Thread replies to its root and matches the saved echo to the original native input identity", async () => {
  const f = await fixture();
  const thread = f.agents.find(agent => agent.labels["multica.discussion"] === "root")!;
  const address = { connectionKey: thread.labels["multica.connection"], issueId: "issue", rootId: "root" };
  await f.server.rpc(threadOpen, address, f.paseo);
  await f.send("root", "A reply", "input-reply");
  await expect.poll(async () => (await f.server.rpc(deliveryList, {}, f.paseo)).records[0]?.status).toBe("saved");
  await f.server.rpc(syncBootstrap, {}, f.paseo);
  expect(f.posts[0]).toMatchObject({ body: { content: "A reply", type: "comment", parent_id: "root" } });
  expect(f.events).toContainEqual(expect.objectContaining({ type: "timeline.item", sessionId: thread.id, item: expect.objectContaining({ type: "user_message", messageId: "saved-1", clientMessageId: "input-reply", text: "A reply" }) }));
  await f.send("root", "A reply", "input-reply");
  await f.server.rpc(threadOpen, address, f.paseo);
  expect(f.posts).toHaveLength(1);
  await f.dispose();
  const restarted = f.start();
  expect((await restarted.server.rpc(deliveryList, {}, f.paseo)).records[0]).toMatchObject({ body: "A reply", commentId: "saved-1", status: "saved" });
  expect(f.posts).toHaveLength(1);
});

it("replays each saved input once in its original discussion after contribution restart", async () => {
  const f = await fixture();
  const thread = f.agents.find(agent => agent.labels["multica.discussion"] === "root")!;
  const address = { connectionKey: thread.labels["multica.connection"], issueId: "issue", rootId: "root" };
  await f.server.rpc(threadOpen, address, f.paseo);
  await f.send("root", "Saved reply", "saved-reply");
  await expect.poll(async () => (await f.server.rpc(deliveryList, {}, f.paseo)).records[0]?.status).toBe("saved");
  await f.server.rpc(threadOpen, address, f.paseo);
  await f.send("main", "New Thread root", "saved-reply");
  await expect.poll(async () => (await f.server.rpc(deliveryList, {}, f.paseo)).records[1]?.status).toBe("saved");
  await expect.poll(() => f.agents.some(agent => agent.labels["multica.discussion"] === "saved-2")).toBe(true);
  const main = f.agents.find(agent => agent.labels["multica.discussion"] === "main")!;
  const created = f.agents.find(agent => agent.labels["multica.discussion"] === "saved-2")!;
  await f.server.rpc(threadOpen, { ...address, rootId: "saved-2" }, f.paseo);
  await f.dispose(); f.start();
  const boundary = f.events.length;
  for (const agent of [thread, main, created]) await (await f.connect()).send({ type: "session.open", requestId: `replay-${agent.id}`, sessionId: agent.id, history: "replay", persistence: JSON.parse(agent.handle.slice(7)), config: { cwd: agent.cwd, env: {}, mcpServers: {}, settings: {}, persist: true } });
  const originals = f.events.slice(boundary).flatMap(event => event.type === "timeline.item" && event.item.type === "user_message" ? [{ sessionId: event.sessionId, text: event.item.text, clientMessageId: event.item.clientMessageId }] : []);
  expect(originals).toEqual([
    { sessionId: thread.id, text: "Existing root", clientMessageId: undefined },
    { sessionId: thread.id, text: "Saved reply", clientMessageId: "saved-reply" },
    { sessionId: main.id, text: "New Thread root", clientMessageId: "saved-reply" },
    { sessionId: created.id, text: "New Thread root", clientMessageId: undefined },
  ]);
  expect(f.posts).toHaveLength(2);
});

it("recovers each missing saved or input-only original once when native writes lag across history-skip recovery", async () => {
  const f = await fixture();
  const thread = f.agents.find(agent => agent.labels["multica.discussion"] === "root")!;
  const address = { connectionKey: thread.labels["multica.connection"], issueId: "issue", rootId: "root" };
  await f.server.rpc(threadOpen, address, f.paseo);
  await f.send("root", "Shared content", "surviving-saved");
  await expect.poll(async () => (await f.server.rpc(deliveryList, {}, f.paseo)).records[0]?.status).toBe("saved");
  await f.send("root", "Missing saved reply", "missing-saved");
  await expect.poll(async () => (await f.server.rpc(deliveryList, {}, f.paseo)).records[1]?.status).toBe("saved");
  await f.server.rpc(threadOpen, address, f.paseo);
  f.post(async () => ({ status: 403 }));
  await f.send("root", "Missing failed input", "missing-failed");
  await expect.poll(async () => (await f.server.rpc(deliveryList, {}, f.paseo)).records[2]?.status).toBe("failed");
  f.post(async body => { f.comments.push(comment("unknown-same-body", "root", body.content)); return { disconnect: true }; });
  await f.send("root", "Shared content", "pending-same-body");
  await expect.poll(async () => (await f.server.rpc(deliveryList, {}, f.paseo)).records[3]?.status).toBe("pending_verification");
  await f.server.rpc(threadOpen, address, f.paseo);
  f.canonical.set(thread.id, f.canonical.get(thread.id)!.filter(entry => !["missing-saved", "missing-failed", "pending-same-body"].includes(entry.item.clientMessageId as string)));
  await f.dispose(); const restarted = f.start();
  const boundary = f.events.length;
  await (await f.connect()).send({ type: "session.open", requestId: "recover-saved", sessionId: thread.id, history: "skip", persistence: JSON.parse(thread.handle.slice(7)), config: { cwd: thread.cwd, env: {}, mcpServers: {}, settings: {}, persist: true } });
  // The host can accept provider events before they become readable history.
  f.nativeHistory.persistOriginals = false;
  await restarted.server.rpc(syncBootstrap, {}, f.paseo);
  await restarted.server.rpc(syncBootstrap, {}, f.paseo);
  const originals = f.events.slice(boundary).flatMap(event => event.type === "timeline.item" && event.item.type === "user_message" ? [event.item] : []);
  expect(originals.map(item => ({ text: item.text, clientMessageId: item.clientMessageId }))).toEqual([
    { text: "Missing saved reply", clientMessageId: "missing-saved" },
    { text: "Missing failed input", clientMessageId: "missing-failed" },
    { text: "Shared content", clientMessageId: "pending-same-body" },
  ]);
  expect(f.posts).toHaveLength(4);
});

it("keeps running ordinary delivery admission separate from network failure and never sends remote steering", async () => {
  const f = await fixture(true);
  const thread = f.agents.find(agent => agent.labels["multica.discussion"] === "root")!;
  const active = [...f.events].reverse().find(event => event.type === "session.turn" && event.sessionId === thread.id && event.state === "started");
  expect(active?.type).toBe("session.turn");
  let release: () => void = () => {};
  const blocked = new Promise<void>(resolve => { release = resolve; });
  f.post(async () => { await blocked; return { status: 503 }; });
  await f.send("root", "While running", "running-input", "steer");
  expect(f.events).toContainEqual(expect.objectContaining({ type: "session.prompt_result", clientMessageId: "running-input", result: { type: "steer", turnId: active?.type === "session.turn" ? active.turnId : "" } }));
  await expect.poll(() => f.posts.length).toBe(1);
  expect((await f.server.rpc(deliveryList, {}, f.paseo)).records[0]?.status).toBe("received");
  expect(f.posts[0].body).toEqual({ content: "While running", type: "comment", parent_id: "root" });
  release();
  await expect.poll(async () => (await f.server.rpc(deliveryList, {}, f.paseo)).records[0]?.status).toBe("pending_verification");
  expect(f.events.filter(event => event.type === "session.prompt_result" && event.clientMessageId === "running-input")).toHaveLength(1);
  expect(f.posts.some(post => post.path.endsWith("/cancel"))).toBe(false);
  f.runs[0].status = "completed";
  await f.server.rpc(syncBootstrap, {}, f.paseo);
  f.runs.push({ ...f.runs[0], id: "next-run", status: "running" });
  await f.server.rpc(syncBootstrap, {}, f.paseo);
  const next = [...f.events].reverse().find(event => event.type === "session.turn" && event.sessionId === thread.id && event.state === "started");
  expect(next?.type === "session.turn" ? next.turnId : null).not.toBe(active?.type === "session.turn" ? active.turnId : null);
  f.post(async () => ({ status: 403 }));
  await f.send("root", "New cycle", "next-input", "steer");
  await expect.poll(async () => (await f.server.rpc(deliveryList, {}, f.paseo)).records[1]?.status).toBe("failed");
  expect(f.events).toContainEqual(expect.objectContaining({ type: "session.prompt_result", clientMessageId: "next-input", result: { type: "steer", turnId: next?.type === "session.turn" ? next.turnId : "" } }));
});

it("unknown saved echo stays pending verification after response loss and never blindly retries", async () => {
  const f = await fixture();
  const thread = f.agents.find(agent => agent.labels["multica.discussion"] === "root")!;
  const address = { connectionKey: thread.labels["multica.connection"], issueId: "issue", rootId: "root" };
  await f.server.rpc(threadOpen, address, f.paseo);
  f.post(async body => { f.comments.push(comment("lost-receipt", "root", body.content)); return { disconnect: true }; });
  await f.send("root", "Do not duplicate", "lost-input");
  await expect.poll(async () => (await f.server.rpc(deliveryList, {}, f.paseo)).records[0]?.status).toBe("pending_verification");
  await f.server.rpc(syncBootstrap, {}, f.paseo);
  await f.server.rpc(threadOpen, address, f.paseo);
  expect(f.events.filter(event => event.type === "timeline.item" && event.item.type === "user_message" && event.item.text === "Do not duplicate")).toHaveLength(1);
  await f.dispose(); const restarted = f.start();
  expect((await restarted.server.rpc(deliveryList, {}, f.paseo)).records[0]).toMatchObject({ body: "Do not duplicate", status: "pending_verification", clientMessageId: "lost-input" });
  await restarted.server.rpc(syncBootstrap, {}, f.paseo);
  expect(f.posts).toHaveLength(1);
});

it("native Stop fences a received input before its initial POST and preserves that input", async () => {
  const f = await fixture(true);
  let release: () => void = () => {}, reached: () => void = () => {};
  const blocked = new Promise<void>(resolve => { release = resolve; }), waiting = new Promise<void>(resolve => { reached = resolve; });
  f.beforeMe(async () => { reached(); await blocked; });
  await f.send("root", "Old pending input", "stopped-input", "steer");
  await waiting;
  const thread = f.agents.find(agent => agent.labels["multica.discussion"] === "root")!;
  const stop = (await f.connect()).send({ type: "session.interrupt", requestId: "stop", sessionId: thread.id });
  // Stop's durable epoch update precedes its own /api/me wait.
  await new Promise(resolve => setTimeout(resolve, 20));
  release(); await stop;
  await expect.poll(async () => (await f.server.rpc(deliveryList, {}, f.paseo)).records[0]?.status).toBe("failed");
  expect(f.posts.map(post => post.path)).toEqual(["/api/issues/issue/tasks/run/cancel"]);
  expect((await f.server.rpc(deliveryList, {}, f.paseo)).records[0]).toMatchObject({ body: "Old pending input", message: "Delivery was stopped" });
});

it("explicit mentions contain typed service identities and same-name agents remain distinct", async () => {
  const f = await fixture();
  const address = { connectionKey: f.agents[0].labels["multica.connection"], issueId: "issue" };
  const result = await f.server.rpc(deliveryMentions, address, f.paseo);
  expect(result.agents).toEqual([
    { id: "12345678-1234-4234-9234-123456789abc", name: "Agent [A]", reference: "[@Agent \\[A\\]](mention://agent/12345678-1234-4234-9234-123456789abc)" },
    { id: "22345678-1234-4234-9234-123456789abc", name: "Agent [A]", reference: "[@Agent \\[A\\]](mention://agent/22345678-1234-4234-9234-123456789abc)" },
  ]);
  await f.send("main", `Hello ${result.agents[1].reference}`, "typed-mention");
  await expect.poll(() => f.posts.length).toBe(1);
  expect(f.posts[0].body).toEqual({ content: "Hello [@Agent \\[A\\]](mention://agent/22345678-1234-4234-9234-123456789abc)", type: "comment" });
  f.identity("other-user");
  await expect(f.server.rpc(deliveryMentions, address, f.paseo)).rejects.toThrow("原 Multica 身份");
});

it("unmapped sessions give configuration guidance and changed connections cannot receive the old input", async () => {
  const f = await fixture();
  await (await f.connect()).send({ type: "session.prompt", sessionId: "unmapped", prompt: { clientMessageId: "unmapped", delivery: "auto", input: { type: "message", content: [{ type: "text", text: "Do not create Issue" }] } } });
  expect(f.events).toContainEqual(expect.objectContaining({ type: "session.prompt_result", clientMessageId: "unmapped", result: expect.objectContaining({ type: "failed", error: expect.objectContaining({ message: expect.stringContaining("管理页") }) }) }));
  expect(f.posts).toEqual([]);
  f.identity("other-user");
  await f.send("main", "Old identity input", "identity-input");
  await expect.poll(async () => (await f.server.rpc(deliveryList, {}, f.paseo)).records[0]?.status).toBe("failed");
  expect(f.posts).toEqual([]);
  expect((await f.server.rpc(deliveryList, {}, f.paseo)).records[0]?.body).toBe("Old identity input");
});

it("a snapshot that beats the HTTP receipt cannot publish an uncorrelated duplicate native echo", async () => {
  const f = await fixture();
  const thread = f.agents.find(agent => agent.labels["multica.discussion"] === "root")!;
  const address = { connectionKey: thread.labels["multica.connection"], issueId: "issue", rootId: "root" };
  await f.server.rpc(threadOpen, address, f.paseo);
  let release: () => void = () => {}, reached: () => void = () => {};
  const blocked = new Promise<void>(resolve => { release = resolve; }), waiting = new Promise<void>(resolve => { reached = resolve; });
  f.post(async body => { const saved = comment("early-echo", "root", body.content); f.comments.push(saved); reached(); await blocked; return { body: saved }; });
  await f.send("root", "Racing echo", "echo-input"); await waiting;
  const refresh = f.server.rpc(threadOpen, address, f.paseo);
  await new Promise(resolve => setTimeout(resolve, 20));
  expect(f.events.filter(event => event.type === "timeline.item" && event.item.type === "user_message" && event.item.text === "Racing echo")).toHaveLength(1);
  release(); await refresh;
  const echoes = f.events.filter(event => event.type === "timeline.item" && event.item.type === "user_message" && event.item.text === "Racing echo");
  // Both boundary events address the same canonical host input via clientMessageId.
  expect(echoes).toHaveLength(2);
  expect(echoes.every(event => event.type === "timeline.item" && event.item.type === "user_message" && event.item.clientMessageId === "echo-input")).toBe(true);
});

it("recovers a durable main input missing from canonical history without duplicating a surviving input", async () => {
  const f = await fixture();
  f.post(async () => ({ status: 403 }));
  await f.send("main", "Survived input", "survived");
  await f.send("main", "Lost projection", "lost-projection");
  await expect.poll(async () => (await f.server.rpc(deliveryList, {}, f.paseo)).records.every(record => record.status === "failed")).toBe(true);
  const main = f.agents.find(agent => agent.labels["multica.discussion"] === "main")!;
  f.canonical.set(main.id, f.canonical.get(main.id)!.filter(entry => entry.item.clientMessageId !== "lost-projection"));
  await f.dispose(); const restarted = f.start();
  const boundary = f.events.length;
  await (await f.connect()).send({ type: "session.open", requestId: "restored", sessionId: main.id, history: "skip", persistence: JSON.parse(main.handle.slice(7)), config: { cwd: main.cwd, env: {}, mcpServers: {}, settings: {}, persist: true } });
  await restarted.server.rpc(syncBootstrap, {}, f.paseo);
  const originals = f.events.slice(boundary).filter(event => event.type === "timeline.item" && event.item.type === "user_message");
  expect(originals.map(event => event.type === "timeline.item" && event.item.type === "user_message" ? event.item.clientMessageId : null)).toEqual(["lost-projection"]);
  await restarted.server.rpc(syncBootstrap, {}, f.paseo);
  expect(f.events.slice(boundary).filter(event => event.type === "timeline.item" && event.item.type === "user_message")).toHaveLength(1);
});

it("a running input storage failure reports non-receipt without triggering the native interrupt fallback", async () => {
  const f = await fixture(true);
  const thread = f.agents.find(agent => agent.labels["multica.discussion"] === "root")!;
  const active = [...f.events].reverse().find(event => event.type === "session.turn" && event.sessionId === thread.id && event.state === "started");
  await mkdir(join(f.home, "multica-provider/state.json.next"));
  try {
    await f.send("root", "Keep this native input", "disk-failed", "steer");
    expect(f.events).toContainEqual(expect.objectContaining({ type: "session.prompt_result", clientMessageId: "disk-failed", result: { type: "steer", turnId: active?.type === "session.turn" ? active.turnId : "" } }));
    expect(f.events).toContainEqual(expect.objectContaining({ type: "timeline.item", sessionId: thread.id, item: expect.objectContaining({ type: "error", message: expect.stringContaining("未能持久接收") }) }));
    expect((await f.server.rpc(deliveryList, {}, f.paseo)).records).toEqual([]);
    expect(f.posts).toEqual([]);
  } finally { await rm(join(f.home, "multica-provider/state.json.next"), { recursive: true }); }
});

it("a receipt storage failure keeps the remote result visibly unknown and never reposts", async () => {
  const f = await fixture();
  f.post(async body => {
    await mkdir(join(f.home, "multica-provider/state.json.next"));
    return { body: comment("saved-but-not-recorded", "root", body.content) };
  });
  try {
    await f.send("root", "Unknown receipt persistence", "receipt-write-failed");
    await expect.poll(async () => (await f.server.rpc(deliveryList, {}, f.paseo)).records[0]?.status).toBe("pending_verification");
    expect(f.events).toContainEqual(expect.objectContaining({ type: "timeline.item", item: expect.objectContaining({ type: "plugin", kind: "comment-delivery", data: expect.objectContaining({ status: "pending_verification" }) }) }));
    expect(f.posts).toHaveLength(1);
  } finally { await rm(join(f.home, "multica-provider/state.json.next"), { recursive: true, force: true }); }
});


it("recovers a saved comment after a lost response and restart using its authoritative keyed receipt", async () => {
  const f = await fixture(false, true);
  f.post(async body => { const saved = comment("receipt-after-crash", "root", body.content); f.comments.push(saved); return { body: saved, disconnect: true }; });
  await f.send("root", "Exactly one remote effect", "recover-input");
  await expect.poll(async () => (await f.server.rpc(deliveryList, {}, f.paseo)).records[0]?.status).toBe("pending_verification");
  const original = (await f.server.rpc(deliveryList, {}, f.paseo)).records[0];
  await f.dispose(); const restarted = f.start();
  await restarted.server.rpc(syncBootstrap, {}, f.paseo);
  expect((await restarted.server.rpc(deliveryList, {}, f.paseo)).records[0]).toMatchObject({ ...original, status: "saved", commentId: "receipt-after-crash", threadRootId: "root", message: expect.any(String) });
  expect(f.lookups).toContain(original.idempotencyKey);
  expect(f.posts).toHaveLength(1);
  expect(f.comments.filter(value => value.content === "Exactly one remote effect")).toHaveLength(1);
});


it("retries a missing receipt only after fresh positive proof, preserving key, content and original native input", async () => {
  const f = await fixture(false, true);
  await f.send("root", "Capability anchor", "anchor");
  await expect.poll(async () => (await f.server.rpc(deliveryList, {}, f.paseo)).records[0]?.status).toBe("saved");
  f.post(async () => ({ status: 503 }));
  await f.send("root", "Same immutable body", "safe-retry");
  await expect.poll(async () => (await f.server.rpc(deliveryList, {}, f.paseo)).records[1]?.status).toBe("pending_verification");
  const original = (await f.server.rpc(deliveryList, {}, f.paseo)).records[1];
  const boundary = f.lookups.length;
  f.post(async body => { const saved = comment("safe-receipt", "root", body.content); f.comments.push(saved); return { body: saved }; });
  await f.server.rpc(syncBootstrap, {}, f.paseo);
  expect((await f.server.rpc(deliveryList, {}, f.paseo)).records[1]).toMatchObject({ ...original, status: "saved", commentId: "safe-receipt", message: expect.any(String) });
  expect(f.lookups.slice(boundary)).toContain(original.idempotencyKey);
  expect(f.posts.filter(post => post.key === original.idempotencyKey)).toEqual([
    { path: "/api/issues/issue/comments", body: { content: "Same immutable body", type: "comment", parent_id: "root" }, key: original.idempotencyKey, slug: "product" },
    { path: "/api/issues/issue/comments", body: { content: "Same immutable body", type: "comment", parent_id: "root" }, key: original.idempotencyKey, slug: "product" },
  ]);
  expect(f.comments.filter(value => value.content === "Same immutable body")).toHaveLength(1);
  expect(new TextEncoder().encode(original.idempotencyKey).length).toBeLessThanOrEqual(255);
});


it("a missing receipt at the seven-day bound stays pending despite a currently working receipt API", async () => {
  const f = await fixture(false, true);
  await f.send("root", "Working receipt anchor", "expiry-anchor");
  await expect.poll(async () => (await f.server.rpc(deliveryList, {}, f.paseo)).records[0]?.status).toBe("saved");
  f.post(async () => ({ status: 503 }));
  await f.send("root", "Expired original request", "expired-input");
  await expect.poll(async () => (await f.server.rpc(deliveryList, {}, f.paseo)).records[1]?.status).toBe("pending_verification");
  const original = (await f.server.rpc(deliveryList, {}, f.paseo)).records[1];
  f.advance(7 * 24 * 60 * 60 * 1000);
  await f.server.rpc(syncBootstrap, {}, f.paseo);
  expect(f.posts).toHaveLength(2);
  expect((await f.server.rpc(deliveryList, {}, f.paseo)).records[1]).toMatchObject({ idempotencyKey: original.idempotencyKey, createdAt: original.createdAt, status: "pending_verification", message: expect.stringContaining("7 天") });
});


it("Stop during receipt recovery fences the old retry while preserving pending input", async () => {
  const f = await fixture(true, true);
  await f.send("root", "Receipt anchor before Stop", "stop-anchor", "steer");
  await expect.poll(async () => (await f.server.rpc(deliveryList, {}, f.paseo)).records[0]?.status).toBe("saved");
  f.post(async () => ({ status: 503 }));
  await f.send("root", "Do not execute after Stop", "stop-retry", "steer");
  await expect.poll(async () => (await f.server.rpc(deliveryList, {}, f.paseo)).records[1]?.status).toBe("pending_verification");
  const original = (await f.server.rpc(deliveryList, {}, f.paseo)).records[1];
  let release!: () => void, reached!: () => void;
  const blocked = new Promise<void>(resolve => { release = resolve; }), waiting = new Promise<void>(resolve => { reached = resolve; });
  f.beforeLookup(async key => { if (key === original.idempotencyKey) { reached(); await blocked; } });
  const refresh = f.server.rpc(syncBootstrap, {}, f.paseo);
  await waiting;
  const thread = f.agents.find(agent => agent.labels["multica.discussion"] === "root")!;
  await (await f.connect()).send({ type: "session.interrupt", requestId: "stop-recovery", sessionId: thread.id });
  release(); await refresh;
  expect(f.posts.filter(post => post.path.endsWith("/comments"))).toHaveLength(2);
  expect((await f.server.rpc(deliveryList, {}, f.paseo)).records[1]).toMatchObject({ body: "Do not execute after Stop", status: "pending_verification", message: expect.stringContaining("stopped") });
});


it("management verification never sends, and explicit resend creates one separately identified attempt", async () => {
  const f = await fixture();
  f.post(async body => { const saved = comment("uncertain-original", "root", body.content); f.comments.push(saved); return { body: saved, disconnect: true }; });
  await f.send("root", "User decides about duplication", "uncertain-original");
  await expect.poll(async () => (await f.server.rpc(deliveryList, {}, f.paseo)).records[0]?.status).toBe("pending_verification");
  const original = (await f.server.rpc(deliveryList, {}, f.paseo)).records[0];
  const address = { connectionKey: original.connectionKey, issueId: original.issueId, rootId: original.rootId, clientMessageId: original.clientMessageId };
  expect(await f.server.rpc(deliveryVerify, address, f.paseo)).toMatchObject({ status: "pending_verification" });
  expect(f.posts).toHaveLength(1);
  f.post(async body => { const saved = comment("explicit-new-attempt", "root", body.content); f.comments.push(saved); return { body: saved }; });
  f.advance(1000);
  const input = { ...address, requestId: "one-explicit-decision", acknowledgeDuplicateRisk: true as const };
  const next = await f.server.rpc(deliveryResend, input, f.paseo);
  expect(await f.server.rpc(deliveryResend, input, f.paseo)).toEqual(next);
  await expect.poll(async () => (await f.server.rpc(deliveryList, {}, f.paseo)).records[1]?.status).toBe("saved");
  const records = (await f.server.rpc(deliveryList, {}, f.paseo)).records;
  expect(records[0]).toMatchObject({ ...original, status: "pending_verification", message: expect.any(String) });
  expect(records[1]).toMatchObject({ retryOf: original.idempotencyKey, body: original.body, rootId: "root", commentId: "explicit-new-attempt" });
  expect(next.idempotencyKey).not.toBe(original.idempotencyKey);
  expect(next.clientMessageId).not.toBe(original.clientMessageId);
  expect(records[1].createdAt).not.toBe(original.createdAt);
  expect(f.posts).toHaveLength(2);
  f.identity("another-user");
  await expect(f.server.rpc(deliveryResend, { ...input, requestId: "wrong-identity" }, f.paseo)).rejects.toThrow("原 Multica 身份");
  expect(f.posts).toHaveLength(2);
});


it("a deleted original comment stops automatic recovery and an altered body cannot reuse the input key", async () => {
  const f = await fixture(false, true);
  f.post(async body => { const saved = comment("deleted-original", "root", body.content); f.comments.push(saved); return { body: saved, disconnect: true }; });
  await f.send("root", "Immutable original content", "deleted-input");
  await expect.poll(async () => (await f.server.rpc(deliveryList, {}, f.paseo)).records[0]?.status).toBe("pending_verification");
  const original = (await f.server.rpc(deliveryList, {}, f.paseo)).records[0];
  f.deletedReceipts.add(original.idempotencyKey);
  await f.server.rpc(syncBootstrap, {}, f.paseo);
  expect((await f.server.rpc(deliveryList, {}, f.paseo)).records[0]).toMatchObject({ status: "pending_verification", body: "Immutable original content", message: expect.stringContaining("已删除") });
  await f.send("root", "Changed body under same client identity", "deleted-input");
  expect(f.events).toContainEqual(expect.objectContaining({ type: "session.prompt_result", clientMessageId: "deleted-input", result: expect.objectContaining({ type: "failed", error: expect.objectContaining({ message: expect.stringContaining("不能改变正文") }) }) }));
  await f.server.rpc(syncBootstrap, {}, f.paseo);
  expect(f.posts).toHaveLength(1);
});


it("a CLI credential change during receipt lookup cannot authorize an old recovery POST", async () => {
  const f = await fixture(false, true);
  await f.send("root", "Positive receipt proof", "identity-proof");
  await expect.poll(async () => (await f.server.rpc(deliveryList, {}, f.paseo)).records[0]?.status).toBe("saved");
  f.post(async () => ({ status: 503 }));
  await f.send("root", "Original identity only", "identity-recovery");
  await expect.poll(async () => (await f.server.rpc(deliveryList, {}, f.paseo)).records[1]?.status).toBe("pending_verification");
  const original = (await f.server.rpc(deliveryList, {}, f.paseo)).records[1];
  f.beforeLookup(async key => {
    if (key !== original.idempotencyKey) return;
    const path = join(f.home, ".multica/config.json");
    const config = JSON.parse(await readFile(path, "utf8"));
    await writeFile(path, JSON.stringify({ ...config, token: "replacement-cli-credential" }));
  });
  await f.server.rpc(syncBootstrap, {}, f.paseo);
  expect(f.posts).toHaveLength(2);
  expect((await f.server.rpc(deliveryList, {}, f.paseo)).records[1]).toMatchObject({ body: original.body, idempotencyKey: original.idempotencyKey, status: "pending_verification" });
});


it("an unavailable receipt lookup halts automatic retries and explicit verification can later recover the same original", async () => {
  const f = await fixture(false, true);
  f.post(async body => { const saved = comment("receipt-after-outage", "root", body.content); f.comments.push(saved); return { body: saved, disconnect: true }; });
  await f.send("root", "Keep the original through outage", "lookup-outage");
  await expect.poll(async () => (await f.server.rpc(deliveryList, {}, f.paseo)).records[0]?.status).toBe("pending_verification");
  const original = (await f.server.rpc(deliveryList, {}, f.paseo)).records[0];
  f.lookupFailure(503);
  await f.server.rpc(syncBootstrap, {}, f.paseo);
  f.lookupFailure();
  const boundary = f.lookups.length;
  await f.server.rpc(syncBootstrap, {}, f.paseo);
  expect(f.lookups).toHaveLength(boundary);
  expect(f.posts).toHaveLength(1);
  expect(await f.server.rpc(deliveryVerify, { connectionKey: original.connectionKey, issueId: original.issueId, rootId: original.rootId, clientMessageId: original.clientMessageId }, f.paseo)).toMatchObject({ status: "saved" });
  expect((await f.server.rpc(deliveryList, {}, f.paseo)).records[0]).toMatchObject({ ...original, status: "saved", commentId: "receipt-after-outage", message: expect.any(String) });
  expect(f.posts).toHaveLength(1);
});

it("a replay whose remotely edited body differs cannot bind to or replace the immutable original input", async () => {
  const f = await fixture(false, true);
  f.post(async body => { const saved = comment("edited-remote-original", "root", body.content); f.comments.push(saved); return { body: saved, disconnect: true }; });
  await f.send("root", "Keep exactly this original body", "edited-receipt");
  await expect.poll(async () => (await f.server.rpc(deliveryList, {}, f.paseo)).records[0]?.status).toBe("pending_verification");
  const original = (await f.server.rpc(deliveryList, {}, f.paseo)).records[0];
  // The real service fingerprints only target/type; a later edit is not our original payload.
  f.receipts.get(original.idempotencyKey)!.content = "A later remote edit";
  await f.server.rpc(syncBootstrap, {}, f.paseo);
  expect((await f.server.rpc(deliveryList, {}, f.paseo)).records[0]).toMatchObject({ body: "Keep exactly this original body", status: "pending_verification" });
  expect(f.posts).toHaveLength(1);
});

it("accepts ordinary comment receipts whose optional askuser target is explicitly null", async () => {
  const f = await fixture(false, true);
  f.post(async body => ({ body: { ...comment("ordinary-null-target", body.parent_id ?? null, body.content), askuser_answer_to: null } }));
  await f.send("root", "Ordinary discussion", "ordinary-null-target");
  await expect.poll(async () => (await f.server.rpc(deliveryList, {}, f.paseo)).records[0]?.status).toBe("saved");
  const record = (await f.server.rpc(deliveryList, {}, f.paseo)).records[0];
  expect(await f.server.rpc(deliveryVerify, record, f.paseo)).toMatchObject({ status: "saved" });
  expect(f.posts).toHaveLength(1);
});
