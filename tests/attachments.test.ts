import { createHash } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { PaseoApi } from "@getpaseo/client";
import { afterEach, expect, it, vi } from "vitest";
import { attachmentPreview } from "../shared/attachments.js";
import { previewAttachment } from "../server/attachments.js";
import { remoteFetch } from "../server/connection.js";
import { createServerContribution } from "../server/contribute.js";
import { StateStore, connectionState, issueSchema } from "../server/state.js";
import { FakeServer } from "./support/fake-server.js";

const cleanup: Array<() => void | Promise<unknown>> = [];
afterEach(async () => { vi.restoreAllMocks(); for (const dispose of cleanup.splice(0).reverse()) await dispose(); });
const token = "synthetic-preview-secret", signature = "synthetic-signed-secret";
const textLimit = 1024 * 1024, imageLimit = 10 * 1024 * 1024;
type Reply = (request: IncomingMessage, response: ServerResponse) => void | Promise<void>;
async function fixture(file: { name?: string; mimeType?: string; size?: number; id?: string } = {}) {
  const home = await mkdtemp(join(tmpdir(), "multica-attachments-"));
  cleanup.push(() => rm(home, { recursive: true, force: true }));
  const requests: Array<{ origin: string; path: string; authorization?: string; cookie?: string; slug?: string }> = [];
  const remote = { userId: "me", download: ((_request, response) => { response.end("preview"); }) as Reply,
    target: ((_request, response) => { response.end("storage preview"); }) as Reply };
  async function listen(origin: string) {
    const http = createServer(async (request, response) => {
      const path = new URL(request.url!, "http://localhost").pathname;
      requests.push({ origin, path, authorization: request.headers.authorization, cookie: request.headers.cookie, slug: request.headers["x-workspace-slug"] as string | undefined });
      if (origin === "api" && path === "/api/me") { response.setHeader("Content-Type", "application/json"); response.end(JSON.stringify({ id: remote.userId })); }
      else await (origin === "api" && path.startsWith("/api/attachments/") ? remote.download : remote.target)(request, response);
    });
    await new Promise<void>(resolve => http.listen(0, "127.0.0.1", resolve));
    cleanup.push(() => new Promise<void>(resolve => { http.close(() => resolve()); http.closeAllConnections(); }));
    return `http://127.0.0.1:${(http.address() as { port: number }).port}`;
  }
  const apiUrl = await listen("api"), storageUrl = await listen("storage");
  const connectionKey = createHash("sha256").update(JSON.stringify([apiUrl, "me"])).digest("hex");
  const attachment = { id: "file", name: "notes.txt", mimeType: "text/plain", url: "https://ignored.example/never-download", ...file };
  const store = new StateStore(join(home, "state"));
  await store.update(state => {
    connectionState(state, connectionKey).issues.issue = issueSchema.parse({ remoteWorkspaceId: "workspace", workspaceId: "native", cwd: home, title: "Issue", description: "",
      commentInputs: { sent: { commentId: "comment", rootId: "main", attachments: [attachment] } } });
  });
  const environment = { PASEO_HOME: home, MULTICA_SERVER_URL: apiUrl, MULTICA_TOKEN: token };
  const server = new FakeServer();
  cleanup.push(createServerContribution({ stateDirectory: store.directory, homeDirectory: home, workingDirectory: home, environment })(server.context));
  const address = { connectionKey, issueId: "issue", attachmentId: attachment.id };
  const preview = (input = address) => server.rpc(attachmentPreview, input, {} as PaseoApi);
  return { preview, address, remote, requests, environment, apiUrl, storageUrl, store };
}

it("rejects unknown attachment, Issue, and connection IDs before making any network request", async () => {
  const f = await fixture();
  for (const input of [{ ...f.address, attachmentId: "unknown" }, { ...f.address, issueId: "other" }, { ...f.address, connectionKey: "other" }])
    await expect(f.preview(input)).rejects.toThrow("附件未记录在此任务的投递附件中。");
  expect(f.requests).toEqual([]);
});

it("requires the original Multica identity before downloading a recorded attachment", async () => {
  const f = await fixture(); f.remote.userId = "other";
  await expect(f.preview()).rejects.toThrow("请连接此讨论的原 Multica 身份。");
  expect(f.requests.map(request => request.path)).toEqual(["/api/me"]);
});

