import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { open, realpath, stat } from "node:fs/promises";
import { isAbsolute, relative, sep } from "node:path";
import { setTimeout } from "node:timers/promises";
import type { ProviderPrompt } from "@getpaseo/plugin/server/provider";
import { z } from "zod";
import { remoteFetch, type AuthenticatedConnection } from "./connection.js";
import type { RunAddress } from "./runs.js";
import { StateStore, cachedWorkspace } from "./state.js";
import { workspaceAgents } from "./multica-api.js";
import type { DiscussionLifecycle } from "./discussion-lifecycle.js";
import { assertAskuserWritable } from "./askuser-policy.js";
import { deliveredAttachment } from "../shared/delivery.js";

const remoteAttachment = z.object({ id: z.uuid(), filename: z.string().optional(), content_type: z.string().nullish(), size_bytes: z.number().int().nonnegative().nullish(), markdown_url: z.string().nullish() });
const receiptSchema = z.object({ id: z.string(), issue_id: z.string(), parent_id: z.string().nullish(), askuser_answer_to: z.string().nullish(), content: z.string(), author_id: z.string(), attachments: z.array(remoteAttachment).nullish() });
const maxFileSize = 50 * 1024 * 1024;
type Attachment = { name: string; mimeType: string; size: number } & ({ data: string } | { path: string });
const hash = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
class AttachmentUploadError extends Error {}

