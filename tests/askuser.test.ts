import { createServer } from "node:http";
import { createRequire } from "node:module";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import type { PaseoApi } from "@getpaseo/client";
import type { DaemonClient } from "@getpaseo/client/internal/daemon-client";
import type { ProviderConnection, ProviderTimelineItem, ProviderEvent } from "@getpaseo/plugin/server/provider";
import { defineRpc } from "@getpaseo/plugin";
import { z } from "zod";
import { workspaceEnable, syncBootstrap } from "../shared/contracts.js";
import { issueHistoryList, issueHistoryRead, cachedIssueSnapshot } from "../shared/access.js";
import { deliveryList, deliveryVerify, deliveryResend } from "../shared/delivery.js";
import { hiddenRestore } from "../shared/hiding.js";
import { threadOpen } from "../shared/threads.js";
import { createServerContribution } from "../server/contribute.js";
import { FakeServer } from "./support/fake-server.js";

const cleanup: Array<() => void | Promise<void>> = [];
afterEach(async () => { for (const dispose of cleanup.splice(0).reverse()) await dispose(); });
const card = { version: "1", title: "发布确认", description: "此操作会影响生产环境。", questions: [{ id: "reason", type: "text", title: "理由" }] };
const stamp = "2026-11-24T10:00:00Z";
const attachment = (id: string, download_url = `/api/attachments/${id}/download`) => ({ id, filename: "askuser.json", content_type: "application/json", download_url });
const comment = (id: string, parent_id: string | null, attachments: unknown[] = []) => ({ id, parent_id, issue_id: "issue", type: "comment", author_type: "member", author_id: "me", content: `Comment ${id}`, created_at: stamp, attachments });
type TimelineEntry = { id: string; type: string; parent_id?: string | null; content?: string; actor_id?: string; actor_type?: string; delegated_by?: string | null; deleted_at?: string | null; askuser_skipped_at?: string | null; askuser_skipped_by?: string | null };

async function fixture() {
  const home = await mkdtemp(join(tmpdir(), "multica-askuser-"));
  cleanup.push(() => rm(home, { recursive: true, force: true }));
  const comments = [comment("root", null)];
  const timeline: TimelineEntry[] = [];
  const runs: Array<Record<string, unknown>> = [];
  const posts: Array<{ body: Record<string, any>; key: string }> = [];
  const skips: string[] = [];
  const receipts = new Map<string, Record<string, any>>();
  let clock = new Date(stamp);
  const documents = new Map<string, unknown>();
  const requests: Array<{ path: string; slug?: string; authorization?: string }> = [];
  const remote = { status: 200, contentType: "application/json", redirect: false, chunked: false, issueStatus: 200, userId: "me", objectChecksUntilDeny: -1, postStatus: 200, loseResponse: false, skipStatus: 204, loseSkipResponse: false, beforeSkip: undefined as (() => Promise<void>) | undefined, beforeIssueCheck: undefined as (() => Promise<void>) | undefined, beforePost: undefined as (() => Promise<void>) | undefined, beforeDownload: undefined as (() => Promise<void>) | undefined };
  const http = createServer(async (request, response) => {
    requests.push({ path: request.url!, slug: request.headers["x-workspace-slug"] as string, authorization: request.headers.authorization });
    const url = new URL(request.url!, "http://localhost");
    response.setHeader("Content-Type", "application/json");
    let body: unknown;
    if (request.method === "POST" && url.pathname.endsWith("/askuser-skip")) {
      skips.push(url.pathname); await remote.beforeSkip?.();
      if (remote.loseSkipResponse) { response.destroy(); return; }
      response.statusCode = remote.skipStatus; response.end(remote.skipStatus === 204 ? undefined : JSON.stringify({})); return;
    }
    if (request.method === "POST" && url.pathname === "/api/issues/issue/comments") {
      let text = ""; for await (const chunk of request) text += chunk;
      const input = JSON.parse(text); const key = request.headers["idempotency-key"] as string; posts.push({ body: input, key });
      await remote.beforePost?.(); response.statusCode = remote.postStatus;
      if (remote.postStatus === 200) {
        const saved = { ...comment(`saved-${posts.length}`, input.parent_id ?? null), content: input.content, askuser_answer_to: input.askuser_answer_to };
        receipts.set(key, saved); comments.push(saved); body = saved;
        if (remote.loseResponse) { response.destroy(); return; }
      } else body = {};
    }
    else if (url.pathname === "/api/issues/issue/comments/idempotent") {
      const receipt = receipts.get(request.headers["idempotency-key"] as string);
      if (receipt) { response.setHeader("Idempotent-Replayed", "true"); body = receipt; }
      else { response.statusCode = 404; body = { error: "no comment has been posted with this Idempotency-Key" }; }
    }
    else if (url.pathname === "/api/me") body = { id: remote.userId, name: "Lin" };
    else if (url.pathname === "/api/workspaces") body = [{ id: "workspace", name: "Product", slug: "product" }];
    else if (url.pathname === "/api/agents") body = [{ id: "agent", name: "Builder" }];
    else if (url.pathname === "/api/issues") body = { issues: [{ id: "issue", workspace_id: "workspace", title: "Task", description: "Description", status: "todo" }], total: 1 };
    else if (url.pathname === "/api/issues/issue") { await remote.beforeIssueCheck?.(); response.statusCode = remote.objectChecksUntilDeny === 0 ? 403 : remote.issueStatus; if (remote.objectChecksUntilDeny > 0) remote.objectChecksUntilDeny--; body = { id: "issue", workspace_id: "workspace", title: "Task", status: "todo" }; }
    else if (url.pathname === "/api/issues/issue/comments") body = comments.map(c => url.searchParams.has("summary") ? { ...c, content: [...c.content].slice(0, 200).join(""), content_truncated: [...c.content].length > 200 } : c);
    else if (url.pathname === "/api/issues/issue/timeline") body = timeline;
    else if (url.pathname === "/api/issues/issue/task-runs") body = runs;
    else if (url.pathname.startsWith("/api/attachments/")) {
      await remote.beforeDownload?.();
      response.statusCode = remote.status;
      response.setHeader("Content-Type", remote.contentType);
      if (remote.redirect) { response.statusCode = 302; response.setHeader("Location", "/leaked"); }
      const document = documents.get(url.pathname.split("/")[3]);
      if (remote.chunked) response.write(" ");
      response.end(typeof document === "string" ? document : JSON.stringify(document)); return;
    } else { response.statusCode = 404; body = {}; }
    response.end(JSON.stringify(body));
  });
  await new Promise<void>(resolve => http.listen(0, "127.0.0.1", resolve));
  cleanup.push(() => new Promise<void>(resolve => { http.close(() => resolve()); http.closeAllConnections(); }));
  const { WebSocketServer } = createRequire(import.meta.url)("ws");
  const websocket = new WebSocketServer({ server: http });
  cleanup.push(() => { for (const socket of websocket.clients) socket.close(); websocket.close(); });
  const configPath = join(home, ".multica/config.json");
  await mkdir(join(home, ".multica"));
  await writeFile(configPath, JSON.stringify({ server_url: `http://127.0.0.1:${(http.address() as { port: number }).port}`, token: "synthetic" }));
  const agents: Array<{ id: string; workspaceId: string; cwd: string; labels: Record<string, string>; handle: string }> = [];
  const rows = new Map<string, ProviderTimelineItem[]>();
  const events: ProviderEvent[] = [];
  let server: FakeServer;
  let provider: ProviderConnection | undefined;
  async function connect() {
    if (provider) return provider;
    provider = await server.providers.get("multica")!.connect({ versions: [1], capabilities: ["session.persistence", "timeline.plugin", "permission"] });
    provider.onEvent(event => {
      events.push(event);
      if (event.type !== "timeline.item") return;
      const current = rows.get(event.sessionId) ?? [];
      const index = current.findIndex(row => row.id === event.item.id);
      if (index < 0) current.push(event.item); else current[index] = event.item;
      rows.set(event.sessionId, current);
    });
    return provider;
  }
  const open = async (history: "skip" | "replay") => {
    for (const agent of agents) await (await connect()).send({ type: "session.open", requestId: agent.id, sessionId: agent.id, history,
      persistence: JSON.parse(agent.handle.slice(7)), config: { cwd: agent.cwd, env: {}, mcpServers: {}, settings: {}, persist: true } });
  };
  const host = {
    listHosts: async () => ({ self: { serverId: "daemon" } }), listProjects: async () => ({ projects: [] }),
    addProject: async () => ({ project: { projectId: "project", projectKind: "non_git" } }), renameProject: async () => {},
    fetchWorkspaces: async () => ({ entries: [], pageInfo: { hasMore: false } }),
    createWorkspace: async (input: { workspaceId: string }) => ({ workspace: { id: input.workspaceId } }), setWorkspaceTitle: async () => {},
    fetchAgents: async () => ({ entries: agents.map(agent => ({ agent: { provider: "multica", ...agent } })), pageInfo: { hasMore: false } }),
    importAgent: async (input: { workspaceId: string; cwd: string; labels: Record<string, string>; providerHandleId: string }) => {
      const agent = { id: `native-${agents.length}`, workspaceId: input.workspaceId, cwd: input.cwd, labels: input.labels, handle: input.providerHandleId };
      agents.push(agent);
      await (await connect()).send({ type: "session.open", requestId: agent.id, sessionId: agent.id, history: "replay", persistence: JSON.parse(agent.handle.slice(7)), config: { cwd: agent.cwd, env: {}, mcpServers: {}, settings: {}, persist: true } });
      return agent;
    }, updateAgent: async () => {}, close: async () => {},
    fetchAgent: async (id: string) => ({ agent: agents.find(agent => agent.id === id) }), restoreWorkspace: async () => {},
    fetchAgentTimeline: async () => ({ agentId: "unused", epoch: "epoch", entries: [], hasOlder: false, hasNewer: false }),
  } as unknown as DaemonClient;
  const paseo = { hosts: { list: async () => ({ self: { serverId: "daemon" } }) } } as unknown as PaseoApi;
  const start = () => {
    server = new FakeServer();
    const dispose = createServerContribution({ homeDirectory: home, workingDirectory: home, environment: { PASEO_HOME: home }, syncIntervalMs: 1_000_000, now: () => clock, connectHost: async () => host })(server.context);
    cleanup.push(dispose); return { server, dispose };
  };
  const started = start();
  cleanup.push(async () => { await provider?.close(); });
  await server!.rpc(workspaceEnable, { workspaceId: "workspace", enabled: true }, paseo);
  const address = () => ({ connectionKey: agents[1].labels["multica.connection"], issueId: "issue", rootId: "root" });
  const cards = () => (rows.get(agents[1].id) ?? []).filter(row => row.type === "plugin" && row.kind === "askuser") as Array<Extract<ProviderTimelineItem, { type: "plugin" }> & { data: Record<string, any> }>;
  return { ...started, start, connect, events, posts, skips, receipts, setClock: (value: Date) => { clock = value; }, comments, timeline, runs, documents, requests, remote, rows, agents, cards, address, open, home, configPath, paseo,
    disconnect: async () => { await provider?.close(); provider = undefined; }, signal: (type: string) => { for (const socket of websocket.clients) socket.send(JSON.stringify({ type })); }, eventsReady: () => expect.poll(() => websocket.clients.size).toBeGreaterThan(0), sync: () => server.rpc(syncBootstrap, {}, paseo) };
}