it("returns normalized image metadata and base64 from the authenticated ID download route", async () => {
  const f = await fixture({ name: "photo.png", mimeType: " IMAGE/PNG; charset=binary ", size: 3, id: "file/with space" });
  const bytes = Buffer.from([0, 128, 255]);
  f.remote.download = (_request, response) => { response.setHeader("Content-Type", "application/octet-stream"); response.end(bytes); };
  expect(await f.preview()).toEqual({ kind: "image", name: "photo.png", mimeType: "image/png", size: 3, data: bytes.toString("base64") });
  expect(f.requests.at(-1)).toEqual({ origin: "api", path: "/api/attachments/file%2Fwith%20space/download", authorization: `Bearer ${token}`, cookie: undefined, slug: undefined });
});

it.each([textLimit - 1, textLimit, textLimit + 17])("bounds a streamed %i-byte text preview at 1 MiB and reports truncation", async size => {
  const f = await fixture({ size });
  f.remote.download = (_request, response) => { response.write("x".repeat(size - 1)); response.end("y"); };
  expect(await f.preview()).toEqual({ kind: "text", name: "notes.txt", mimeType: "text/plain", size,
    text: size > textLimit ? "x".repeat(textLimit) : "x".repeat(size - 1) + "y", truncated: size > textLimit });
});

it.each([
  ["text/markdown; charset=utf-8", "notes.txt", "markdown"], ["application/octet-stream", "README.MD", "markdown"], ["text/plain", "notes.markdown", "markdown"],
  ["application/json", "data.bin", "text"], ["application/x-ndjson", "data.bin", "text"], ["text/x-log", "data.bin", "text"],
  ["application/octet-stream", "notes.TXT", "text"], ["application/octet-stream", "server.log", "text"], ["application/octet-stream", "data.json", "text"], ["application/octet-stream", "data.csv", "text"],
  ["text/html", "page.md", "text"], ["application/xhtml+xml", "page.xhtml", "text"], ["application/octet-stream", "page.HTML", "text"],
])("classifies %s / %s as %s without executing HTML", async (mimeType, name, kind) => {
  const f = await fixture({ mimeType, name });
  const text = "# 原文\n<script>alert('source')</script>";
  f.remote.download = (_request, response) => { response.end(text); };
  expect(await f.preview()).toMatchObject({ kind, name, mimeType: mimeType.split(";")[0], text, truncated: false });
});

it("decodes invalid or cut UTF-8 loosely", async () => {
  const f = await fixture();
  f.remote.download = (_request, response) => { response.write(Buffer.alloc(textLimit - 1, 120)); response.end(Buffer.from([0xe4, 0xb8, 0xad])); };
  expect(await f.preview()).toMatchObject({ kind: "text", text: "x".repeat(textLimit - 1) + "�", truncated: true });
});

it.each([
  ["application/pdf", "document.pdf"], ["application/zip", "archive.zip"], ["application/vnd.openxmlformats-officedocument.wordprocessingml.document", "document.docx"],
  ["image/svg+xml", "drawing.md"], ["text/plain", "drawing.SVG"],
])("does not download unsupported %s / %s", async (mimeType, name) => {
  const f = await fixture({ mimeType, name });
  expect(await f.preview()).toMatchObject({ kind: "unsupported", name, mimeType, reason: expect.any(String) });
  expect(f.requests.map(request => request.path)).toEqual(["/api/me"]);
});

it("does not download an image whose recorded size exceeds 10 MiB", async () => {
  const f = await fixture({ name: "large.png", mimeType: "image/png", size: imageLimit + 1 });
  expect(await f.preview()).toMatchObject({ kind: "unsupported", reason: expect.stringContaining("10 MiB") });
  expect(f.requests.map(request => request.path)).toEqual(["/api/me"]);
});

it("stops an oversized image stream even without Content-Length or recorded size", async () => {
  const f = await fixture({ name: "large.png", mimeType: "image/png" });
  f.remote.download = (_request, response) => { response.write(Buffer.alloc(imageLimit)); response.end("extra"); };
  expect(await f.preview()).toMatchObject({ kind: "unsupported", reason: expect.stringContaining("10 MiB") });
});

it.each(["cross-origin", "relative"])("follows one %s redirect without credentials", async mode => {
  const f = await fixture();
  f.remote.download = (_request, response) => { response.writeHead(302, { Location: `${mode === "relative" ? "" : f.storageUrl}/signed?key=${signature}`, "Set-Cookie": "session=secret" }); response.end(); };
  expect(await f.preview()).toMatchObject({ kind: "text", text: "storage preview", truncated: false });
  expect(f.requests.at(-1)).toEqual({ origin: mode === "relative" ? "api" : "storage", path: "/signed", authorization: undefined, cookie: undefined, slug: undefined });
});

