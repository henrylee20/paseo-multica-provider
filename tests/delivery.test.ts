import { createServer } from "node:http";
import { mkdtemp, mkdir, writeFile, readFile, rm, symlink, truncate } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import type { PaseoApi } from "@getpaseo/client";
import type { DaemonClient } from "@getpaseo/client/internal/daemon-client";
import type { ProviderConnection, ProviderEvent, ProviderPrompt } from "@getpaseo/plugin/server/provider";
import { workspaceEnable } from "../shared/contracts.js";
import { deliveryMentions } from "../shared/delivery.js";
import { threadOpen } from "../shared/threads.js";
import { createServerContribution } from "../server/contribute.js";
import { FakeServer, resync } from "./support/fake-server.js";

const cleanup: Array<() => void | Promise<void>> = [];
afterEach(async () => { for (const dispose of cleanup.splice(0).reverse()) await dispose(); });
const stamp = "2026-11-24T10:00:00Z";
type RemoteAttachment = { id: string; filename: string; content_type: string; size_bytes: number; url: string };
const comment = (id: string, parent_id: string | null, content: string, attachments: RemoteAttachment[] = []) => ({ id, parent_id, content, author_id: "me", author_type: "member", issue_id: "issue", type: "comment", created_at: stamp, updated_at: stamp, attachments });
async function fixture(active = false, idempotent = false) {
  const home = await mkdtemp(join(tmpdir(), "multica-delivery-"));
  cleanup.push(() => rm(home, { recursive: true, force: true }));
  const comments = [comment("root", null, "Existing root")];
  const runs = active ? [{ id: "run", issue_id: "issue", agent_id: "agent", status: "running", trigger_comment_id: "root" }] : [];
  const requests: string[] = [];
  const posts: Array<{ path: string; body: unknown; key?: string; slug?: string }> = [];
  const uploads: Array<{ name: string; mimeType: string; bytes: Buffer; issueId: FormDataEntryValue | null; slug?: string }> = [];
  const files = new Map<string, RemoteAttachment>();
  let upload: (file: RemoteAttachment) => Promise<{ status?: number; body?: unknown; disconnect?: boolean }> = async file => ({ body: file });
  const receipts = new Map<string, ReturnType<typeof comment>>();
  const lookups: string[] = [];
  const deletedReceipts = new Set<string>();
  let lookupFailure: number | undefined;
  let clock = new Date("2026-11-24T10:00:00Z");
  let beforeLookup: ((key: string) => Promise<void>) | undefined;
  let identity = "me";
  let beforeMe: (() => Promise<void>) | undefined;
  let post: (body: { content: string; parent_id?: string; attachment_ids?: string[] }) => Promise<{ status?: number; body?: unknown; disconnect?: boolean }> = async body => {
    const saved = comment(`saved-${posts.length}`, body.parent_id ?? null, body.content, body.attachment_ids?.map(id => files.get(id)!) ?? []); comments.push(saved); return { body: saved };
  };
  const http = createServer(async (request, response) => {
    response.setHeader("Content-Type", "application/json");
    const url = new URL(request.url!, "http://localhost");
    requests.push(url.pathname);
    let body: unknown;
    if (url.pathname === "/api/upload-file") {
      const chunks: Buffer[] = []; for await (const chunk of request) chunks.push(Buffer.from(chunk));
      const form = await new Response(Buffer.concat(chunks), { headers: { "Content-Type": request.headers["content-type"]! } }).formData() as unknown as { get(name: string): FormDataEntryValue | null };
      const file = form.get("file") as File;
      uploads.push({ name: file.name, mimeType: file.type, bytes: Buffer.from(await file.arrayBuffer()), issueId: form.get("issue_id"), slug: request.headers["x-workspace-slug"] as string });
      const id = `00000000-0000-4000-8000-${String(uploads.length).padStart(12, "0")}`;
      const attachment = { id, filename: file.name, content_type: file.type, size_bytes: file.size, url: `/api/attachments/${id}/download` };
      files.set(id, attachment);
      const result = await upload(attachment);
      if (result.disconnect) { response.destroy(); return; }
      response.statusCode = result.status ?? 200; response.end(JSON.stringify(result.body ?? {})); return;
    }
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
    else if (url.pathname === "/api/issues")
      body = { issues: [{ id: "issue", workspace_id: "workspace", title: "Task", description: "Description", status: "todo" }], total: 1 };
    else if (url.pathname === "/api/issues/issue/task-runs") body = runs;
    else if (url.pathname === "/api/issues/issue/comments/idempotent" && idempotent) {
      const key = request.headers["idempotency-key"] as string; lookups.push(key); await beforeLookup?.(key);
      const receipt = receipts.get(key);
      if (lookupFailure) { response.statusCode = lookupFailure; body = {}; }
      else if (deletedReceipts.has(key)) { response.statusCode = 409; body = { error: "the comment created with this Idempotency-Key has been deleted" }; }
      else if (receipt) { response.setHeader("Idempotent-Replayed", "true"); body = receipt; }
      else { response.statusCode = 404; body = { error: "no comment has been posted with this Idempotency-Key" }; }
    }
    else if (url.pathname === "/api/issues/issue/comments")
      body = url.searchParams.has("thread") ? comments.filter(c => c.id === url.searchParams.get("thread") || c.parent_id === url.searchParams.get("thread")) : comments;
    else if (url.pathname === "/api/agents")
      body = [{ id: "12345678-1234-4234-9234-123456789abc", name: "Agent [A]" }, { id: "22345678-1234-4234-9234-123456789abc", name: "Agent [A]" }, { id: "32345678-1234-4234-9234-123456789abc", name: "Archived agent", archived_at: stamp }];
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
    provider = await server.providers.get("multica")!.connect({ versions: [1], capabilities: ["session.persistence", "prompt.message", "prompt.image", "prompt.steer", "timeline.plugin"] });
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
      const agent = { id: `native-${agents.length}`, workspaceId: input.workspaceId, cwd: input.cwd, labels: input.labels, handle: input.providerHandleId };
      agents.push(agent);
      await (await connect()).send({ type: "session.open", requestId: agent.id, sessionId: agent.id, history: "replay", persistence: JSON.parse(agent.handle.slice(7)), config: { cwd: agent.cwd, env: {}, mcpServers: {}, settings: {}, persist: true } });
      return agent;
    }, updateAgent: async () => {}, close: async () => {},
  } as unknown as DaemonClient;
  const paseo = { hosts: { list: async () => ({ self: { serverId: "daemon" } }) } } as unknown as PaseoApi;
  const start = () => {
    provider = undefined;
    server = new FakeServer();
    const dispose = createServerContribution({ homeDirectory: home, workingDirectory: home, environment: { PASEO_HOME: home }, connectHost: async () => host })(server.context);
    cleanup.push(dispose);
    return { server, dispose };
  };
  const started = start(); cleanup.push(async () => { await provider?.close(); });
  await server!.syncRpc(workspaceEnable, { workspaceId: "workspace", enabled: true }, paseo);
  const send = async (rootId: string, text: string, clientMessageId: string, delivery: "auto" | "steer" = "auto", attachments: Array<Extract<ProviderPrompt["input"], { type: "message" }>["content"][number]> = []) => {
    const agent = agents.find(agent => agent.labels["multica.discussion"] === rootId)!;
    await (await connect()).send({ type: "session.prompt", sessionId: agent.id, prompt: { clientMessageId, delivery, input: { type: "message", content: [{ type: "text", text }, ...attachments] } } });
  };
  const file = async (name = "notes.txt", content = "file bytes", mimeType = "text/plain") => {
    const directory = join(home, "uploads", "file"); await mkdir(directory, { recursive: true });
    const path = join(directory, name); await writeFile(path, content);
    return { type: "uploaded_file" as const, id: "file", path, fileName: name, mimeType, size: Buffer.byteLength(content) };
  };
  return { ...started, home, paseo, agents, events, canonical, nativeHistory, comments, runs, posts, uploads, files, file, upload: (handler: typeof upload) => { upload = handler; }, requests, lookups, receipts, deletedReceipts, connect, send, start, lookupFailure: (status?: number) => {
    lookupFailure = status;
  }, advance: (milliseconds: number) => {
    clock = new Date(clock.getTime() + milliseconds);
  }, beforeLookup: (handler: typeof beforeLookup) => {
    beforeLookup = handler;
  }, identity: async (id: string) => {
    identity = id;
    await writeFile(join(home, ".multica/config.json"), JSON.stringify({ server_url: `http://127.0.0.1:${(http.address() as { port: number }).port}`, token: `synthetic-${id}` }));
  }, beforeMe: (handler?: () => Promise<void>) => {
    beforeMe = handler;
  }, post: (handler: typeof post) => {
    post = handler;
  } };
}