it("discovers root and descendant cards on their owning Thread and downloads each attachment only once across restart", async () => {
  const f = await fixture();
  f.comments[0].attachments = [attachment("root-file")];
  f.comments.push(comment("child", "root", [attachment("child-file")]), comment("grandchild", "child", [attachment("child-file")]));
  f.documents.set("root-file", card); f.documents.set("child-file", { ...card, title: "子回复确认" });
  await f.sync();
  expect(f.cards().map(row => [row.data.commentId, row.data.title, row.data.status])).toEqual([["root", "发布确认", "pending"], ["child", "子回复确认", "pending"], ["grandchild", "子回复确认", "pending"]]);
  const ids = f.cards().map(row => row.id);
  await f.server.rpc(threadOpen, f.address(), f.paseo); await f.sync();
  expect(f.requests.filter(r => r.path.startsWith("/api/attachments/")).map(r => [r.path, r.slug, r.authorization])).toEqual([
    ["/api/attachments/root-file/download", "product", "Bearer synthetic"], ["/api/attachments/child-file/download", "product", "Bearer synthetic"],
  ]);
  await f.dispose(); await f.disconnect(); const restarted = f.start(); await f.open("skip");
  await restarted.server.rpc(syncBootstrap, {}, f.paseo);
  expect(f.cards().map(row => row.id)).toEqual(ids);
  expect(f.requests.filter(r => r.path.startsWith("/api/attachments/"))).toHaveLength(2);
});

it.each([
  ["cross-origin", "跨源"], ["redirect", "重定向"], ["oversized", "64 KiB"], ["non-JSON media", "JSON"],
  ["invalid JSON", "JSON"], ["unsupported version", "version"], ["download failure", "HTTP 503"],
])("%s attachments degrade honestly without blocking ordinary comments or retrying their download", async (failure, message) => {
  const f = await fixture();
  f.comments[0].attachments = [attachment("broken", failure === "cross-origin" ? "//example.invalid/private" : undefined)];
  f.documents.set("broken", failure === "oversized" ? "x".repeat(65537) : failure === "invalid JSON" ? "{" : failure === "unsupported version" ? { ...card, version: "2" } : card);
  if (failure === "redirect") f.remote.redirect = true;
  if (failure === "non-JSON media") f.remote.contentType = "text/html";
  if (failure === "download failure") f.remote.status = 503;
  await f.sync();
  expect(f.cards()[0]?.data).toMatchObject({ status: "invalid", commentId: "root", attachmentId: "broken", error: expect.stringContaining(message) });
  await f.server.rpc(threadOpen, f.address(), f.paseo); await f.sync();
  expect(f.rows.get(f.agents[1].id)).toContainEqual(expect.objectContaining({ type: "user_message", text: expect.stringContaining("Comment root") }));
  expect(f.requests.filter(r => r.path.startsWith("/api/attachments/"))).toHaveLength(failure === "cross-origin" ? 0 : 1);
  expect(f.requests.some(r => r.path === "/leaked" || r.path.includes("example.invalid"))).toBe(false);
});