/** Uploads are attempted once; comments retry a frozen payload with one key. */
export class CommentDelivery {
  private readonly posts = new Map<string, Promise<string>>();
  // Keep only hashes and results, never file bytes, after an attachment attempt.
  private readonly attempts = new Map<string, { fingerprint: string; result: Promise<string> }>();
  constructor(private readonly store: StateStore, private readonly connection: () => Promise<AuthenticatedConnection>, private readonly onSaved: () => Promise<void>, private readonly lifecycle?: DiscussionLifecycle, private readonly uploadsDirectory?: string) {}
  private async filePath(path: string) {
    if (!this.uploadsDirectory) throw new Error("附件上传目录不可用。");
    const [root, file] = await Promise.all([realpath(this.uploadsDirectory), realpath(path)]);
    const child = relative(root, file);
    if (!child || isAbsolute(child) || child === ".." || child.startsWith(`..${sep}`)) throw new Error("附件路径不在 Paseo 上传目录内，请重新选择文件。");
    return file;
  }
  async prepare(prompt: ProviderPrompt): Promise<{ body: string; attachments: Attachment[] }> {
    if (prompt.input.type !== "message" || prompt.outputSchema !== undefined) throw new Error("仅支持评论正文、图片和已上传文件，不支持命令或结构化输出。");
    const parts = prompt.input.content;
    if (parts.some(part => !(part.type === "image" || part.type === "uploaded_file" || (part.type === "text" && !("mimeType" in part)))))
      throw new Error("不支持此附件类型；仅支持图片和已上传文件。");
    const body = parts.map(part => part.type === "text" ? part.text : "").join("");
    const files = parts.filter(part => part.type !== "text");
    if (!body.trim()) throw new Error(files.length ? "请输入评论正文后再发送附件。" : "请输入非空评论正文。");
    if (files.length > 10) throw new Error("每条评论最多发送 10 个附件。");
    const attachments: Attachment[] = [];
    for (const part of files) {
      if (part.type !== "image" && part.type !== "uploaded_file") throw new Error("不支持此附件类型。");
      if (!part.mimeType.trim()) throw new Error("附件类型不能为空，请重新选择附件。");
      if (part.type === "image") {
        if (!part.data || part.data.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(part.data)) throw new Error("图片 base64 数据无效，请重新选择图片。");
        const size = Buffer.byteLength(part.data, "base64");
        if (size > maxFileSize) throw new Error("单个附件不能超过 50 MiB。");
        const extension = ({ "image/png": "png", "image/jpeg": "jpg", "image/gif": "gif", "image/webp": "webp" } as Record<string, string>)[part.mimeType.toLowerCase()] ?? "bin";
        attachments.push({ name: `image-${attachments.length + 1}.${extension}`, mimeType: part.mimeType, size, data: part.data });
      } else {
        try {
          const path = await this.filePath(part.path), info = await stat(path);
          if (!info.isFile()) throw new Error("附件不是普通文件。");
          if (info.size > maxFileSize) throw new Error("单个附件不能超过 50 MiB。");
          attachments.push({ name: part.fileName, mimeType: part.mimeType, size: info.size, path });
        } catch (error) { throw new Error(`附件不可读：${error instanceof Error ? error.message : "请重新选择文件。"}`); }
      }
    }
    return { body, attachments };
  }
  private async upload(connection: AuthenticatedConnection, issueId: string, slug: string, file: Attachment) {
    let bytes: Buffer;
    if ("data" in file) bytes = Buffer.from(file.data, "base64");
    else try {
      const path = await this.filePath(file.path);
      const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
      try {
        const info = await handle.stat();
        if (!info.isFile() || info.size !== file.size || info.size > maxFileSize) throw new Error("附件已变化，请重新选择文件。");
        // One extra byte detects growth without reading an unbounded file.
        const buffer = Buffer.alloc(file.size + 1);
        let length = 0;
        while (length < buffer.length) {
          const { bytesRead } = await handle.read(buffer, length, buffer.length - length);
          if (!bytesRead) break;
          length += bytesRead;
        }
        if (length !== file.size) throw new Error("附件已变化，请重新选择文件。");
        bytes = buffer.subarray(0, length);
      } finally { await handle.close(); }
    } catch { throw new AttachmentUploadError("附件已变化或不可读"); }
    const form = new FormData();
    form.set("issue_id", issueId);
    form.set("file", new Blob([new Uint8Array(bytes)], { type: file.mimeType }), file.name);
    let identityVerified = false;
    let response: Response;
    try {
      response = await remoteFetch({ ...connection, assertCurrent: async () => {
        await connection.assertCurrent?.();
        identityVerified = true;
      } }, "/api/upload-file", { method: "POST", headers: { "X-Workspace-Slug": slug }, body: form }, 120_000);
    } catch (error) {
      // Preserve the original identity-check/revocation error, including its type.
      if (!identityVerified || connection.signal?.aborted) throw error;
      throw new AttachmentUploadError("网络错误或上传超时");
    }
    if (!response.ok) {
      await response.body?.cancel().catch(() => {});
      const reason = response.status === 413 ? "（超出服务端大小限制）" : response.status === 403 ? "（无权限）" : "";
      throw new AttachmentUploadError(`HTTP ${response.status}${reason}`);
    }
    let value: unknown;
    try { value = await response.json(); }
    catch (error) {
      if (connection.signal?.aborted) throw error;
      throw new AttachmentUploadError(error instanceof SyntaxError ? "上传响应无效" : "网络错误或上传超时");
    }
    const parsed = remoteAttachment.safeParse(value);
    if (!parsed.success) throw new AttachmentUploadError(value && typeof value === "object" && "id" in value && value.id === "" ? "响应附件 ID 为空" : "上传响应无效");
    return parsed.data;
  }
  send(address: RunAddress, clientMessageId: string, body: string, target: { parent_id?: string; askuser_answer_to?: string } = {}, attachments: Attachment[] = []): Promise<string> {
    target = { ...target };
    const key = JSON.stringify([address.connectionKey, address.issueId, address.rootId, clientMessageId, target.parent_id, target.askuser_answer_to]);
    const fingerprint = hash([body, attachments]);
    const attempted = this.attempts.get(key);
    if (attempted) return attempted.fingerprint === fingerprint ? attempted.result : Promise.reject(new Error("同一输入 ID 的正文或附件已变化，请作为新评论发送。"));
    const pending = this.posts.get(key);
    if (pending) return pending;
    const operation = (async () => {
      const issue = (await this.store.read()).connections[address.connectionKey].issues[address.issueId];
      const connection = await this.connection();
      if (connection.connectionKey !== address.connectionKey) throw new Error("登录身份已变化；请切回此讨论所属的 Multica 连接。");
      const saved = issue.commentInputs[clientMessageId];
      if (saved?.rootId === address.rootId) {
        if ((saved.fingerprint && saved.fingerprint !== fingerprint) || (attachments.length && !saved.attachments?.length)) throw new Error("同一输入 ID 的正文或附件已变化，请作为新评论发送。");
        return saved.commentId;
      }
      const workspace = cachedWorkspace(await this.store.read(), address.connectionKey, issue);
      const idempotencyKey = createHash("sha256").update(key).digest("hex");
      const uploaded: z.infer<typeof remoteAttachment>[] = [];
      for (const file of attachments) {
        try { uploaded.push(await this.upload(connection, address.issueId, workspace.slug, file)); }
        catch (error) {
          if (!(error instanceof AttachmentUploadError)) throw error;
          const status = uploaded.length
            ? `评论未发送。已上传的 ${uploaded.length} 个附件未关联评论，可能成为孤立附件，请在 Multica 核对。`
            : "评论未发送，可重新发送。";
          throw new Error(`附件「${file.name}」上传失败：${error.message}。${status}`);
        }
      }
      const attachmentIds = uploaded.map(file => file.id);
      const payload = JSON.stringify({ content: body, type: "comment", ...((target.parent_id ?? (address.rootId === "main" ? undefined : address.rootId)) ? { parent_id: target.parent_id ?? address.rootId } : {}), ...(target.askuser_answer_to ? { askuser_answer_to: target.askuser_answer_to } : {}), ...(attachmentIds.length ? { attachment_ids: attachmentIds } : {}) });
      for (let attempt = 0; attempt < 3; attempt++) {
        const current = (await this.store.read()).connections[address.connectionKey]?.issues[address.issueId];
        if (target.askuser_answer_to) assertAskuserWritable(current, address, this.lifecycle);
        let response: Response | undefined;
        try {
          response = await remoteFetch(connection, `/api/issues/${encodeURIComponent(address.issueId)}/comments`, {
            method: "POST", headers: { "Content-Type": "application/json", "X-Workspace-Slug": workspace.slug, "Idempotency-Key": idempotencyKey },
            body: payload,
          });
        } catch (error) { if (attempt === 2) throw error; }
        if (response?.ok) {
          const comment = receiptSchema.parse(await response.json());
          const received = comment.attachments ?? [];
          if (comment.issue_id !== address.issueId ||
            (comment.parent_id ?? null) !== (target.parent_id ?? (address.rootId === "main" ? null : address.rootId)) ||
            (comment.askuser_answer_to && comment.askuser_answer_to !== (target.askuser_answer_to ?? null)) ||
            comment.content !== body || comment.author_id !== connection.userId ||
            received.length !== attachmentIds.length || new Set(received.map(file => file.id)).size !== attachmentIds.length || received.some(file => !attachmentIds.includes(file.id)))
            throw new Error("评论回执与原输入或附件不匹配；评论可能已保存，请在 Multica 核对后再发送。");
          await this.store.update(state => {
            const delivered = attachments.length ? { body, fingerprint, attachments: received.map(file => {
              const source = attachments[attachmentIds.indexOf(file.id)];
              let url: string | undefined;
              // download_url may expire; markdown_url is the server's durable link.
              try { const value = new URL(file.markdown_url || `/api/attachments/${file.id}/download`, `${connection.apiUrl}/`); if (/^https?:$/.test(value.protocol) && !value.username && !value.password) url = value.href; } catch { /* Keep metadata without an unsafe link. */ }
              return deliveredAttachment.parse({ id: file.id, name: file.filename ?? source.name, mimeType: file.content_type || source.mimeType, size: file.size_bytes ?? source.size, url });
            }) } : {};
            state.connections[address.connectionKey].issues[address.issueId].commentInputs[clientMessageId] = { commentId: comment.id, rootId: address.rootId, ...delivered };
          });
          return comment.id;
        }
        if (response && (response.status < 500 || attempt === 2)) {
          const error = await response.json().catch(() => ({})) as { error?: string };
          throw new Error(error.error || `Multica comment failed (HTTP ${response.status})`);
        }
        await response?.body?.cancel();
        await setTimeout(100 * (attempt + 1));
      }
      throw new Error("评论发送失败，请重试。");
    })();
    this.posts.set(key, operation);
    this.attempts.set(key, { fingerprint, result: operation });
    void operation.finally(() => { this.posts.delete(key); if (!attachments.length) this.attempts.delete(key); }).then(() => this.onSaved()).catch(() => {});
    return operation;
  }
  async waitForPosts() { await Promise.allSettled(this.posts.values()); }
  async reset() { await this.waitForPosts(); this.attempts.clear(); }
  async mentions(address: { connectionKey: string; issueId: string }) {
    const issue = (await this.store.read()).connections[address.connectionKey]?.issues[address.issueId];
    if (!issue) throw new Error("任务缓存不可用。");
    const connection = await this.connection();
    if (connection.connectionKey !== address.connectionKey) throw new Error("请连接此讨论的原 Multica 身份。");
    const workspace = cachedWorkspace(await this.store.read(), address.connectionKey, issue);
    const agents = await workspaceAgents(connection, workspace);
    return { agents: agents.filter(agent => !agent.archived_at && z.uuid().safeParse(agent.id).success).map(agent => ({ id: agent.id, name: agent.name, reference: `[@${agent.name.replace(/[\\\[\]]/g, "\\$&")}](mention://agent/${agent.id})` })) };
  }
  async close() { await this.reset(); }
}