it("main input creates an ordinary Thread and shows only its brief success hint", async () => {
  const f = await fixture();
  await f.send("main", "Hello", "input-main");
  await expect.poll(() => f.agents.length).toBe(3);
  expect(f.posts).toEqual([{ path: "/api/issues/issue/comments", body: { content: "Hello", type: "comment" }, key: expect.any(String), slug: "product" }]);
  expect(f.events).toContainEqual(expect.objectContaining({ type: "timeline.item", sessionId: f.agents[0].id, item: expect.objectContaining({ kind: "comment-delivery" }) }));
  expect(f.events.some(event => event.type === "session.turn")).toBe(false);
});

it("re-emits the same delivery ID once its Thread title is discovered and deduplicates unchanged content", async () => {
  const f = await fixture();
  const saved = comment("late-title", null, "稍后发现的标题");
  f.post(async () => ({ body: saved }));
  await f.send("main", saved.content, "late-title-input");
  const rows = () => f.events.flatMap(event => event.type === "timeline.item" && event.item.type === "plugin" && event.item.id === "multica:thread-created:late-title-input" ? [event.item] : []);
  await expect.poll(() => rows().length).toBe(1);
  expect(rows()[0]).toMatchObject({ version: 1, data: {} });
  f.comments.push(saved);
  await resync(f.server, f.paseo, "workspace");
  expect(rows()).toHaveLength(2);
  expect(rows()[1]).toMatchObject({ id: rows()[0].id, version: 1, data: { threadTitle: "稍后发现的标题" } });
  await resync(f.server, f.paseo, "workspace");
  expect(rows()).toHaveLength(2);
  expect(f.canonical.get(f.agents[0].id)!.filter(row => row.item.id === rows()[0].id)).toHaveLength(1);
});