it("rejects an HTTPS to HTTP redirect before making a second request", async () => {
  const f = await fixture();
  const fetch = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(null, { status: 302, headers: { Location: `http://storage.example/signed?key=${signature}` } }));
  await expect(previewAttachment(f.store, async () => ({ apiUrl: "https://multica.example", token, userId: "me", connectionKey: f.address.connectionKey }), f.address))
    .rejects.toMatchObject({ message: "附件下载失败（重定向地址无效）。" });
  expect(fetch).toHaveBeenCalledExactlyOnceWith("https://multica.example/api/attachments/file/download", expect.objectContaining({ redirect: "manual" }));
});

it("rejects a second redirect without requesting its target or exposing the signed URL", async () => {
  const f = await fixture();
  f.remote.download = (_request, response) => { response.writeHead(302, { Location: `${f.storageUrl}/signed?key=${signature}` }); response.end(); };
  f.remote.target = (_request, response) => { response.writeHead(302, { Location: `${f.apiUrl}/unexpected?key=${signature}` }); response.end(); };
  await expect(f.preview()).rejects.toMatchObject({ message: "附件下载失败（重定向超过一次）。" });
  expect(f.requests.map(request => request.path)).toEqual(["/api/me", "/api/attachments/file/download", "/signed"]);
});

it.each(["", "file:///tmp/file", "data:text/plain,secret", `https://user:${token}@example.test/file`])("rejects an invalid redirect location %s", async location => {
  const f = await fixture();
  f.remote.download = (_request, response) => { response.writeHead(302, location ? { Location: location } : {}); response.end(); };
  await expect(f.preview()).rejects.toMatchObject({ message: "附件下载失败（重定向地址无效）。" });
  expect(f.requests).toHaveLength(2);
});

it.each([
  [404, "附件不存在或无权访问。"], [401, "Multica 登录已失效或无权访问该附件。"], [403, "Multica 登录已失效或无权访问该附件。"], [500, "附件下载失败（HTTP 500）。"],
] as const)("maps HTTP %i without exposing response bodies or credentials", async (status, message) => {
  const f = await fixture();
  f.remote.download = (_request, response) => { response.statusCode = status; response.end(`${token} ${signature}`); };
  await expect(f.preview()).rejects.toMatchObject({ message });
});

it.each(["fetch", "stream"])("sanitizes %s errors that contain credentials or signed URLs", async phase => {
  const f = await fixture(), realFetch = globalThis.fetch;
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    if (String(input).includes("/api/attachments/")) {
      const error = new Error(`failed ${token} ${f.storageUrl}/signed?key=${signature}`);
      if (phase === "fetch") throw error;
      return new Response(new ReadableStream({ start(controller) { controller.error(error); } }));
    }
    return realFetch(input, init);
  });
  await expect(f.preview()).rejects.toMatchObject({ message: "附件下载失败（网络错误、超时或登录上下文已变化）。" });
});

it("rechecks CLI credentials after the first response before following a redirect", async () => {
  const f = await fixture();
  f.remote.download = (_request, response) => { f.environment.MULTICA_TOKEN = "rotated"; response.writeHead(302, { Location: `${f.storageUrl}/signed` }); response.end(); };
  await expect(f.preview()).rejects.toThrow("登录上下文已变化");
  expect(f.requests.map(request => request.path)).toEqual(["/api/me", "/api/attachments/file/download"]);
});

it("discards preview bytes if the final identity check fails", async () => {
  const f = await fixture();
  const assertCurrent = vi.fn().mockResolvedValue(undefined).mockResolvedValueOnce(undefined).mockResolvedValueOnce(undefined)
    .mockRejectedValueOnce(new Error(`revoked ${token}`));
  await expect(previewAttachment(f.store, async () => ({ apiUrl: f.apiUrl, token, userId: "me", connectionKey: f.address.connectionKey, assertCurrent }), f.address)).rejects.toThrow("登录上下文已变化");
  expect(assertCurrent).toHaveBeenCalledTimes(3);
});

it.each([undefined, "follow"] as const)("remoteFetch still rejects automatic redirects with redirect=%s", async redirect => {
  const f = await fixture();
  f.remote.download = (_request, response) => { response.writeHead(302, { Location: `${f.storageUrl}/signed` }); response.end(); };
  await expect(remoteFetch({ apiUrl: f.apiUrl, token, userId: "me", connectionKey: f.address.connectionKey }, "/api/attachments/file/download", { redirect })).rejects.toThrow();
  expect(f.requests.map(request => request.path)).toEqual(["/api/attachments/file/download"]);
});
