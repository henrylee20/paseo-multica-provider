import { extname } from "node:path";
import type { AttachmentPreview } from "../shared/attachments.js";
import { remoteFetch, type AuthenticatedConnection } from "./connection.js";
import type { StateStore } from "./state.js";

const imageLimit = 10 * 1024 * 1024, textLimit = 1024 * 1024;
class PreviewError extends Error {}

function previewKind(mimeType: string, name: string): AttachmentPreview["kind"] {
  const extension = extname(name).toLowerCase();
  if (mimeType === "image/svg+xml" || extension === ".svg") return "unsupported";
  if (mimeType === "text/html" || mimeType === "application/xhtml+xml" || [".html", ".htm", ".xhtml"].includes(extension)) return "text";
  if (["image/png", "image/jpeg", "image/gif", "image/webp"].includes(mimeType)) return "image";
  if (mimeType === "text/markdown" || [".md", ".markdown"].includes(extension)) return "markdown";
  return mimeType.startsWith("text/") || ["application/json", "application/x-ndjson"].includes(mimeType) || [".txt", ".log", ".json", ".csv"].includes(extension) ? "text" : "unsupported";
}

/** Retain only the bounded prefix, even if the server omits or lies about Content-Length. */
async function readPreview(response: Response, limit: number) {
  const reader = response.body?.getReader();
  if (!reader) throw new PreviewError("附件下载失败（响应正文为空）。");
  const chunks: Uint8Array[] = [];
  let size = 0, truncated = false;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      const remaining = limit - size;
      chunks.push(value.slice(0, remaining));
      size += Math.min(value.byteLength, remaining);
      if (value.byteLength > remaining) { truncated = true; break; }
    }
  } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
  return { bytes: Buffer.concat(chunks), truncated };
}

/** Preview only attachments already recorded by this Issue's successful deliveries. */
export async function previewAttachment(store: StateStore, resolveConnection: () => Promise<AuthenticatedConnection>,
  address: { connectionKey: string; issueId: string; attachmentId: string }): Promise<AttachmentPreview> {
  const issue = (await store.read()).connections[address.connectionKey]?.issues[address.issueId];
  const attachment = Object.values(issue?.commentInputs ?? {}).flatMap(input => input.attachments ?? []).find(file => file.id === address.attachmentId);
  if (!attachment) throw new Error("附件未记录在此任务的投递附件中。");
  let connection: AuthenticatedConnection;
  try { connection = await resolveConnection(); }
  catch { throw new Error("Multica 登录不可用，请重新连接。"); }
  if (connection.connectionKey !== address.connectionKey) throw new Error("请连接此讨论的原 Multica 身份。");
  const info = { name: attachment.name, mimeType: attachment.mimeType.split(";")[0].trim().toLowerCase() || "application/octet-stream", size: attachment.size };
  const kind = previewKind(info.mimeType, info.name);
  const tooLarge = { ...info, kind: "unsupported" as const, reason: "图片超过 10 MiB 预览上限，请在 Multica 查看。" };
  if (kind === "unsupported") return { ...info, kind, reason: "此类型暂不支持预览，请在 Multica 查看。" };
  if (kind === "image" && info.size !== undefined && info.size > imageLimit) return tooLarge;
  const timeoutMs = 30_000;
  const signal = AbortSignal.any([AbortSignal.timeout(timeoutMs), ...(connection.signal ? [connection.signal] : [])]);
  let response: Response | undefined;
  try {
    response = await remoteFetch(connection, `/api/attachments/${encodeURIComponent(address.attachmentId)}/download`, { redirect: "manual", signal }, timeoutMs);
    await connection.assertCurrent?.();
    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get("location");
      let target: URL;
      try { if (!location) throw new Error(); target = new URL(location, `${connection.apiUrl}/`); }
      catch { throw new PreviewError("附件下载失败（重定向地址无效）。"); }
      const downgrade = new URL(connection.apiUrl).protocol === "https:" && target.protocol !== "https:";
      if (!/^https?:$/.test(target.protocol) || target.username || target.password || downgrade) throw new PreviewError("附件下载失败（重定向地址无效）。");
      await response.body?.cancel().catch(() => {});
      await connection.assertCurrent?.();
      // Signed storage URLs can cross origins. Never forward PAT, cookies, or other headers.
      response = await fetch(target, { redirect: "manual", credentials: "omit", signal });
      await connection.assertCurrent?.();
      if (response.status >= 300 && response.status < 400) throw new PreviewError("附件下载失败（重定向超过一次）。");
    }
    if (!response.ok) throw new PreviewError(response.status === 404 ? "附件不存在或无权访问。"
      : response.status === 401 || response.status === 403 ? "Multica 登录已失效或无权访问该附件。" : `附件下载失败（HTTP ${response.status}）。`);
    if (kind === "image" && Number(response.headers.get("content-length")) > imageLimit) return tooLarge;
    const { bytes, truncated } = await readPreview(response, kind === "image" ? imageLimit : textLimit);
    await connection.assertCurrent?.();
    return kind === "image" ? truncated ? tooLarge : { ...info, kind, data: bytes.toString("base64") }
      : { ...info, kind, text: bytes.toString("utf8"), truncated };
  } catch (error) {
    if (error instanceof PreviewError) throw error;
    // Fetch and stream errors can contain a signed URL; expose only a fixed message.
    throw new Error("附件下载失败（网络错误、超时或登录上下文已变化）。");
  } finally { await response?.body?.cancel().catch(() => {}); }
}