const image = { type: "image" as const, data: Buffer.from("image bytes").toString("base64"), mimeType: "image/png" };
const sendErrors = (f: Awaited<ReturnType<typeof fixture>>) => f.events.filter(event => event.type === "timeline.item" && event.item.type === "error");

it.each(["main", "root"])("sends images and files with unchanged text from %s and restores one attachment row without replaying native input", async root => {
  const f = await fixture();
  const file = await f.file("方案.pdf", "PDF data", "application/pdf");
  if (root === "root") await f.server.rpc(threadOpen, JSON.parse(f.agents.find(agent => agent.labels["multica.discussion"] === root)!.handle.slice(7)).data, f.paseo);
  expect((await f.connect()).capabilities).toContain("prompt.image");
  const timeouts = vi.spyOn(AbortSignal, "timeout");
  try {
    await f.send(root, "  Original body\n", "with-files", "auto", [image, file]);
    await expect.poll(() => f.posts.length).toBe(1);
    await resync(f.server, f.paseo, "workspace");
    await f.dispose();
    expect(timeouts.mock.calls.some(([ms]) => ms === 120_000)).toBe(true);
    expect(timeouts.mock.calls.some(([ms]) => ms === 10_000)).toBe(true);
  } finally { timeouts.mockRestore(); }
  expect(f.uploads.map(({ name, mimeType, issueId, slug }) => ({ name, mimeType, issueId, slug }))).toEqual([
    { name: "image-1.png", mimeType: "image/png", issueId: "issue", slug: "product" },
    { name: "方案.pdf", mimeType: "application/pdf", issueId: "issue", slug: "product" },
  ]);
  expect(f.uploads.map(file => file.bytes.toString())).toEqual(["image bytes", "PDF data"]);
  expect(f.posts[0]).toMatchObject({ body: { content: "  Original body\n", attachment_ids: [...f.files.keys()], ...(root === "root" ? { parent_id: root } : {}) } });
  const agent = f.agents.find(agent => agent.labels["multica.discussion"] === root)!;
  const id = root === "main" ? "multica:thread-created:with-files" : "multica:comment-attachments:with-files";
  const attachments = f.canonical.get(agent.id)!.filter(row => row.item.id === id);
  expect(attachments).toHaveLength(1);
  expect(attachments[0].item).toMatchObject({ kind: "comment-delivery", version: 1, data: { threadCreated: root === "main", attachments: [
    { name: "image-1.png", mimeType: "image/png", size: 11 }, { name: "方案.pdf", mimeType: "application/pdf", size: 8 },
  ] } });
  // Recover a plugin row lost after the receipt was persisted, including offline.
  f.canonical.set(agent.id, f.canonical.get(agent.id)!.filter(row => row.item.id !== id));
  const restarted = f.start();
  await (await f.connect()).send({ type: "session.open", requestId: "restore-files", sessionId: agent.id, history: "skip", persistence: JSON.parse(agent.handle.slice(7)), config: { cwd: agent.cwd, env: {}, mcpServers: {}, settings: {}, persist: true } });
  await resync(restarted.server, f.paseo, "workspace");
  expect(f.canonical.get(agent.id)!.filter(row => row.item.id === id)).toHaveLength(1);
  expect(f.canonical.get(agent.id)!.filter(row => row.item.clientMessageId === "with-files")).toMatchObject([{ item: { text: "  Original body\n" } }]);
  expect(sendErrors(f)).toEqual([]);
  expect(f.uploads).toHaveLength(2); expect(f.posts).toHaveLength(1);
});