it("uses one full Issue timeline for all pending cards, detects a long escaped answer and a skipped child, then stops polling terminal cards", async () => {
  const f = await fixture();
  expect(f.requests.filter(r => r.path.endsWith("/timeline"))).toEqual([]);
  f.comments[0].attachments = [attachment("root-file")];
  f.comments.push(comment("child", "root", [attachment("child-file")]));
  const questions = [{ id: "reason", type: "text", title: "理由" }, { id: "proof", type: "text", title: "凭据" }];
  f.documents.set("root-file", { ...card, questions }); f.documents.set("child-file", card);
  const content = `\\*\\*确认结果\\*\\*\n\n1\\. \\*\\*理由\\*\\*：${"长回答".repeat(100)}\n2\\. \\*\\*凭据\\*\\*：通过`;
  f.comments.push({ ...comment("answer", "root"), content });
  f.timeline.push({ id: "root", type: "comment" }, { id: "child", type: "comment", parent_id: "root", askuser_skipped_at: stamp, askuser_skipped_by: "reviewer" },
    { id: "answer", type: "comment", parent_id: "root", actor_type: "member", actor_id: "me", content });
  await f.sync();
  expect(f.cards().map(row => row.data)).toMatchObject([
    { status: "answered", answer: { commentId: "answer", actorId: "me", content: expect.stringContaining("凭据") } },
    { status: "skipped", skippedAt: stamp, skippedBy: "reviewer" },
  ]);
  expect(f.requests.filter(r => r.path.endsWith("/timeline"))).toHaveLength(1);
  await f.server.rpc(threadOpen, f.address(), f.paseo); await f.sync();
  expect(f.requests.filter(r => r.path.endsWith("/timeline"))).toHaveLength(1);
});

const mixedQuestions = [
  { id: "choice", type: "single", title: "发布范围", options: [{ id: "all", label: "全量" }, { id: "canary", label: "灰度" }], other: { enabled: true, label: "其他范围" } },
  { id: "detail", type: "text", title: "说明", required_when: { question_id: "choice", option_ids: ["all"] } },
  { id: "optional", type: "text", title: "备注", required: false },
  { id: "multiple", type: "multiple", title: "检查项", options: [{ id: "one", label: "监控" }] },
];
it("preserves validated text, single, multiple, other and conditional question definitions for read-only cards", async () => {
  const f = await fixture(); f.comments[0].attachments = [attachment("mixed")];
  f.documents.set("mixed", { ...card, questions: mixedQuestions }); await f.sync();
  expect(f.cards()[0]?.data).toMatchObject({ status: "pending", questions: mixedQuestions, description: card.description });
});

it.each([
  ["empty questions", { ...card, questions: [] }], ["blank title", { ...card, title: " " }],
  ["unknown top-level field", { ...card, unknown: true }],
  ["duplicate question IDs", { ...card, questions: [card.questions[0], card.questions[0]] }],
  ["both required and conditional", { ...card, questions: [mixedQuestions[0], { ...mixedQuestions[1], required: false }] }],
  ["forward condition", { ...card, questions: [mixedQuestions[1], mixedQuestions[0]] }],
  ["unknown conditional option", { ...card, questions: [mixedQuestions[0], { ...mixedQuestions[1], required_when: { question_id: "choice", option_ids: ["missing"] } }] }],
  ["choice required flag", { ...card, questions: [{ ...mixedQuestions[0], required: true }] }],
  ["empty choices", { ...card, questions: [{ ...mixedQuestions[0], options: [] }] }],
  ["six choices", { ...card, questions: [{ ...mixedQuestions[0], options: Array.from({ length: 6 }, (_, i) => ({ id: String(i), label: String(i) })) }] }],
  ["option value", { ...card, questions: [{ ...mixedQuestions[0], options: [{ id: "all", label: "全量", value: "all" }] }] }],
  ["option description", { ...card, questions: [{ ...mixedQuestions[0], options: [{ id: "all", label: "全量", description: "Not supported" }] }] }],
])("rejects %s instead of silently changing the card schema", async (_failure, document) => {
  const f = await fixture(); f.comments[0].attachments = [attachment("invalid")]; f.documents.set("invalid", document); await f.sync();
  expect(f.cards()[0]?.data).toMatchObject({ status: "invalid", error: expect.stringContaining("schema") });
});

it.each([
  ["member", "me", undefined, "灰度", "", true],
  ["member", "intruder", undefined, "灰度", "", false],
  ["agent", "me", undefined, "灰度", "", false],
  ["agent", "runner", "me", "灰度", "", true],
  ["member", "intruder", "me", "灰度", "", false],
  ["system", "me", "me", "灰度", "", false],
  ["member", "me", undefined, "全量", "", false],
  ["member", "me", undefined, "全量（补充：明天）", "已确认", true],
  ["member", "me", undefined, "自定义范围", "", false],
  ["member", "me", undefined, "自定义范围", "已确认", true],
  ["member", "me", undefined, "未回答", "已确认", false],
])("strict answers respect actor %s/%s delegation %s and condition %s with detail %s", async (actor_type, actor_id, delegated_by, selected, detail, answered) => {
  const f = await fixture(); f.comments[0].attachments = [attachment("strict")];
  f.documents.set("strict", { ...card, answer_user_id: "me", questions: mixedQuestions.slice(0, 3) });
  f.timeline.push({ id: "answer", type: "comment", parent_id: "root", actor_type, actor_id, delegated_by,
    content: `**确认结果**\n\n1. **发布范围**：${selected}\n2. **说明**：${detail}\n3. **备注**：` });
  await f.sync(); expect(f.cards()[0]?.data.status).toBe(answered ? "answered" : "pending");
});

it.each(["missing", "duplicate", "required blank", "required placeholder", "deleted", "indirect", "non-comment", "ambiguous choice"])("strict required cards ignore %s replies", async failure => {
  const f = await fixture(); f.comments[0].attachments = [attachment("strict")];
  const questions = failure === "ambiguous choice" ? [{ ...mixedQuestions[0], options: [{ id: "all", label: "灰度" }, { id: "canary", label: "灰度" }] }, mixedQuestions[1]] : card.questions;
  f.documents.set("strict", { ...card, require_answer: true, questions });
  const content = failure === "ambiguous choice" ? "**确认结果**\n\n1. **发布范围**：灰度\n2. **说明**：" : `**确认结果**\n\n1. **理由**：${failure === "required blank" ? "" : failure === "required placeholder" ? "未回答" : "有效"}${failure === "duplicate" ? "\n1. **理由**：重复" : ""}`;
  f.timeline.push({ id: "answer", type: failure === "non-comment" ? "event" : "comment", parent_id: failure === "indirect" ? "other" : "root", actor_type: "member", actor_id: "me", content: failure === "missing" ? "**确认结果**\n\n其他题目" : content, deleted_at: failure === "deleted" ? stamp : null });
  await f.sync(); expect(f.cards()[0]?.data.status).toBe("pending");
});

