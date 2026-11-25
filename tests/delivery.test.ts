import { createServer } from "node:http";
import { mkdtemp, mkdir, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import type { PaseoApi } from "@getpaseo/client";
import type { DaemonClient } from "@getpaseo/client/internal/daemon-client";
import type { ProviderConnection, ProviderEvent, ProviderPrompt } from "@getpaseo/plugin/server/provider";
import { workspaceEnable, syncBootstrap } from "../shared/contracts.js";
import { deliveryMentions } from "../shared/delivery.js";
import { threadOpen } from "../shared/threads.js";
import { createServerContribution } from "../server/contribute.js";
import { FakeServer, resync } from "./support/fake-server.js";

const cleanup: Array<() => void | Promise<void>> = [];
afterEach(async () => { for (const dispose of cleanup.splice(0).reverse()) await dispose(); });
const stamp = "2026-11-24T10:00:00Z";
const comment = (id: string, parent_id: string | null, content: string) => ({ id, parent_id, content, author_id: "me", author_type: "member", issue_id: "issue", type: "comment", created_at: stamp, updated_at: stamp, attachments: [] });
async function fixture(active = false, idempotent = false) {
  const home = await mkdtemp(join(tmpdir(), "multica-delivery-"));
  cleanup.push(() => rm(home, { recursive: true, force: true }));
  const comments = [comment("root", null, "Existing root")];
  const runs = active ? [{ id: "run", issue_id: "issue", agent_id: "agent", status: "running", trigger_comment_id: "root" }] : [];
  const requests: string[] = [];
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
    requests.push(url.pathname);
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
  const start = () => { provider = undefined; server = new FakeServer(); const dispose = createServerContribution({ homeDirectory: home, workingDirectory: home, environment: { PASEO_HOME: home }, connectHost: async () => host })(server.context); cleanup.push(dispose); return { server, dispose }; };
  const started = start(); cleanup.push(async () => { await provider?.close(); });
  await server!.rpc(workspaceEnable, { workspaceId: "workspace", enabled: true }, paseo);
  const send = async (rootId: string, text: string, clientMessageId: string, delivery: "auto" | "steer" = "auto") => {
    const agent = agents.find(agent => agent.labels["multica.discussion"] === rootId)!;
    await (await connect()).send({ type: "session.prompt", sessionId: agent.id, prompt: { clientMessageId, delivery, input: { type: "message", content: [{ type: "text", text }] } } });
  };
  return { ...started, home, paseo, agents, events, canonical, nativeHistory, comments, runs, posts, requests, lookups, receipts, deletedReceipts, connect, send, start, lookupFailure: (status?: number) => { lookupFailure = status; }, advance: (milliseconds: number) => { clock = new Date(clock.getTime() + milliseconds); }, beforeLookup: (handler: typeof beforeLookup) => { beforeLookup = handler; }, identity: async (id: string) => { identity = id; await writeFile(join(home, ".multica/config.json"), JSON.stringify({ server_url: `http://127.0.0.1:${(http.address() as { port: number }).port}`, token: `synthetic-${id}` })); }, beforeMe: (handler?: () => Promise<void>) => { beforeMe = handler; }, post: (handler: typeof post) => { post = handler; } };
}

it("main input creates an ordinary Thread and shows only its brief success hint", async () => {
  const f = await fixture();
  await f.send("main", "Hello", "input-main");
  await expect.poll(() => f.agents.length).toBe(3);
  expect(f.posts).toEqual([{ path: "/api/issues/issue/comments", body: { content: "Hello", type: "comment" }, key: expect.any(String), slug: "product" }]);
  expect(f.events).toContainEqual(expect.objectContaining({ type: "timeline.item", sessionId: f.agents[0].id, item: expect.objectContaining({ kind: "comment-delivery" }) }));
  expect(f.events.some(event => event.type === "session.turn")).toBe(false);
});

it("matches a saved reply to its native input through sync, duplicate dispatch and restart", async () => {
  const f = await fixture();
  const thread = f.agents.find(agent => agent.labels["multica.discussion"] === "root")!;
  const address = JSON.parse(thread.handle.slice(7)).data;
  await f.server.rpc(threadOpen, address, f.paseo);
  await f.send("root", "A reply", "reply");
  await expect.poll(() => f.canonical.get(thread.id)?.filter(entry => entry.item.clientMessageId === "reply" && entry.item.messageId === "saved-1").length).toBe(1);
  await f.send("root", "A reply", "reply");
  await resync(f.server, f.paseo, "workspace");
  expect(f.posts).toHaveLength(1);
  expect(f.canonical.get(thread.id)?.filter(entry => entry.item.clientMessageId === "reply")).toHaveLength(1);
  const state = JSON.parse(await readFile(join(f.home, "multica-provider/state.json"), "utf8"));
  expect(state.connections[address.connectionKey].issues.issue.commentInputs).toEqual({ reply: { commentId: "saved-1", rootId: "root" } });
  expect(state.connections[address.connectionKey].issues.issue).not.toHaveProperty("deliveries");
  await f.dispose();
  const restarted = f.start();
  const boundary = f.events.length;
  await (await f.connect()).send({ type: "session.open", requestId: "replay", sessionId: thread.id, history: "replay", persistence: JSON.parse(thread.handle.slice(7)), config: { cwd: thread.cwd, env: {}, mcpServers: {}, settings: {}, persist: true } });
  expect(f.events.slice(boundary).filter(event => event.type === "timeline.item" && event.item.type === "user_message" && event.item.clientMessageId === "reply")).toHaveLength(1);
  await resync(restarted.server, f.paseo, "workspace");
  expect(f.posts).toHaveLength(1);
});

it.each(["network", "server"])("retries a %s failure with the same key and body", async failure => {
  const f = await fixture(false, true);
  f.post(async body => {
    if (failure === "network") {
      const saved = comment("lost-response", "root", body.content); f.comments.push(saved);
      return { body: saved, disconnect: true };
    }
    return f.posts.length === 1 ? { status: 503 } : { body: comment("retried", "root", body.content) };
  });
  await f.send("root", "Retry once", "retry");
  await expect.poll(() => f.posts.length).toBe(2);
  await f.dispose();
  expect(f.posts[1]).toEqual(f.posts[0]);
  expect(f.lookups).toEqual([]);
  expect(f.events.some(event => event.type === "timeline.item" && event.item.type === "error")).toBe(false);
});

it("exhausts bounded retries with one native error and never restores failed input after restart", async () => {
  const f = await fixture(true);
  f.post(async () => ({ status: 503 }));
  const turn = f.events.find(event => event.type === "session.turn" && event.state === "started");
  await f.send("root", "Failed text", "failed", "steer");
  await expect.poll(() => f.events.filter(event => event.type === "timeline.item" && event.item.type === "error").length).toBe(1);
  expect(f.posts).toHaveLength(3);
  expect(new Set(f.posts.map(post => post.key)).size).toBe(1);
  expect(f.events).toContainEqual(expect.objectContaining({ type: "session.prompt_result", clientMessageId: "failed", result: { type: "steer", turnId: turn?.type === "session.turn" ? turn.turnId : "" } }));
  expect(await readFile(join(f.home, "multica-provider/state.json"), "utf8")).not.toContain("Failed text");
  await f.dispose(); const restarted = f.start();
  const boundary = f.events.length;
  await resync(restarted.server, f.paseo, "workspace");
  expect(f.posts).toHaveLength(3);
  expect(f.events.slice(boundary).some(event => event.type === "timeline.item" && event.item.type === "user_message" && event.item.text === "Failed text")).toBe(false);
});

it("forwards a definite remote rejection once without retry", async () => {
  const f = await fixture();
  f.post(async () => ({ status: 403, body: { error: "Issue permission denied" } }));
  await f.send("root", "Rejected", "rejected");
  await expect.poll(() => f.events.some(event => event.type === "timeline.item" && event.item.type === "error" && event.item.message === "Issue permission denied")).toBe(true);
  expect(f.posts).toHaveLength(1);
});

it("waits for an in-flight receipt before projecting an echo that arrives through sync", async () => {
  const f = await fixture();
  const thread = f.agents.find(agent => agent.labels["multica.discussion"] === "root")!;
  const address = JSON.parse(thread.handle.slice(7)).data;
  await f.server.rpc(threadOpen, address, f.paseo);
  let release!: () => void;
  f.post(async body => { const saved = comment("racing", "root", body.content); f.comments.push(saved); await new Promise<void>(resolve => { release = resolve; }); return { body: saved }; });
  await f.send("root", "Racing echo", "racing-input");
  await expect.poll(() => f.comments.some(comment => comment.id === "racing")).toBe(true);
  const reading = f.server.rpc(threadOpen, address, f.paseo);
  release(); await reading;
  expect(f.canonical.get(thread.id)?.filter(entry => entry.item.clientMessageId === "racing-input")).toHaveLength(1);
});

it("keeps typed agent mentions and rejects old-identity sends", async () => {
  const f = await fixture();
  const address = { connectionKey: f.agents[0].labels["multica.connection"], issueId: "issue" };
  const agents = (await f.server.rpc(deliveryMentions, address, f.paseo)).agents;
  expect(agents).toHaveLength(2);
  expect(agents[0].reference).not.toBe(agents[1].reference);
  await f.identity("another-user");
  await f.send("root", "Do not forward", "old-input");
  await expect.poll(() => f.events.some(event => event.type === "timeline.item" && event.item.type === "error")).toBe(true);
  expect(f.posts).toEqual([]);
});

it("accepts ordinary comment receipts whose optional askuser target is explicitly null", async () => {
  const f = await fixture(false, true);
  f.post(async body => {
    const saved = { ...comment("ordinary-null-target", body.parent_id ?? null, body.content), askuser_answer_to: null };
    f.comments.push(saved); return { body: saved };
  });
  await f.send("root", "Ordinary discussion", "ordinary-null-target");
  await expect.poll(async () => {
    const state = JSON.parse(await readFile(join(f.home, "multica-provider/state.json"), "utf8"));
    return state.connections[f.agents[0].labels["multica.connection"]].issues.issue.commentInputs["ordinary-null-target"];
  }).toEqual({ commentId: "ordinary-null-target", rootId: "root" });
  expect(f.events.some(event => event.type === "timeline.item" && event.item.type === "error")).toBe(false);
  expect(f.posts).toHaveLength(1);
});

it.each([
  { input: { type: "message", content: [{ type: "text", text: "  " }] } },
  { input: { type: "message", content: [{ type: "image", mimeType: "image/png", data: "image" }] } },
  { input: { type: "message", content: [{ type: "text", text: "attachment", mimeType: "text/plain" }] } },
  { input: { type: "command", command: "unsupported" } },
  { input: { type: "message", content: [{ type: "text", text: "structured" }] }, outputSchema: {} },
])("rejects unsupported input before admission: %j", async unsupported => {
  const f = await fixture();
  const thread = f.agents.find(agent => agent.labels["multica.discussion"] === "root")!;
  await (await f.connect()).send({ type: "session.prompt", sessionId: thread.id, prompt: { ...unsupported, clientMessageId: "invalid", delivery: "auto" } as unknown as ProviderPrompt });
  expect(f.events).toContainEqual(expect.objectContaining({ type: "session.prompt_result", clientMessageId: "invalid", result: expect.objectContaining({ type: "failed" }) }));
  expect(f.events.some(event => event.type === "session.prompt_result" && event.clientMessageId === "invalid" && event.result.type === "completed")).toBe(false);
  expect(f.posts).toEqual([]);
});

it.each(["missing-issue", "missing-root"])("rejects an unmapped %s before admitting input", async missing => {
  const f = await fixture();
  const agent = f.agents[0];
  const persistence = JSON.parse(agent.handle.slice(7));
  if (missing === "missing-issue") persistence.data.issueId = missing;
  else { persistence.data.discussion = "thread"; persistence.data.rootId = missing; }
  const provider = await f.connect();
  await provider.send({ type: "session.open", requestId: missing, sessionId: missing, history: "skip", persistence, config: { cwd: agent.cwd, env: {}, mcpServers: {}, settings: {}, persist: true } });
  await provider.send({ type: "session.prompt", sessionId: missing, prompt: { clientMessageId: missing, delivery: "auto", input: { type: "message", content: [{ type: "text", text: "Do not accept" }] } } });
  expect(f.events).toContainEqual(expect.objectContaining({ type: "session.prompt_result", clientMessageId: missing, result: expect.objectContaining({ type: "failed" }) }));
  expect(f.posts).toEqual([]);
});

it("invalid steer input keeps the captured turn while reporting one local error", async () => {
  const f = await fixture(true);
  const turn = f.events.find(event => event.type === "session.turn" && event.state === "started");
  await f.send("root", " ", "invalid-steer", "steer");
  expect(f.events).toContainEqual(expect.objectContaining({ type: "session.prompt_result", clientMessageId: "invalid-steer", result: { type: "steer", turnId: turn?.type === "session.turn" ? turn.turnId : "" } }));
  expect(f.events.filter(event => event.type === "timeline.item" && event.item.type === "error")).toHaveLength(1);
  expect(f.posts).toEqual([]);
});

it("projects input before admission and retains it before a later network error", async () => {
  const f = await fixture();
  let release!: () => void;
  f.post(async () => { await new Promise<void>(resolve => { release = resolve; }); return { status: 403, body: { error: "Remote rejection" } }; });
  await f.send("root", "Visible native input", "visible");
  await expect.poll(() => f.posts.length).toBe(1);
  const input = f.events.findIndex(event => event.type === "timeline.item" && event.item.type === "user_message" && event.item.clientMessageId === "visible");
  const admission = f.events.findIndex(event => event.type === "session.prompt_result" && event.clientMessageId === "visible");
  const nativeInput = f.events[input];
  try {
    expect(nativeInput).toMatchObject({ type: "timeline.item", item: { type: "user_message", id: "multica:input:visible", messageId: "multica:input:visible", clientMessageId: "visible", text: "Visible native input" } });
    expect(input).toBeLessThan(admission);
    expect(f.events.some(event => event.type === "timeline.item" && event.item.type === "error")).toBe(false);
  } finally { release(); }
  await expect.poll(() => f.events.filter(event => event.type === "timeline.item" && event.item.type === "error").length).toBe(1);
  expect(f.events.at(-1)).toMatchObject({ type: "timeline.item", item: { type: "error", message: "Remote rejection" } });
  const thread = f.agents.find(agent => agent.labels["multica.discussion"] === "root")!;
  expect(f.canonical.get(thread.id)?.filter(entry => entry.item.clientMessageId === "visible")).toHaveLength(1);
});

it("mentions and sending reuse the cached workspace slug without listing workspaces", async () => {
  const f = await fixture();
  const before = f.requests.filter(path => path === "/api/workspaces").length;
  await f.server.rpc(deliveryMentions, { connectionKey: f.agents[0].labels["multica.connection"], issueId: "issue" }, f.paseo);
  f.post(async () => ({ status: 403 }));
  await f.send("root", "Rejected locally visible input", "cached-workspace");
  await expect.poll(() => f.events.some(event => event.type === "timeline.item" && event.item.type === "error")).toBe(true);
  expect(f.requests.filter(path => path === "/api/workspaces")).toHaveLength(before);
  expect(f.posts[0].slug).toBe("product");
});