it.each(["empty-body", "count", "base64", "mime", "outside", "symlink", "oversize", "missing"])("rejects %s before admission and before uploading any attachment", async kind => {
  const f = await fixture();
  const file = await f.file();
  let attachments = [image, file] as Array<Extract<ProviderPrompt["input"], { type: "message" }>["content"][number]>;
  if (kind === "count") attachments = Array.from({ length: 11 }, () => image);
  if (kind === "base64") attachments = [{ ...image, data: "not base64!" }];
  if (kind === "mime") attachments = [{ ...image, mimeType: " " }];
  if (kind === "outside") attachments = [{ ...file, path: join(f.home, ".multica/config.json") }];
  if (kind === "symlink") { const path = join(f.home, "uploads", "escape"); await symlink(join(f.home, ".multica/config.json"), path); attachments = [{ ...file, path }]; }
  if (kind === "oversize") await truncate(file.path, 50 * 1024 * 1024 + 1);
  if (kind === "missing") await rm(file.path);
  await f.send("root", kind === "empty-body" ? " " : "text", "invalid-file", "auto", attachments);
  expect(f.events).toContainEqual(expect.objectContaining({ type: "session.prompt_result", clientMessageId: "invalid-file", result: expect.objectContaining({ type: "failed" }) }));
  expect(f.uploads).toEqual([]); expect(f.posts).toEqual([]);
  if (kind === "empty-body") expect(JSON.stringify(f.events)).toContain("请输入评论正文后再发送附件。");
});