const observeCard = defineRpc({ name: "askuser.observe", input: z.object({ connectionKey: z.string(), issueId: z.string(), commentId: z.string(), attachmentId: z.string() }), output: z.record(z.string(), z.any()) });
const readCard = defineRpc({ name: "askuser.read", input: observeCard.input.extend({ revision: z.string(), offset: z.number() }), output: z.object({ text: z.string(), nextOffset: z.number().nullable() }) });
it("bounds timeline and observe payloads, reads complete warning details by revision, and keeps cached cards readable offline", async () => {
  const f = await fixture(); const description = "风险".repeat(10000);
  f.comments[0].attachments = [attachment("long")]; f.documents.set("long", { ...card, description, answer_user_id: "reviewer" }); await f.sync();
  const row = f.cards()[0];
  expect(Buffer.byteLength(JSON.stringify(row))).toBeLessThan(32768);
  expect(row.data).toMatchObject({ truncated: true, readOnly: true, readOnlyReason: expect.stringContaining("reviewer") });
  const address = { ...f.address(), commentId: "root", attachmentId: "long" };
  const observed = await f.server.rpc(observeCard, address, f.paseo);
  expect(Buffer.byteLength(JSON.stringify(observed))).toBeLessThan(32768);
  let text = ""; let offset: number | null = 0;
  while (offset !== null) { const result: { text: string; nextOffset: number | null } = await f.server.rpc(readCard, { ...address, revision: observed.revision, offset }, f.paseo); text += result.text; offset = result.nextOffset; }
  expect(JSON.parse(text)).toMatchObject({ description, questions: card.questions });
  await writeFile(f.configPath, "{}");
  const cached = await f.server.rpc(observeCard, address, f.paseo);
  expect(cached).toMatchObject({ offline: true, readOnly: true, title: "发布确认" });
  const before = f.requests.length;
  expect((await f.server.rpc(readCard, { ...address, revision: cached.revision, offset: 0 }, f.paseo)).text).toContain("root");
  expect(f.requests).toHaveLength(before);
  await expect(f.server.rpc(readCard, { ...address, revision: "stale", offset: 0 }, f.paseo)).rejects.toThrow();
});

it("discards attachment bytes when CLI credentials change in flight and never caches them as a valid card", async () => {
  const f = await fixture(); f.comments[0].attachments = [attachment("private")]; f.documents.set("private", card);
  f.remote.beforeDownload = async () => { await writeFile(f.configPath, "{}"); };
  await f.sync();
  expect(f.cards()[0]?.data).toMatchObject({ status: "invalid", questions: [], error: expect.stringContaining("上下文") });
  expect(f.cards()[0]?.data.title).not.toBe(card.title);
  const downloads = f.requests.filter(r => r.path.startsWith("/api/attachments/")).length;
  const observed = await f.server.rpc(observeCard, { ...f.address(), commentId: "root", attachmentId: "private" }, f.paseo);
  expect(observed).toMatchObject({ readOnly: true, offline: true });
  expect(f.requests.filter(r => r.path.startsWith("/api/attachments/"))).toHaveLength(downloads);
});

it("ignores non-card attachments and system comments and still discovers cards first seen when a Thread is opened", async () => {
  const f = await fixture();
  f.comments.push({ ...comment("system", "root", [attachment("ignored")]), type: "progress_update" });
  f.comments[0].attachments = [{ ...attachment("wrong-name"), filename: "askuser.JSON" }, { ...attachment("wrong-type"), content_type: "text/json" }];
  await f.sync(); expect(f.cards()).toEqual([]); expect(f.requests.some(r => r.path.endsWith("/timeline"))).toBe(false);
  f.comments[0].attachments.push(attachment("opened")); f.documents.set("opened", card);
  await f.server.rpc(threadOpen, f.address(), f.paseo);
  expect(f.cards()[0]?.data).toMatchObject({ title: card.title, commentId: "root", status: "pending" });
});

it("keeps attachment discovery once-only when background sync and Thread opening overlap", async () => {
  const f = await fixture(); f.comments[0].attachments = [attachment("overlap")]; f.documents.set("overlap", card);
  let entered!: () => void; let release!: () => void;
  const arrived = new Promise<void>(resolve => { entered = resolve; });
  const blocked = new Promise<void>(resolve => { release = resolve; });
  f.remote.beforeDownload = async () => { entered(); await blocked; };
  const sync = f.sync(); await arrived;
  const open = f.server.rpc(threadOpen, f.address(), f.paseo);
  // Wait until the independent full Thread read has reached the remote boundary.
  await expect.poll(() => f.requests.some(r => r.path.includes("thread=root"))).toBe(true);
  release(); await Promise.all([sync, open]);
  expect(f.requests.filter(r => r.path.startsWith("/api/attachments/"))).toHaveLength(1);
});

it("preserves complete read-only card history after its source comment is removed and the daemon restarts", async () => {
  const f = await fixture(); f.comments[0].attachments = [attachment("cached")]; f.documents.set("cached", card); await f.sync();
  f.comments.length = 0; await f.sync();
  expect(f.cards()[0]?.data).toMatchObject({ readOnly: true, readOnlyReason: expect.stringContaining("删除") });
  await f.dispose(); await f.disconnect(); const restarted = f.start();
  await writeFile(f.configPath, "{}");
  const summary = (await restarted.server.rpc(issueHistoryList, {}, f.paseo)).issues[0];
  let text = ""; let offset: number | null = 0;
  while (offset !== null) { const result: { text: string; nextOffset: number | null } = await restarted.server.rpc(issueHistoryRead, { ...f.address(), revision: summary.revision, offset }, f.paseo); text += result.text; offset = result.nextOffset; }
  const snapshot = cachedIssueSnapshot.parse(JSON.parse(text));
  expect(snapshot).toMatchObject({ askuserCards: [{ title: card.title, description: card.description, questions: card.questions, readOnly: true, offline: true }] });
});

it("enforces the attachment byte limit while streaming a chunked response", async () => {
  const f = await fixture(); f.comments[0].attachments = [attachment("stream")]; f.documents.set("stream", " ".repeat(65536)); f.remote.chunked = true; await f.sync();
  expect(f.cards()[0]?.data).toMatchObject({ status: "invalid", error: expect.stringContaining("64 KiB") });
});

it("rechecks Issue access immediately before attachment downloading", async () => {
  const f = await fixture(); f.comments[0].attachments = [attachment("denied")]; f.documents.set("denied", card); f.remote.objectChecksUntilDeny = 1; await f.sync();
  expect(f.cards()[0]?.data).toMatchObject({ status: "invalid", error: expect.stringContaining("HTTP 403") });
  expect(f.requests.some(request => request.path.startsWith("/api/attachments/"))).toBe(false);
});

it("updates the same card when a WebSocket invalidation reveals an external answer", async () => {
  const f = await fixture(); f.comments[0].attachments = [attachment("external")]; f.documents.set("external", card); await f.sync();
  const id = f.cards()[0].id;
  f.timeline.push({ id: "external-answer", type: "comment", parent_id: "root", content: "**确认结果**\n\n1. **理由**：网页确认", actor_type: "member", actor_id: "other" });
  await f.eventsReady(); f.signal("auth_ack"); f.signal("comment:created");
  await expect.poll(() => f.cards()[0]?.data.status).toBe("answered");
  expect(f.cards()).toHaveLength(1); expect(f.cards()[0].id).toBe(id);
});

it("places a generated root card in its new Thread while its unanchored Run stays on the local main discussion", async () => {
  const f = await fixture(); f.runs.push({ id: "unanchored", issue_id: "issue", agent_id: "agent", status: "completed" }); await f.sync();
  f.comments.push({ ...comment("generated", null, [attachment("generated-file")]), source_task_id: "unanchored" } as ReturnType<typeof comment>);
  f.documents.set("generated-file", card); await f.sync();
  const generated = f.agents.find(agent => agent.labels["multica.discussion"] === "generated")!;
  expect(f.rows.get(generated.id)).toContainEqual(expect.objectContaining({ type: "plugin", kind: "askuser", data: expect.objectContaining({ rootId: "generated", commentId: "generated" }) }));
  expect(f.rows.get(f.agents[0].id)).toContainEqual(expect.objectContaining({ type: "plugin", kind: "run-summary", id: "multica:run:unanchored" }));
  expect(f.rows.get(generated.id)?.some(row => row.type === "plugin" && row.kind === "run-summary")).toBe(false);
});

it("keeps a prior connection's cached card read-only after the CLI resolves another account", async () => {
  const f = await fixture(); f.comments[0].attachments = [attachment("account")]; f.documents.set("account", { ...card, answer_user_id: "me" }); await f.sync();
  f.remote.userId = "other";
  const data = await f.server.rpc(observeCard, { ...f.address(), commentId: "root", attachmentId: "account" }, f.paseo);
  expect(data).toMatchObject({ title: card.title, readOnly: true, offline: true });
  await f.sync();
  expect(f.requests.filter(request => request.path.startsWith("/api/attachments/"))).toHaveLength(1);
});

it("a malformed attachment link degrades without stopping the rest of its ordinary comment", async () => {
  const f = await fixture(); f.comments[0].attachments = [{ ...attachment("malformed"), download_url: 7 }]; await f.sync();
  expect(f.cards()[0]?.data).toMatchObject({ status: "invalid", error: expect.stringContaining("download_url") });
  await f.server.rpc(threadOpen, f.address(), f.paseo);
  expect(f.rows.get(f.agents[1].id)).toContainEqual(expect.objectContaining({ type: "user_message", text: expect.stringContaining("Comment root") }));
});

it("keeps an unusually long designated-user warning inside the timeline row budget", async () => {
  const f = await fixture(); f.comments[0].attachments = [attachment("long-target")]; f.documents.set("long-target", { ...card, answer_user_id: "reviewer".repeat(7500) }); await f.sync();
  expect(Buffer.byteLength(JSON.stringify(f.cards()[0]))).toBeLessThan(32768);
  expect(f.cards()[0]?.data).toMatchObject({ truncated: true, readOnly: true });
});

it("defers new attachment downloads until a manually hidden discussion is restored", async () => {
  const f = await fixture(); await f.server.hook("agent.archive.after", { agent: { ...f.agents[1], provider: "multica" } } as never, f.paseo);
  f.comments[0].attachments = [attachment("hidden")]; f.documents.set("hidden", card); await f.sync();
  expect(f.requests.some(request => request.path.startsWith("/api/attachments/"))).toBe(false);
  expect(f.cards()).toEqual([]);
  expect(await f.server.rpc(hiddenRestore, f.address(), f.paseo)).toMatchObject({ status: "ready" });
  await f.sync();
  expect(f.cards()[0]?.data).toMatchObject({ title: card.title, status: "pending" });
  expect(f.requests.filter(request => request.path.startsWith("/api/attachments/"))).toHaveLength(1);
});


it("negotiates native questions with unique headers, all question types and readable warning context only for the designated user", async () => {
  const f = await fixture();
  expect((await f.connect()).capabilities).toContain("permission");
  f.comments[0].attachments = [attachment("native")];
  f.documents.set("native", { ...card, answer_user_id: "me", questions: [
    mixedQuestions[0], { ...mixedQuestions[1], title: "重复标题" }, { ...mixedQuestions[2], title: "重复标题" }, mixedQuestions[3], card.questions[0],
  ] });
  await f.sync();
  const permission = f.events.filter(event => event.type === "session.permission").at(-1) as Extract<ProviderEvent, { type: "session.permission" }>;
  expect(permission).toMatchObject({ sessionId: f.agents[1].id, request: { id: "multica:askuser:root:native", name: "askuser", kind: "question", title: card.title, description: card.description,
    input: { dismissLabel: "仅本地收起（不跳过）", questions: [
      { options: [{ label: "全量" }, { label: "灰度" }], multiSelect: false, allowOther: true, placeholder: "其他范围", allowEmpty: false },
      { options: [], allowEmpty: true }, { options: [], allowEmpty: true }, { options: [{ label: "监控" }], multiSelect: true, allowOther: false, allowEmpty: false }, { options: [], allowEmpty: false },
    ] } } });
  const questions = permission.request.input!.questions as Array<{ header: string; question: string }>;
  expect(questions[0].question).toContain(card.title); expect(questions[0].question).toContain(card.description);
  expect(questions[1].question).toContain("无法确认选项时也必填");
  expect(questions.every(q => q.header.trim())).toBe(true); expect(new Set(questions.map(q => q.header)).size).toBe(5);
  f.comments.push(comment("child", "root", [attachment("other-user")]));
  f.documents.set("other-user", { ...card, answer_user_id: "other" }); await f.sync();
  expect(f.events.filter(event => event.type === "session.permission")).toHaveLength(1);
});


it("restores pending native permissions between opened and ready while new cards arrive live and terminal changes explicitly resolve them", async () => {
  const f = await fixture(); f.comments[0].attachments = [attachment("replayed")]; f.documents.set("replayed", card); await f.sync();
  await f.dispose(); await f.disconnect(); const restarted = f.start(); f.events.length = 0; await f.open("skip");
  const native = f.agents[1].id;
  const opening = f.events.filter(event => "sessionId" in event && event.sessionId === native);
  expect(opening.map(event => event.type).indexOf("session.permission")).toBeGreaterThan(opening.map(event => event.type).indexOf("session.opened"));
  expect(opening.map(event => event.type).indexOf("session.permission")).toBeLessThan(opening.map(event => event.type).indexOf("session.ready"));
  f.comments.push(comment("child", "root", [attachment("live")])); f.documents.set("live", card);
  await restarted.server.rpc(syncBootstrap, {}, f.paseo);
  const live = f.events.map(event => event.type === "session.permission" && event.request.id === "multica:askuser:child:live").lastIndexOf(true);
  expect(live).toBeGreaterThan(f.events.map(event => event.type).lastIndexOf("session.ready"));
  f.timeline.push({ id: "answer", type: "comment", parent_id: "root", content: "**确认结果**\n\n1. **理由**：网页回答", actor_type: "member", actor_id: "me" },
    { id: "child", type: "comment", askuser_skipped_at: stamp });
  await restarted.server.rpc(syncBootstrap, {}, f.paseo);
  expect(f.events.filter(event => event.type === "session.permission_resolved").map(event => event.permissionId)).toEqual(["multica:askuser:root:replayed", "multica:askuser:child:live"]);
  f.comments.push(comment("removed", "root", [attachment("deleted")])); f.documents.set("deleted", card);
  await restarted.server.rpc(syncBootstrap, {}, f.paseo); f.comments.pop(); await restarted.server.rpc(syncBootstrap, {}, f.paseo);
  expect(f.events).toContainEqual({ type: "session.permission_resolved", sessionId: native, permissionId: "multica:askuser:removed:deleted" });
});


const pendingQuestion = (f: Awaited<ReturnType<typeof fixture>>, id?: string) => f.events.filter((event): event is Extract<ProviderEvent, { type: "session.permission" }> => event.type === "session.permission" && (!id || event.request.id === id)).at(-1)!;
const answer = async (f: Awaited<ReturnType<typeof fixture>>, values: string[], id?: string) => {
  const request = pendingQuestion(f, id).request;
  const questions = request.input!.questions as Array<{ header: string }>;
  return (await f.connect()).send({ type: "session.permission", sessionId: f.agents[1].id, permissionId: request.id,
    response: { behavior: "allow", updatedInput: { answers: Object.fromEntries(questions.map((question, i) => [question.header, values[i] ?? ""])) } } });
};