it.each(["403", "503", "network", "empty-id", "invalid-id"])("a partial %s upload failure never posts a comment or automatically uploads again", async kind => {
  const f = await fixture();
  f.upload(async file => f.uploads.length === 1 ? { body: file } : kind === "network" ? { disconnect: true }
    : kind === "empty-id" || kind === "invalid-id" ? { body: { ...file, id: kind === "empty-id" ? "" : "invalid" } } : { status: Number(kind) });
  await f.send("root", "with files", "failed-upload", "auto", [image, image]);
  await expect.poll(() => sendErrors(f).length).toBe(1);
  await f.send("root", "with files", "failed-upload", "auto", [image, image]);
  await expect.poll(() => sendErrors(f).length).toBe(2);
  expect(f.uploads).toHaveLength(2); expect(f.posts).toEqual([]);
  const reason = kind === "403" ? "HTTP 403（无权限）" : kind === "503" ? "HTTP 503" : kind === "network" ? "网络错误或上传超时" : kind === "empty-id" ? "响应附件 ID 为空" : "上传响应无效";
  expect(sendErrors(f)).toMatchObject([{ item: { message: `附件「image-2.png」上传失败：${reason}。评论未发送。已上传的 1 个附件未关联评论，可能成为孤立附件，请在 Multica 核对。` } }, expect.anything()]);
  expect(await readFile(join(f.home, "multica-provider/state.json"), "utf8")).not.toContain("failed-upload");
});

it("reports the first failed attachment and HTTP reason without claiming previously uploaded orphan attachments", async () => {
  const f = await fixture();
  f.upload(async () => ({ status: 413, body: { error: "synthetic-private-response" } }));
  await f.send("root", "with files", "first-upload-failure", "auto", [image, image]);
  await expect.poll(() => sendErrors(f).length).toBe(1);
  expect(sendErrors(f)).toMatchObject([{ item: { message: "附件「image-1.png」上传失败：HTTP 413（超出服务端大小限制）。评论未发送，可重新发送。" } }]);
  expect(JSON.stringify(sendErrors(f))).not.toContain("孤立附件");
  expect(JSON.stringify(sendErrors(f))).not.toContain("synthetic-private-response");
  expect(f.uploads).toHaveLength(1); expect(f.posts).toEqual([]);
});

it.each(["network", "503", "409", "receipt"])("attachment comment %s keeps a fixed payload and never reuploads", async kind => {
  const f = await fixture(false, true);
  f.post(async body => {
    const saved = comment("attached-receipt", "root", body.content, kind === "receipt" ? [] : [...f.files.values()]);
    if (kind === "network") { f.comments.push(saved); return { body: saved, disconnect: true }; }
    if (kind === "503" && f.posts.length === 1) return { status: 503 };
    if (kind === "409") return { status: 409, body: { error: "attachment is no longer available" } };
    return { body: saved };
  });
  await f.send("root", "attachments", "retry-attached", "auto", [image]);
  await expect.poll(() => kind === "409" || kind === "receipt" ? sendErrors(f).length : f.posts.length).toBe(kind === "409" || kind === "receipt" ? 1 : 2);
  await f.dispose();
  expect(f.uploads).toHaveLength(1);
  if (kind === "network" || kind === "503") expect(f.posts[1]).toEqual(f.posts[0]);
  else expect(f.events.some(event => event.type === "timeline.item" && event.item.type === "plugin" && event.item.kind === "comment-delivery")).toBe(false);
});

it("an identity switch between uploads stops the old delivery without a comment or Run interruption", async () => {
  const f = await fixture(true);
  f.upload(async file => { await f.identity("another-user"); return { body: file }; });
  await f.send("root", "still running", "switch-during-upload", "steer", [image, image]);
  await expect.poll(() => sendErrors(f).length).toBe(1);
  expect(f.uploads).toHaveLength(1); expect(f.posts).toEqual([]);
  expect(f.runs[0].status).toBe("running");
  expect(sendErrors(f)).toMatchObject([{ item: { message: "CLI 登录上下文已变化；请重新核对此输入所属的连接。" } }]);
  expect(f.events).toContainEqual(expect.objectContaining({ type: "session.prompt_result", clientMessageId: "switch-during-upload", result: expect.objectContaining({ type: "steer" }) }));
});