it("Dismiss only collapses a native form locally, persisting across synchronization and restart", async () => {
  const f = await fixture(); f.comments[0].attachments = [attachment("dismiss")]; f.documents.set("dismiss", card); await f.sync();
  const permission = pendingQuestion(f).request;
  await (await f.connect()).send({ type: "session.permission", sessionId: f.agents[1].id, permissionId: permission.id, response: { behavior: "deny", message: "Dismissed by user" } });
  expect(f.cards()[0].data).toMatchObject({ status: "pending", collapsed: true, readOnly: false });
  expect(f.events).toContainEqual({ type: "session.permission_resolved", sessionId: f.agents[1].id, permissionId: permission.id });
  await f.sync();
  expect(f.events.filter(event => event.type === "session.permission")).toHaveLength(1);
  await f.dispose(); await f.disconnect(); f.events.length = 0; f.start(); await f.open("skip"); await f.sync();
  expect(f.cards()[0].data).toMatchObject({ status: "pending", collapsed: true });
  expect(f.events.some(event => event.type === "session.permission")).toBe(false);
  expect(f.posts).toEqual([]);
  expect(f.requests.some(request => request.path.includes("askuser-skip"))).toBe(false);
});

it("protects blank all-optional-text allow responses from the native Dismiss encoding", async () => {
  const f = await fixture(); f.comments[0].attachments = [attachment("empty-dismiss")];
  f.documents.set("empty-dismiss", { ...card, questions: [{ id: "note", title: "备注", type: "text", required: false }, { id: "details", title: "补充", type: "text", required: false }] }); await f.sync();
  await answer(f, [" \n ", "\t"]);
  expect(f.cards()[0].data).toMatchObject({ status: "pending", collapsed: true });
  expect(f.events).toContainEqual({ type: "session.permission_resolved", sessionId: f.agents[1].id, permissionId: pendingQuestion(f).request.id });
  expect(f.posts).toEqual([]);
  expect(f.requests.some(request => request.path.includes("askuser-skip"))).toBe(false);
});

it("explicitly reopening a collapsed card validates the current card and immediately restores its native permission", async () => {
  const f = await fixture(); f.comments[0].attachments = [attachment("reopen")]; f.documents.set("reopen", { ...card, answer_user_id: "me" }); await f.sync();
  const request = pendingQuestion(f).request;
  await (await f.connect()).send({ type: "session.permission", sessionId: f.agents[1].id, permissionId: request.id, response: { behavior: "deny", message: "Dismissed" } });
  const action = defineRpc({ name: "askuser.reopen", input: z.any(), output: z.any() });
  const result = await f.server.rpc(action, { ...f.address(), commentId: "root", attachmentId: "reopen" }, f.paseo);
  expect(result).toMatchObject({ status: "pending", collapsed: false, readOnly: false });
  expect(f.events.filter(event => event.type === "session.permission").map(event => event.request.id)).toEqual([request.id, request.id]);
  f.timeline.push({ id: "web-answer", type: "comment", parent_id: "root", content: "**确认结果**\n\n1. **理由**：网页回答", actor_type: "member", actor_id: "me" });
  await expect(f.server.rpc(action, { ...f.address(), commentId: "root", attachmentId: "reopen" }, f.paseo)).rejects.toThrow("解决");
  expect(f.cards()[0].data.status).toBe("answered");
  expect(f.posts).toEqual([]);
});

const skipCard = defineRpc({ name: "askuser.skip", input: z.any(), output: z.any() });
it("explicit remote skip updates the stable card, persists skipped state and resolves its native permission without inventing a timestamp", async () => {
  const f = await fixture(); f.comments.push(comment("child", "root", [attachment("skip")])); f.documents.set("skip", card); await f.sync();
  const id = f.cards()[0].id;
  const result = await f.server.rpc(skipCard, { ...f.address(), commentId: "child", attachmentId: "skip", confirmed: true }, f.paseo);
  expect(result).toMatchObject({ status: "skipped", readOnly: true });
  expect(result.skippedAt).toBeUndefined(); expect(result.skippedBy).toBeUndefined();
  expect(f.skips).toEqual(["/api/issues/issue/comments/child/askuser-skip"]); expect(f.posts).toEqual([]);
  expect(f.cards()).toHaveLength(1); expect(f.cards()[0]).toMatchObject({ id, data: { status: "skipped" } });
  expect(f.events).toContainEqual({ type: "session.permission_resolved", sessionId: f.agents[1].id, permissionId: "multica:askuser:child:skip" });
  await f.dispose(); await f.disconnect(); f.events.length = 0; f.start(); await f.open("skip");
  expect(f.cards()[0].data.status).toBe("skipped"); expect(f.events.some(event => event.type === "session.permission")).toBe(false);
});

it("coalesces concurrent skip decisions and prevents answering or reopening the same card during skip", async () => {
  const f = await fixture(); f.comments[0].attachments = [attachment("race-skip")]; f.documents.set("race-skip", card); await f.sync();
  const target = { ...f.address(), commentId: "root", attachmentId: "race-skip", confirmed: true };
  let entered!: () => void; let release!: () => void;
  const arrived = new Promise<void>(resolve => { entered = resolve; }); const blocked = new Promise<void>(resolve => { release = resolve; });
  f.remote.beforeSkip = async () => { entered(); await blocked; };
  const first = f.server.rpc(skipCard, target, f.paseo); await arrived;
  const second = f.server.rpc(skipCard, target, f.paseo);
  try {
    await expect(answer(f, ["并发回答"])).rejects.toThrow("处理中");
    await expect(f.server.rpc(defineRpc({ name: "askuser.reopen", input: z.any(), output: z.any() }), target, f.paseo)).rejects.toThrow("处理中");
  } finally { release(); await Promise.allSettled([first, second]); }
  expect(await first).toMatchObject({ status: "skipped" }); expect(await second).toMatchObject({ status: "skipped" });
  expect(f.skips).toHaveLength(1); expect(f.posts).toHaveLength(0);
});

it("refuses to reopen or skip a card whose source was deleted remotely before preflight", async () => {
  const f = await fixture(); f.comments[0].attachments = [attachment("deleted-action")]; f.documents.set("deleted-action", card); await f.sync();
  f.timeline.push({ id: "root", type: "comment", deleted_at: stamp });
  const target = { ...f.address(), commentId: "root", attachmentId: "deleted-action", confirmed: true };
  await expect(f.server.rpc(skipCard, target, f.paseo)).rejects.toThrow("删除");
  await expect(f.server.rpc(defineRpc({ name: "askuser.reopen", input: z.any(), output: z.any() }), target, f.paseo)).rejects.toThrow("删除");
  expect(f.skips).toEqual([]); expect(f.posts).toEqual([]);
});

it.each([403, 503, "network"])("reports %s skip failure without claiming a terminal state or resolving the native form", async failure => {
  const f = await fixture(); f.comments[0].attachments = [attachment("failed-skip")]; f.documents.set("failed-skip", card); await f.sync();
  if (failure === "network") f.remote.loseSkipResponse = true; else f.remote.skipStatus = failure as number;
  const target = { ...f.address(), commentId: "root", attachmentId: "failed-skip", confirmed: true };
  await expect(f.server.rpc(skipCard, target, f.paseo)).rejects.toThrow(failure === "network" ? "未确认" : `HTTP ${failure}`);
  expect(f.cards()[0].data).toMatchObject({ status: "pending", readOnly: false });
  expect(f.events.some(event => event.type === "session.permission_resolved")).toBe(false);
  expect(f.skips).toHaveLength(1); expect(f.posts).toHaveLength(0);
});

it.each(["designated user", "different account", "logged out", "inaccessible", "hidden", "unconfirmed"])("rejects reopen and skip for %s before any remote POST", async reason => {
  const f = await fixture(); f.comments[0].attachments = [attachment("action-auth")]; f.documents.set("action-auth", { ...card, ...(reason === "designated user" ? { answer_user_id: "other" } : {}) }); await f.sync();
  if (reason === "different account") f.remote.userId = "other";
  if (reason === "logged out") await writeFile(f.configPath, "{}");
  if (reason === "inaccessible") f.remote.issueStatus = 403;
  if (reason === "hidden") await f.server.hook("agent.archive.after", { agent: { ...f.agents[1], provider: "multica" } } as never, f.paseo);
  const target = { ...f.address(), commentId: "root", attachmentId: "action-auth", confirmed: reason !== "unconfirmed" };
  await expect(f.server.rpc(skipCard, target, f.paseo)).rejects.toThrow();
  if (reason !== "unconfirmed") await expect(f.server.rpc(defineRpc({ name: "askuser.reopen", input: z.any(), output: z.any() }), target, f.paseo)).rejects.toThrow();
  expect(f.skips).toEqual([]); expect(f.posts).toEqual([]);
});

it("honors the original Stop fence when a skip preflight is waiting on remote access verification", async () => {
  const f = await fixture(); f.comments[0].attachments = [attachment("stopped-skip")]; f.documents.set("stopped-skip", card); await f.sync();
  let entered!: () => void; let release!: () => void;
  const arrived = new Promise<void>(resolve => { entered = resolve; }); const blocked = new Promise<void>(resolve => { release = resolve; });
  f.remote.beforeIssueCheck = async () => { entered(); await blocked; };
  const action = f.server.rpc(skipCard, { ...f.address(), commentId: "root", attachmentId: "stopped-skip", confirmed: true }, f.paseo);
  const settled = action.then(value => ({ value }), error => ({ error }));
  await arrived;
  await (await f.connect()).send({ type: "session.interrupt", requestId: "stop-skip", sessionId: f.agents[1].id });
  release();
  expect(await settled).toMatchObject({ error: expect.objectContaining({ message: "Delivery was stopped" }) });
  expect(f.skips).toEqual([]); expect(f.posts).toEqual([]);
});

it.each([200, 202, 204])("reads skip timestamp and operator only from confirmed timeline metadata after HTTP %s", async status => {
  const f = await fixture(); f.comments[0].attachments = [attachment("skip-metadata")]; f.documents.set("skip-metadata", card); await f.sync();
  f.remote.skipStatus = status;
  f.remote.beforeSkip = async () => { f.timeline.push({ id: "root", type: "comment", askuser_skipped_at: "2026-11-25T08:30:00Z", askuser_skipped_by: "remote-operator" }); };
  const result = await f.server.rpc(skipCard, { ...f.address(), commentId: "root", attachmentId: "skip-metadata", confirmed: true }, f.paseo);
  expect(result).toMatchObject({ status: "skipped", skippedAt: "2026-11-25T08:30:00Z", skippedBy: "remote-operator" });
});

it("does not confuse HTTP 202 acceptance with a confirmed remote skip", async () => {
  const f = await fixture(); f.comments[0].attachments = [attachment("accepted-skip")]; f.documents.set("accepted-skip", card); await f.sync(); f.remote.skipStatus = 202;
  await expect(f.server.rpc(skipCard, { ...f.address(), commentId: "root", attachmentId: "accepted-skip", confirmed: true }, f.paseo)).rejects.toThrow("未确认");
  expect(f.cards()[0].data.status).toBe("pending");
  expect(f.events.some(event => event.type === "session.permission_resolved")).toBe(false);
});

it("submits a child card once in canonical Chinese format, keeping its Thread root as ownership and deduplicating its saved echo", async () => {
  const f = await fixture(); f.comments.push(comment("child", "root", [attachment("submit")]));
  f.documents.set("submit", { ...card, questions: [
    ...mixedQuestions.slice(0, 3),
    { id: "checks", title: "检查", type: "multiple", options: [{ id: "a", label: "A" }, { id: "comma", label: "A, B" }, { id: "z", label: "Z" }], other: { enabled: true } },
    { id: "multi", title: "多行", type: "text" },
  ] }); await f.sync();
  await Promise.all([answer(f, ["灰度", "", "", "Z, A, B,  自定义, 含逗号  ", "第一行\n\n第三行"]), answer(f, ["灰度", "", "", "Z, A, B,  自定义, 含逗号  ", "第一行\n\n第三行"])]);
  expect(f.posts).toHaveLength(1);
  expect(f.posts[0].body).toEqual({ content: "**确认结果**\n\n1. **发布范围**：灰度\n2. **说明**：\n3. **备注**：\n4. **检查**：A, B、Z、自定义, 含逗号\n5. **多行**：第一行\n>\n> 第三行", type: "comment", parent_id: "child", askuser_answer_to: "child" });
  expect((await f.server.rpc(deliveryList, {}, f.paseo)).records[0]).toMatchObject({ rootId: "root", parentCommentId: "child", askuserAnswerTo: "child", status: "saved" });
  expect(f.events).toContainEqual({ type: "session.permission_resolved", sessionId: f.agents[1].id, permissionId: "multica:askuser:child:submit" });
  expect(f.cards()[0].data).toMatchObject({ status: "answered", answer: { content: f.posts[0].body.content } });
  await f.server.rpc(threadOpen, f.address(), f.paseo); await f.sync();
  const originals = f.events.filter(event => event.type === "timeline.item" && event.item.type === "user_message" && event.item.text === f.posts[0].body.content);
  expect(originals).toHaveLength(1);
});

it("keeps native answers on conditional validation and deterministic rejection, allowing a corrected explicit attempt", async () => {
  const f = await fixture(); f.comments[0].attachments = [attachment("conditions")];
  f.documents.set("conditions", { ...card, questions: mixedQuestions.slice(0, 3) }); await f.sync();
  await expect(answer(f, ["全量", "", ""])).rejects.toThrow("说明");
  await expect(answer(f, ["其他自定义", "", ""])).rejects.toThrow("说明");
  expect(f.posts).toHaveLength(0);
  expect(f.events.filter(event => event.type === "session.permission_resolved")).toHaveLength(0);
  f.remote.postStatus = 403;
  await expect(answer(f, ["全量", "已确认", ""])).rejects.toThrow("HTTP 403");
  expect(f.events.filter(event => event.type === "session.permission_resolved")).toHaveLength(0);
  f.remote.postStatus = 200;
  await answer(f, ["全量（补充：  明天  ）", "修正后的确认", ""]);
  expect(f.posts).toHaveLength(2); expect(f.posts[0].key).not.toBe(f.posts[1].key);
  expect(f.posts[1].body.content).toBe("**确认结果**\n\n1. **发布范围**：全量（补充：明天）\n2. **说明**：修正后的确认\n3. **备注**：");
  expect(f.events.filter(event => event.type === "session.permission_resolved")).toHaveLength(1);
});