it("unknown image MIME types use a generic extension and reject changed duplicate input", async () => {
  const f = await fixture();
  const arbitrary = { ...image, mimeType: "image/new-format" };
  await f.send("root", "original", "same-attachment-input", "auto", [arbitrary]);
  await expect.poll(() => f.posts.length).toBe(1);
  await f.send("root", "changed", "same-attachment-input", "auto", [arbitrary]);
  await expect.poll(() => sendErrors(f).length).toBe(1);
  expect(f.uploads[0].name).toBe("image-1.bin"); expect(f.uploads).toHaveLength(1); expect(f.posts).toHaveLength(1);
});

it.each([["image/jpeg", "jpg"], ["image/gif", "gif"], ["image/webp", "webp"]])("names %s images with the %s extension", async (mimeType, extension) => {
  const f = await fixture();
  await f.send("root", "image", "image-type", "auto", [{ ...image, mimeType }]);
  await expect.poll(() => f.posts.length).toBe(1);
  expect(f.uploads[0].name).toBe(`image-1.${extension}`);
});

it("uses actual file size and reads each file only at its upload turn, rejecting a later path replacement", async () => {
  const f = await fixture();
  const file = await f.file();
  const admission: number[] = [];
  (await f.connect()).onEvent(event => { if (event.type === "session.prompt_result" && event.clientMessageId === "sequential") admission.push(f.uploads.length); });
  f.upload(async uploaded => {
    await rm(file.path); await symlink(join(f.home, ".multica/config.json"), file.path);
    return { body: uploaded };
  });
  await f.send("root", "files", "sequential", "auto", [image, { ...file, size: 100 * 1024 * 1024 }]);
  await expect.poll(() => sendErrors(f).length).toBe(1);
  expect(admission).toEqual([0]);
  expect(f.uploads).toHaveLength(1); expect(f.posts).toEqual([]);
});

it.each(["missing", "duplicate", "extra", "different"])("rejects a %s attachment set in a successful comment receipt", async kind => {
  const f = await fixture();
  f.post(async body => {
    const files = [...f.files.values()];
    const other = { ...files[0], id: "00000000-0000-4000-8000-999999999999" };
    const received = kind === "missing" ? files.slice(0, 1) : kind === "duplicate" ? [files[0], files[0]] : kind === "extra" ? [...files, other] : [files[0], other];
    return { body: comment("mismatch", "root", body.content, received) };
  });
  await f.send("root", "files", "mismatched-set", "auto", [image, image]);
  await expect.poll(() => sendErrors(f).length).toBe(1);
  expect(f.posts).toHaveLength(1);
  expect(await readFile(join(f.home, "multica-provider/state.json"), "utf8")).not.toContain("mismatched-set");
  expect(JSON.stringify(sendErrors(f))).toContain("评论可能已保存");
});

it("attachment recovery still rejects a native original with conflicting text", async () => {
  const f = await fixture();
  const agent = f.agents.find(agent => agent.labels["multica.discussion"] === "root")!;
  await f.server.rpc(threadOpen, JSON.parse(agent.handle.slice(7)).data, f.paseo);
  await f.send("root", "original text", "strict-attachment", "auto", [image]);
  await expect.poll(() => f.posts.length).toBe(1);
  await resync(f.server, f.paseo, "workspace");
  f.canonical.get(agent.id)!.find(row => row.item.clientMessageId === "strict-attachment")!.item.text = "conflicting native text";
  await f.dispose(); const restarted = f.start();
  const boundary = f.events.length;
  await (await f.connect()).send({ type: "session.open", requestId: "strict-restore", sessionId: agent.id, history: "skip", persistence: JSON.parse(agent.handle.slice(7)), config: { cwd: agent.cwd, env: {}, mcpServers: {}, settings: {}, persist: true } });
  expect(await resync(restarted.server, f.paseo, "workspace")).toMatchObject({ status: "unavailable" });
  expect(f.events.slice(boundary).some(event => event.type === "timeline.item" && event.item.type === "user_message")).toBe(false);
});