it.each(["lost response", "server error"])("resolves native forms after %s and exposes durable verification status without repeated submits or restart replay", async failure => {
  const f = await fixture(); f.comments.push(comment("child", "root", [attachment("uncertain")])); f.documents.set("uncertain", card); await f.sync();
  f.remote.loseResponse = failure === "lost response"; f.remote.postStatus = failure === "server error" ? 503 : 200;
  await answer(f, ["已确认"]);
  expect(f.posts).toHaveLength(1);
  const record = (await f.server.rpc(deliveryList, {}, f.paseo)).records[0];
  expect(record).toMatchObject({ rootId: "root", parentCommentId: "child", askuserAnswerTo: "child", status: "pending_verification" });
  expect(f.events).toContainEqual({ type: "session.permission_resolved", sessionId: f.agents[1].id, permissionId: "multica:askuser:child:uncertain" });
  expect(f.cards()[0].data).toMatchObject({ status: "pending", readOnly: true, delivery: { status: "pending_verification", clientMessageId: record.clientMessageId, message: expect.stringContaining("核实") } });
  await expect(answer(f, ["重复点击"])).rejects.toThrow(); expect(f.posts).toHaveLength(1);
  await f.dispose(); await f.disconnect(); f.events.length = 0; const restarted = f.start(); await f.open("skip");
  expect(f.events.some(event => event.type === "session.permission")).toBe(false);
  if (failure === "lost response") {
    // Older receipts may omit askuser_answer_to; an omitted field does not disprove the saved answer.
    delete f.receipts.get(record.idempotencyKey)!.askuser_answer_to;
    expect(await restarted.server.rpc(deliveryVerify, record, f.paseo)).toMatchObject({ status: "saved" });
    expect(f.requests.some(request => request.path.includes("/comments/idempotent?type=comment&parent_id=child&askuser_answer_to=child"))).toBe(true);
    expect(f.posts).toHaveLength(1);
  }
});

it("retains child targets through seven-day receipt verification and explicit resend, rejecting conflicting echoed answer targets", async () => {
  const f = await fixture(); f.comments.push(comment("child", "root", [attachment("resend")])); f.documents.set("resend", card); await f.sync();
  f.remote.postStatus = 503; await answer(f, ["保留原回答"]);
  const original = (await f.server.rpc(deliveryList, {}, f.paseo)).records[0];
  f.setClock(new Date("2026-12-01T10:00:00Z"));
  expect(await f.server.rpc(deliveryVerify, original, f.paseo)).toMatchObject({ status: "pending_verification", message: expect.stringContaining("7 天") });
  await f.sync(); expect(f.posts).toHaveLength(1);
  f.remote.postStatus = 200;
  const decision = { ...original, requestId: "explicit-resend", acknowledgeDuplicateRisk: true as const };
  const resent = await f.server.rpc(deliveryResend, decision, f.paseo);
  expect(await f.server.rpc(deliveryResend, decision, f.paseo)).toEqual(resent);
  await expect.poll(async () => (await f.server.rpc(deliveryList, {}, f.paseo)).records.find(record => record.clientMessageId === resent.clientMessageId)?.status).toBe("saved");
  expect(f.posts).toHaveLength(2); expect(f.posts[1].body).toEqual(f.posts[0].body); expect(f.posts[1].key).not.toBe(original.idempotencyKey);
  const record = (await f.server.rpc(deliveryList, {}, f.paseo)).records[1];
  expect(record).toMatchObject({ rootId: "root", parentCommentId: "child", askuserAnswerTo: "child", retryOf: original.idempotencyKey });
  // A present but incorrect marker is evidence of a conflicting receipt, unlike an omitted marker.
  f.receipts.set(original.idempotencyKey, { ...f.receipts.get(record.idempotencyKey)!, askuser_answer_to: "another-card" });
  expect(await f.server.rpc(deliveryVerify, original, f.paseo)).toMatchObject({ status: "pending_verification" });
  expect(f.posts).toHaveLength(2);
  expect(f.requests.filter(request => request.path.includes("comments/idempotent")).every(request => request.path.includes("parent_id=child") && request.path.includes("askuser_answer_to=child"))).toBe(true);
});

it("maps complete native questionnaires even when the timeline card must be bounded", async () => {
  const f = await fixture(); f.comments[0].attachments = [attachment("bounded")];
  f.documents.set("bounded", { ...card, description: "警示".repeat(9000), questions: Array.from({ length: 6 }, (_, i) => ({ id: `q-${i}`, type: "text", title: "同名问题" })) }); await f.sync();
  expect(f.cards()[0].data).toMatchObject({ truncated: true, questions: expect.any(Array) });
  expect(f.cards()[0].data.questions).toHaveLength(3);
  const questions = pendingQuestion(f).request.input!.questions as Array<{ header: string }>;
  expect(questions).toHaveLength(6); expect(new Set(questions.map(q => q.header)).size).toBe(6);
  await answer(f, ["一", "二", "三", "四", "五", "六"]);
  expect(f.posts[0].body.content).toContain("6. **同名问题**：六");
});

it("reuses the child answer's immutable key for a receipt-proven retry inside seven days", async () => {
  const f = await fixture(); f.comments[0].attachments = [attachment("anchor")]; f.documents.set("anchor", card); await f.sync(); await answer(f, ["已保存的能力证明"]);
  f.comments.push(comment("child", "root", [attachment("retry")])); f.documents.set("retry", card); await f.sync();
  f.remote.postStatus = 503; await answer(f, ["需要安全恢复的回答"], "multica:askuser:child:retry");
  expect(f.posts).toHaveLength(2);
  f.remote.postStatus = 200; await f.sync();
  expect(f.posts).toHaveLength(3); expect(f.posts[2]).toEqual(f.posts[1]);
  expect((await f.server.rpc(deliveryList, {}, f.paseo)).records[1]).toMatchObject({ rootId: "root", parentCommentId: "child", askuserAnswerTo: "child", status: "saved" });
  expect(f.cards()[1].data).toMatchObject({ status: "answered", readOnly: true });
  expect(f.events.filter(event => event.type === "session.permission" && event.request.id === "multica:askuser:child:retry")).toHaveLength(1);
});

it("clears a retained form when an explicit answer resend becomes uncertain, without waiting for periodic synchronization", async () => {
  const f = await fixture(); f.comments[0].attachments = [attachment("resend-uncertain")]; f.documents.set("resend-uncertain", card); await f.sync();
  f.remote.postStatus = 403; await expect(answer(f, ["原回答"])).rejects.toThrow();
  expect(f.events.filter(event => event.type === "session.permission_resolved")).toHaveLength(0);
  const original = (await f.server.rpc(deliveryList, {}, f.paseo)).records[0];
  f.remote.postStatus = 503;
  await f.server.rpc(deliveryResend, { ...original, requestId: "uncertain-explicit", acknowledgeDuplicateRisk: true }, f.paseo);
  await expect.poll(() => f.events.filter(event => event.type === "session.permission_resolved")).toHaveLength(1);
  expect(f.cards()[0].data).toMatchObject({ delivery: { status: "pending_verification" }, readOnly: true });
});