it("persists durable attachment links rather than expiring download capabilities", async () => {
  const f = await fixture();
  f.post(async body => ({ body: comment("durable", "root", body.content, [...f.files.values()].map(file => ({ ...file,
    markdown_url: "https://multica.example/api/attachments/durable/download", download_url: "https://storage.example/file?expires=60&signature=temporary",
  }))) }));
  await f.send("root", "file", "durable-link", "auto", [image]);
  await expect.poll(() => f.posts.length).toBe(1);
  await f.dispose();
  const persisted = await readFile(join(f.home, "multica-provider/state.json"), "utf8");
  expect(persisted).toContain("https://multica.example/api/attachments/durable/download");
  expect(persisted).not.toContain("signature=temporary");
});

it("replays a legacy main-discussion delivery hint under its original ID without duplicating the persisted row", async () => {
  const f = await fixture();
  f.post(async body => ({ body: comment("undiscovered-legacy", null, body.content) }));
  await f.send("main", "legacy text", "legacy-main");
  await expect.poll(() => f.posts.length).toBe(1);
  await f.dispose();
  f.start();
  const agent = f.agents.find(agent => agent.labels["multica.discussion"] === "main")!;
  await (await f.connect()).send({ type: "session.open", requestId: "legacy-restore", sessionId: agent.id, history: "skip", persistence: JSON.parse(agent.handle.slice(7)), config: { cwd: agent.cwd, env: {}, mcpServers: {}, settings: {}, persist: true } });
  const rows = f.canonical.get(agent.id)!.filter(row => row.item.kind === "comment-delivery");
  expect(rows).toMatchObject([{ item: { id: "multica:thread-created:legacy-main", version: 1, data: {} } }]);
  expect(rows).toHaveLength(1);
});

it("rejects unexpected attachments in a text-only comment receipt", async () => {
  const f = await fixture();
  f.post(async body => ({ body: comment("unexpected", "root", body.content, [{ id: "00000000-0000-4000-8000-000000000001", filename: "unexpected", content_type: "text/plain", size_bytes: 1, url: "/file" }]) }));
  await f.send("root", "text only", "unexpected-attachments");
  await expect.poll(() => sendErrors(f).length).toBe(1);
  expect(await readFile(join(f.home, "multica-provider/state.json"), "utf8")).not.toContain("unexpected-attachments");
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
  expect(f.events.filter(event => event.type === "timeline.item" && event.sessionId === thread.id && event.item.type === "plugin" && event.item.kind === "comment-divider").map(event => event.type === "timeline.item" ? event.item.id : "")).toEqual(["multica:divider:input:reply"]);
  expect(f.canonical.get(thread.id)?.find(entry => entry.item.clientMessageId === "reply")?.item.text).toBe("A reply");
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
  f.post(async body => {
    const saved = comment("racing", "root", body.content);
    f.comments.push(saved);
    await new Promise<void>(resolve => {
      release = resolve;
    });
    return { body: saved };
  });
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

it("leaves the first optimistic main input unseparated and divides the next input once", async () => {
  const f = await fixture();
  const main = f.agents.find(agent => agent.labels["multica.discussion"] === "main")!;
  const dividers = () => f.events.filter(event => event.type === "timeline.item" && event.sessionId === main.id && event.item.type === "plugin" && event.item.kind === "comment-divider");
  await f.send("main", "First input", "main-first");
  expect(dividers()).toEqual([]);
  await f.send("main", "Second input", "main-second");
  await expect.poll(() => f.posts.length).toBe(2);
  expect(dividers()).toMatchObject([{ item: { id: "multica:divider:input:main-second" } }]);
});
