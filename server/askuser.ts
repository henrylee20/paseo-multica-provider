import { askuserPermissionId, formatAskuserAnswers } from "./askuser-answers.js";
import type { CommentDelivery } from "./delivery.js";
import { z } from "zod";
import { createHash, randomUUID } from "node:crypto";
import type { ProviderTimelineItem } from "@getpaseo/plugin/server/provider";
import { askuserDocumentSchema, isAskuserReplyValid, type AskuserCardData } from "../shared/askuser.js";
import { remoteFetch, type AuthenticatedConnection } from "./connection.js";
import { StateStore, type IssueMapping } from "./state.js";
import { remoteJson, workspaceSchema, type RemoteWorkspace } from "./sync.js";
import type { DiscussionLifecycle } from "./discussion-lifecycle.js";
import { askuserUnavailableReason, assertAskuserWritable } from "./askuser-policy.js";

type Address = { connectionKey: string; issueId: string; rootId: string };
type CardAddress = { connectionKey: string; issueId: string; commentId: string; attachmentId: string };
export type AskuserComment = { id: string; type: string; parent_id?: string | null; deleted_at?: string | null; attachments?: Array<{ id?: string; filename?: string; content_type?: unknown; download_url?: string }> | null };
const timelineSchema = z.array(z.object({ id: z.string(), type: z.string(), parent_id: z.string().nullish(), content: z.string().optional(),
  actor_type: z.string().optional(), actor_id: z.string().optional(), delegated_by: z.string().nullish(), deleted_at: z.string().nullish(),
  askuser_skipped_at: z.string().nullish(), askuser_skipped_by: z.string().nullish(),
}));
const cardKey = (commentId: string, attachmentId: string) => JSON.stringify([commentId, attachmentId]);
const discoveryKey = (address: CardAddress) => JSON.stringify([address.connectionKey, address.issueId, address.commentId, address.attachmentId]);
const discussionKey = (address: Address) => JSON.stringify([address.connectionKey, address.issueId, address.rootId]);
const preview = (text: string | undefined, limit: number) => text === undefined ? undefined : [...text].slice(0, limit).join("");
const bounded = (data: AskuserCardData): AskuserCardData => {
  if (Buffer.byteLength(JSON.stringify(data)) < 24000) return data;
  return { ...data, title: preview(data.title, 160)!, description: preview(data.description, 800), truncated: true,
    readOnlyReason: preview(data.readOnlyReason, 240), error: preview(data.error, 500), statusError: preview(data.statusError, 160), skippedAt: preview(data.skippedAt, 64), skippedBy: preview(data.skippedBy, 128),
    questions: data.questions.slice(0, 3).map(question => ({ ...question, id: preview(question.id, 60)!, title: preview(question.title, 100)!, description: preview(question.description, 150),
      ...(question.type === "text" ? { required_when: question.required_when && { question_id: preview(question.required_when.question_id, 60)!, option_ids: question.required_when.option_ids.slice(0, 5).map(id => preview(id, 60)!) } } : { options: question.options.map(option => ({ id: preview(option.id, 60)!, label: preview(option.label, 80)! })),
        other: question.other && { ...question.other, label: preview(question.other.label, 80) } }),
    })),
    delivery: data.delivery && { ...data.delivery, message: preview(data.delivery.message, 500) },
    answer: data.answer && { ...data.answer, content: preview(data.answer.content, 800)!, actorId: preview(data.answer.actorId, 128), actorType: preview(data.answer.actorType, 32), delegatedBy: preview(data.answer.delegatedBy, 128) },
  };
};
class DeferredAttachment extends Error {}
const revision = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");

export function cachedAskuserCard(address: CardAddress, issue: IssueMapping, context: { offline: boolean; userId?: string; lifecycle?: DiscussionLifecycle; delivery?: AskuserCardData["delivery"] } = { offline: true }): AskuserCardData {
    const record = issue.askuserCards?.[cardKey(address.commentId, address.attachmentId)];
    if (!record) throw new Error("提问卡片缓存不可用。");
    const cached = issue.askuserAttachments?.[record.attachmentId];
    const document = cached?.document;
    const delivery = (record.status === "pending" && !record.deleted) || context.delivery?.status === "saved" ? context.delivery : undefined;
    const offline = context.offline;
    const targetUser = document?.answer_user_id;
    const readOnlyReason = askuserUnavailableReason(issue, record.rootId, context.lifecycle, address.connectionKey, address.issueId)
      ?? (record.deleted ? "原评论已删除，仅显示缓存。" : offline ? "离线缓存，仅供只读。"
      : targetUser && targetUser !== context.userId ? `仅指定用户 ${targetUser} 可作答；当前为只读。` : undefined);
    return { connectionKey: address.connectionKey, issueId: address.issueId, commentId: address.commentId, attachmentId: address.attachmentId, rootId: record.rootId, revision: revision([record, cached, delivery, offline, readOnlyReason]), title: document?.title ?? "askuser.json 提问卡片", description: document?.description,
      questions: document?.questions ?? [], status: record.status, collapsed: record.status === "pending" && !!record.collapsed, readOnly: !!readOnlyReason || record.status !== "pending",
      delivery: delivery && { status: delivery.status, clientMessageId: delivery.clientMessageId, message: delivery.message }, readOnlyReason, offline, truncated: false, error: cached?.error, statusError: record.statusError, answer: record.answer, skippedAt: record.skippedAt, skippedBy: record.skippedBy };
  }

/** Attachment downloads and full timeline observations are independent of ordinary comment projection. */
export class AskUsers {
  private listeners = new Map<string, Set<(row: ProviderTimelineItem, card: AskuserCardData, announceFresh: boolean) => void>>();
  private readonly fresh = new Map<string, { address: Address; deferred: boolean }>();
  private readonly deliveries = new Map<string, NonNullable<AskuserCardData["delivery"]>>();
  private userIds = new Map<string, string>();
  private pending = new Map<string, Promise<void>>();
  private actions = new Map<string, { kind: string; operation: Promise<unknown> }>();
  private online = new Set<string>();
  private readonly availability = new Map<string, string>();
  private readonly unsubscribe: () => void;
  constructor(private readonly store: StateStore, private readonly connection: () => Promise<AuthenticatedConnection>, private readonly lifecycle: DiscussionLifecycle) {
    // Durable availability changes must clear native needs_input even when sync
    // will not reach this Issue again (hidden or archived).
    this.unsubscribe = store.subscribe(state => {
      for (const [connectionKey, connection] of Object.entries(state.connections)) for (const [issueId, issue] of Object.entries(connection.issues)) {
        const key = JSON.stringify([connectionKey, issueId]);
        const availability = JSON.stringify([issue.archiveReason, issue.manualHidden]);
        const previous = this.availability.get(key);
        this.availability.set(key, availability);
        if (previous !== availability) this.project(connectionKey, issueId, issue);
      }
    });
  }
  subscribe(address: Address, listener: (row: ProviderTimelineItem, card: AskuserCardData, announceFresh: boolean) => void) {
    const key = discussionKey(address);
    const listeners = this.listeners.get(key) ?? new Set(); listeners.add(listener); this.listeners.set(key, listeners);
    return () => { listeners.delete(listener); if (!listeners.size) this.listeners.delete(key); };
  }
  isFresh(card: CardAddress) { return this.fresh.has(discoveryKey(card)); }
  deferFresh(card: AskuserCardData) {
    const discovery = this.fresh.get(discoveryKey(card));
    if (discovery) discovery.deferred = true;
  }
  hasDeferredFresh(address: Address) {
    return [...this.fresh.values()].some(discovery => discovery.deferred && discussionKey(discovery.address) === discussionKey(address));
  }
  projectedFresh(card: CardAddress) { this.fresh.delete(discoveryKey(card)); }
  async announceFresh(address: Address) {
    const issue = (await this.store.read()).connections[address.connectionKey]?.issues[address.issueId];
    if (issue) this.project(address.connectionKey, address.issueId, issue, address.rootId);
  }
  private data(address: CardAddress, issue: IssueMapping) {
    return cachedAskuserCard(address, issue, { offline: !this.online.has(address.connectionKey), userId: this.userIds.get(address.connectionKey), lifecycle: this.lifecycle, delivery: this.deliveries.get(discoveryKey(address)) });
  }
  private row(data: AskuserCardData): ProviderTimelineItem {
    return { type: "plugin", id: `multica:askuser:${data.commentId}:${data.attachmentId}`, pluginId: "multica", kind: "askuser", version: 1, data: bounded(data) };
  }
  async rows(address: Address) {
    const issue = (await this.store.read()).connections[address.connectionKey]?.issues[address.issueId];
    if (Object.values(issue?.askuserCards ?? {}).some(card => card.rootId === address.rootId)) await this.checkConnection(address.connectionKey);
    return issue ? Object.values(issue.askuserCards ?? {}).filter(card => card.rootId === address.rootId).map(card => this.row(this.data({ ...address, commentId: card.commentId, attachmentId: card.attachmentId }, issue))) : [];
  }
  async cards(address: Address) {
    const issue = (await this.store.read()).connections[address.connectionKey]?.issues[address.issueId];
    return issue ? Object.values(issue.askuserCards ?? {}).filter(card => card.rootId === address.rootId).map(card => this.data({ ...address, commentId: card.commentId, attachmentId: card.attachmentId }, issue)) : [];
  }
  private async publish(connectionKey: string, issueId: string) {
    const issue = (await this.store.read()).connections[connectionKey]?.issues[issueId];
    if (issue) this.project(connectionKey, issueId, issue);
  }
  private project(connectionKey: string, issueId: string, issue: IssueMapping, announceRoot?: string) {
    for (const card of Object.values(issue.askuserCards ?? {})) {
      const address = { connectionKey, issueId, rootId: card.rootId };
      const data = this.data({ ...address, commentId: card.commentId, attachmentId: card.attachmentId }, issue);
      const row = this.row(data);
      for (const listener of this.listeners.get(discussionKey(address)) ?? []) listener(row, data, announceRoot === card.rootId);
    }
  }
  discover(connection: AuthenticatedConnection, workspace: RemoteWorkspace, issueId: string, comments: AskuserComment[], roots: Map<string, string | undefined>, scope?: string) {
    const key = JSON.stringify([connection.connectionKey, issueId]);
    const operation = (this.pending.get(key) ?? Promise.resolve()).catch(() => {}).then(() => this.discoverSnapshot(connection, workspace, issueId, comments, roots, scope));
    this.pending.set(key, operation);
    return operation.finally(() => { if (this.pending.get(key) === operation) this.pending.delete(key); });
  }
  private async discoverSnapshot(connection: AuthenticatedConnection, workspace: RemoteWorkspace, issueId: string, comments: AskuserComment[], roots: Map<string, string | undefined>, scope?: string) {
    this.online.add(connection.connectionKey); this.userIds.set(connection.connectionKey, connection.userId);
    for (const comment of comments) {
      const rootId = roots.get(comment.id);
      if (!rootId || comment.type !== "comment" || comment.deleted_at) continue;
      for (const attachment of comment.attachments ?? []) {
        if (attachment.filename !== "askuser.json" || attachment.content_type !== "application/json" || !attachment.id) continue;
        const issue = (await this.store.read()).connections[connection.connectionKey].issues[issueId];
        let cached = issue.askuserAttachments?.[attachment.id];
        // Hiding defers discovery; it is not a permanent attachment failure.
        if (!cached && askuserUnavailableReason(issue, rootId, this.lifecycle, connection.connectionKey, issueId)) continue;
        if (!cached) {
          try { cached = { document: await this.download(connection, workspace, issueId, attachment.download_url, rootId) }; }
          catch (error) { if (error instanceof DeferredAttachment) continue; if (connection.signal?.aborted) await this.checkConnection(connection.connectionKey); cached = { error: error instanceof Error ? error.message.slice(0, 1000) : "附件下载或解析失败。" }; }
          await this.store.update(state => { (state.connections[connection.connectionKey].issues[issueId].askuserAttachments ??= {})[attachment.id!] = cached!; });
        }
        await this.store.update(state => {
          const cards = state.connections[connection.connectionKey].issues[issueId].askuserCards ??= {};
          const key = cardKey(comment.id, attachment.id!);
          if (!cards[key]) {
            cards[key] = { rootId, commentId: comment.id, attachmentId: attachment.id!, status: cached?.document ? "pending" : "invalid" };
            this.fresh.set(discoveryKey({ connectionKey: connection.connectionKey, issueId, commentId: comment.id, attachmentId: attachment.id! }),
              { address: { connectionKey: connection.connectionKey, issueId, rootId }, deferred: false });
          }
        });
      }
    }
    // Only a complete snapshot proves removal. A Thread read cannot remove cards in another Thread.
    if (![...roots.values()].some(root => root === undefined)) await this.store.update(state => {
      const local = state.connections[connection.connectionKey].issues[issueId];
      for (const record of Object.values(local.askuserCards ?? {})) {
        if (scope && record.rootId !== scope) continue;
        const source = comments.find(comment => comment.id === record.commentId);
        record.deleted = !source || !!source.deleted_at || !(source.attachments ?? []).some(attachment => attachment.id === record.attachmentId && attachment.filename === "askuser.json" && attachment.content_type === "application/json");
      }
    });
    await this.resolveStatuses(connection, workspace, issueId);
    await this.publish(connection.connectionKey, issueId);
  }
  private async resolveStatuses(connection: AuthenticatedConnection, workspace: RemoteWorkspace, issueId: string) {
    const issue = (await this.store.read()).connections[connection.connectionKey].issues[issueId];
    for (const card of Object.values(issue.askuserCards ?? {})) {
      const id = discoveryKey({ connectionKey: connection.connectionKey, issueId, ...card });
      if ((card.status !== "pending" || card.deleted) && this.deliveries.get(id)?.status !== "saved") this.deliveries.delete(id);
    }
    const unresolved = Object.entries(issue.askuserCards ?? {}).filter(([, card]) => card.status !== "answered" && card.status !== "skipped" && !card.deleted);
    if (!unresolved.length) return true;
    try {
      const response = await remoteFetch(connection, `/api/issues/${encodeURIComponent(issueId)}/timeline`, { headers: { "X-Workspace-Slug": workspace.slug } });
      if (!response.ok) { await response.body?.cancel(); throw new Error("Timeline unavailable"); }
      const entries = timelineSchema.parse(await response.json());
      await connection.assertCurrent?.();
      await this.store.update(state => {
        const local = state.connections[connection.connectionKey].issues[issueId];
        for (const [key] of unresolved) {
          const record = local.askuserCards![key];
          const id = discoveryKey({ connectionKey: connection.connectionKey, issueId, ...record });
          delete record.statusError;
          const original = entries.find(entry => entry.id === record.commentId);
          if (original?.deleted_at) { record.deleted = true; this.deliveries.delete(id); continue; }
          if (original?.askuser_skipped_at?.trim()) {
            record.status = "skipped"; delete record.collapsed; record.skippedAt = original.askuser_skipped_at; record.skippedBy = original.askuser_skipped_by ?? undefined; this.deliveries.delete(id); continue;
          }
          const document = local.askuserAttachments?.[record.attachmentId]?.document;
          const answer = document && entries.find(entry => entry.type === "comment" && entry.parent_id === record.commentId && !entry.deleted_at && entry.content && isAskuserReplyValid(document, { ...entry, content: entry.content }));
          if (answer) {
            record.status = "answered";
            this.deliveries.delete(id);
            delete record.collapsed;
            record.answer = { commentId: answer.id, content: answer.content!, actorId: answer.actor_id, actorType: answer.actor_type, delegatedBy: answer.delegated_by ?? undefined };
          }
        }
      });
      return true;
    } catch {
      if (connection.signal?.aborted) await this.checkConnection(connection.connectionKey);
      await this.store.update(state => {
        for (const [key] of unresolved) state.connections[connection.connectionKey].issues[issueId].askuserCards![key].statusError = "无法核对完整时间线，显示最后已知状态。";
      });
      return false;
    }
  }
  private async download(connection: AuthenticatedConnection, workspace: RemoteWorkspace, issueId: string, source?: string, rootId?: string) {
    if (!source) throw new Error("附件缺少 download_url。");
    let url: URL;
    try { url = new URL(source, `${connection.apiUrl}/`); } catch { throw new Error("附件 download_url 无效。"); }
    if (url.origin !== new URL(connection.apiUrl).origin || url.username || url.password) throw new Error("拒绝跨源或含凭据的附件地址。");
    await this.assertDownloadAvailable(connection.connectionKey, issueId, rootId);
    const object = await this.issueObject(connection, workspace, issueId);
    if (object.id !== issueId || object.workspace_id !== workspace.id) throw new Error("任务访问核对返回了其他任务，未下载附件。");
    let response: Response;
    try {
      await connection.assertCurrent?.();
      await this.assertDownloadAvailable(connection.connectionKey, issueId, rootId);
      response = await fetch(url, { headers: { Authorization: `Bearer ${connection.token}`, "X-Workspace-Slug": workspace.slug }, redirect: "error",
        signal: AbortSignal.any([AbortSignal.timeout(10_000), ...(connection.signal ? [connection.signal] : [])]) });
    } catch (error) { if (error instanceof DeferredAttachment) throw error; throw new Error("附件下载失败（网络、重定向或登录上下文已变化）。"); }
    try {
      await connection.assertCurrent?.();
      if (!response.ok) throw new Error(`附件下载失败（HTTP ${response.status}）。`);
      if (response.headers.get("content-type")?.split(";")[0].trim().toLowerCase() !== "application/json") throw new Error("附件响应不是 application/json JSON。");
      if (Number(response.headers.get("content-length")) > 65536) throw new Error("附件超过 64 KiB 上限。");
      const reader = response.body?.getReader();
      if (!reader) throw new Error("附件 JSON 正文为空。");
      const chunks: Uint8Array[] = [];
      let size = 0;
      try {
        for (;;) {
          const result = await reader.read();
          if (result.done) break;
          size += result.value.byteLength;
          if (size > 65536) throw new Error("附件超过 64 KiB 上限。");
          chunks.push(result.value);
        }
      } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
      await connection.assertCurrent?.();
      let json: unknown;
      try { json = JSON.parse(Buffer.concat(chunks).toString("utf8")); } catch { throw new Error("附件 JSON 正文不可解析。"); }
      const parsed = askuserDocumentSchema.safeParse(json);
      if (!parsed.success) throw new Error(`askuser.json schema 无效：${parsed.error.issues.map(issue => issue.path.join(".") || "document").join(", ").slice(0, 700)}`);
      await this.assertDownloadAvailable(connection.connectionKey, issueId, rootId);
      return parsed.data;
    } finally { await response.body?.cancel().catch(() => {}); }
  }
  private async issueObject(connection: AuthenticatedConnection, workspace: RemoteWorkspace, issueId: string) {
    return remoteJson(connection, `/api/issues/${encodeURIComponent(issueId)}`, z.object({ id: z.string(), workspace_id: z.string() }), workspace) as Promise<{ id: string; workspace_id: string }>;
  }
  private async assertDownloadAvailable(connectionKey: string, issueId: string, rootId = "main") {
    const issue = (await this.store.read()).connections[connectionKey]?.issues[issueId];
    try { assertAskuserWritable(issue, { connectionKey, issueId, rootId }, this.lifecycle); }
    catch (error) { throw new DeferredAttachment(error instanceof Error ? error.message : "讨论不可用，未下载附件。"); }
  }
  async connectionChanged(current?: { connectionKey: string; userId: string }) {
    if (current ? this.online.size === 1 && this.online.has(current.connectionKey) && this.userIds.get(current.connectionKey) === current.userId : this.online.size === 0) return;
    this.online.clear();
    if (current) { this.online.add(current.connectionKey); this.userIds.set(current.connectionKey, current.userId); }
    const state = await this.store.read();
    for (const [connectionKey, connection] of Object.entries(state.connections)) for (const [issueId, issue] of Object.entries(connection.issues)) this.project(connectionKey, issueId, issue);
  }
  private async checkConnection(connectionKey: string) {
    try { const connection = await this.connection(); if (connection.connectionKey === connectionKey) { this.online.add(connectionKey); this.userIds.set(connectionKey, connection.userId); } else this.online.delete(connectionKey); }
    catch { this.online.delete(connectionKey); }
  }
  async observe(address: CardAddress) {
    await this.checkConnection(address.connectionKey);
    const issue = (await this.store.read()).connections[address.connectionKey]?.issues[address.issueId];
    if (!issue) throw new Error("提问卡片缓存不可用。");
    return bounded(this.data(address, issue));
  }
  private action<T>(address: CardAddress, kind: string, perform: () => Promise<T>): Promise<T> {
    const key = JSON.stringify([address.connectionKey, address.issueId, address.commentId, address.attachmentId]);
    const active = this.actions.get(key);
    if (active) return active.kind === kind ? active.operation as Promise<T> : Promise.reject(new Error("此卡片的其他操作处理中，请稍后重试。"));
    const operation = perform();
    this.actions.set(key, { kind, operation });
    void operation.finally(() => { if (this.actions.get(key)?.operation === operation) this.actions.delete(key); }).catch(() => {});
    return operation;
  }
  async collapsePending(address: Address) {
    await this.store.update(state => {
      const issue = state.connections[address.connectionKey]?.issues[address.issueId];
      for (const card of Object.values(issue?.askuserCards ?? {})) if (card.rootId === address.rootId && card.status === "pending") card.collapsed = true;
    });
    await this.publish(address.connectionKey, address.issueId);
  }
  collapse(address: CardAddress) { return this.action(address, "collapse", () => this.collapseCard(address)); }
  private async collapseCard(address: CardAddress) {
    await this.store.update(state => {
      const card = state.connections[address.connectionKey]?.issues[address.issueId]?.askuserCards?.[cardKey(address.commentId, address.attachmentId)];
      if (!card || card.status !== "pending") throw new Error("提问卡片已解决或不可用。");
      card.collapsed = true;
    });
    await this.publish(address.connectionKey, address.issueId);
  }
  private actionable(address: CardAddress, issue: IssueMapping | undefined, lifecycle: DiscussionLifecycle) {
    if (!issue) throw new Error("提问卡片不可用。");
    const card = this.data(address, issue);
    assertAskuserWritable(issue, { ...address, rootId: card.rootId }, lifecycle);
    if (card.status !== "pending" || card.readOnly) throw new Error(card.readOnlyReason || "提问卡片已解决或不可用。");
    return card;
  }
  private async actionContext(address: CardAddress, lifecycle: DiscussionLifecycle) {
    const connection = await this.connection();
    if (connection.connectionKey !== address.connectionKey) throw new Error("登录身份已变化；请连接原 Multica 身份。");
    this.online.add(connection.connectionKey); this.userIds.set(connection.connectionKey, connection.userId);
    const issue = (await this.store.read()).connections[address.connectionKey]?.issues[address.issueId];
    this.actionable(address, issue, lifecycle);
    const workspaces = await remoteJson(connection, "/api/workspaces", z.array(workspaceSchema)) as RemoteWorkspace[];
    const workspace = workspaces.find(workspace => workspace.id === issue!.remoteWorkspaceId);
    if (!workspace) throw new Error("原 Multica 工作区不可用。");
    const object = await this.issueObject(connection, workspace, address.issueId);
    if (object.id !== address.issueId || object.workspace_id !== workspace.id) throw new Error("任务访问核对返回了其他任务。");
    const verified = await this.resolveStatuses(connection, workspace, address.issueId);
    await this.publish(address.connectionKey, address.issueId);
    if (!verified) throw new Error("无法核对提问卡片当前状态，请稍后重试。");
    this.actionable(address, (await this.store.read()).connections[address.connectionKey]?.issues[address.issueId], lifecycle);
    return { connection, workspace };
  }
  reopen(address: CardAddress, lifecycle: DiscussionLifecycle) { return this.action(address, "reopen", () => this.reopenCard(address, lifecycle)); }
  private async reopenCard(address: CardAddress, lifecycle: DiscussionLifecycle) {
    const { connection } = await this.actionContext(address, lifecycle);
    await connection.assertCurrent?.();
    await this.store.update(state => {
      const issue = state.connections[address.connectionKey]?.issues[address.issueId];
      this.actionable(address, issue, lifecycle);
      delete issue!.askuserCards![cardKey(address.commentId, address.attachmentId)].collapsed;
    });
    await this.publish(address.connectionKey, address.issueId);
    return bounded(this.data(address, (await this.store.read()).connections[address.connectionKey].issues[address.issueId]));
  }
  skip(address: CardAddress, lifecycle: DiscussionLifecycle) { return this.action(address, "skip", () => this.skipCard(address, lifecycle)); }
  private async skipCard(address: CardAddress, lifecycle: DiscussionLifecycle) {
    const issue = (await this.store.read()).connections[address.connectionKey]?.issues[address.issueId];
    const rootId = issue?.askuserCards?.[cardKey(address.commentId, address.attachmentId)]?.rootId;
    if (!rootId) throw new Error("提问卡片不可用。");
    const { connection, workspace } = await this.actionContext(address, lifecycle);
    await connection.assertCurrent?.();
    this.actionable(address, (await this.store.read()).connections[address.connectionKey]?.issues[address.issueId], lifecycle);
    let response: Response;
    try {
      response = await fetch(`${connection.apiUrl}/api/issues/${encodeURIComponent(address.issueId)}/comments/${encodeURIComponent(address.commentId)}/askuser-skip`, {
        method: "POST", headers: { Authorization: `Bearer ${connection.token}`, "X-Workspace-Slug": workspace.slug }, redirect: "error",
        signal: AbortSignal.any([AbortSignal.timeout(10_000), ...(connection.signal ? [connection.signal] : [])]),
      });
    } catch { throw new Error("跳过请求结果未确认（网络或登录上下文已变化）；请先核对远端状态，未标记为已跳过。"); }
    try {
      await connection.assertCurrent?.();
      if (!response.ok) throw new Error(`跳过未确认（HTTP ${response.status}）；卡片保留最后已知状态，请核对后重试。`);
    } finally { await response.body?.cancel().catch(() => {}); }
    // The endpoint's body is not a measured contract. Only timeline observations
    // supply remote timestamps and actor identity; a successful empty body is valid.
    let metadata: z.infer<typeof timelineSchema>[number] | undefined;
    try {
      const entries = await remoteJson(connection, `/api/issues/${encodeURIComponent(address.issueId)}/timeline`, timelineSchema, workspace) as z.infer<typeof timelineSchema>;
      metadata = entries.find(entry => entry.id === address.commentId && entry.askuser_skipped_at?.trim());
    } catch { /* Command success remains known even when metadata cannot be read. */ }
    if (response.status === 202 && !metadata) throw new Error("跳过请求已受理，但未确认远端终态；请先核对远端状态。");
    await this.store.update(state => {
      const record = state.connections[address.connectionKey].issues[address.issueId].askuserCards![cardKey(address.commentId, address.attachmentId)];
      record.status = "skipped"; delete record.collapsed; delete record.statusError;
      if (metadata) { record.skippedAt = metadata.askuser_skipped_at!; record.skippedBy = metadata.askuser_skipped_by ?? undefined; }
    });
    this.deliveries.delete(discoveryKey(address));
    await this.publish(address.connectionKey, address.issueId);
    return bounded(this.data(address, (await this.store.read()).connections[address.connectionKey].issues[address.issueId]));
  }
  submit(address: CardAddress, input: unknown, deliveries: CommentDelivery) {
    return this.action(address, "answer", () => this.submitAnswer(address, input, deliveries));
  }
  private async submitAnswer(address: CardAddress, input: unknown, deliveries: CommentDelivery) {
    await this.checkConnection(address.connectionKey);
    const issue = (await this.store.read()).connections[address.connectionKey]?.issues[address.issueId];
    if (!issue) throw new Error("提问卡片不可用。");
    const card = this.data(address, issue);
    if (card.status !== "pending" || card.readOnly) throw new Error(card.readOnlyReason || "提问卡片已解决。");
    const body = formatAskuserAnswers(card, input);
    const clientMessageId = `${askuserPermissionId(address)}:answer:${randomUUID()}`;
    const id = discoveryKey(address);
    this.deliveries.set(id, { status: "received", clientMessageId });
    let commentId: string;
    try {
      commentId = await deliveries.send({ ...address, rootId: card.rootId }, clientMessageId, body,
        { parent_id: address.commentId, askuser_answer_to: address.commentId });
    } catch (error) {
      this.deliveries.set(id, { status: "failed", clientMessageId, message: error instanceof Error ? error.message : "回答发送失败，请重新回答。" });
      await this.publish(address.connectionKey, address.issueId);
      throw error;
    }
    this.deliveries.set(id, { status: "saved", clientMessageId });
    await this.store.update(state => {
      const stored = state.connections[address.connectionKey].issues[address.issueId].askuserCards![cardKey(address.commentId, address.attachmentId)];
      stored.status = "answered";
      delete stored.collapsed;
      stored.answer = { commentId, content: body, actorId: this.userIds.get(address.connectionKey), actorType: "member" };
    });
    await this.publish(address.connectionKey, address.issueId);
    return { commentId, clientMessageId, body };
  }
  async read(address: CardAddress & { revision: string; offset: number }) {
    const issue = (await this.store.read()).connections[address.connectionKey]?.issues[address.issueId];
    if (!issue) throw new Error("提问卡片缓存不可用。");
    const data = this.data(address, issue);
    // Cache reads do not consult CLI credentials or access the network.
    const text = JSON.stringify(data);
    if (data.revision !== address.revision || address.offset > text.length) throw new Error("提问卡片已变化，请重新读取。");
    const end = Math.min(text.length, address.offset + 8192);
    return { text: text.slice(address.offset, end), nextOffset: end < text.length ? end : null };
  }
  async reset() {
    await Promise.allSettled([...this.pending.values(), ...[...this.actions.values()].map(action => action.operation)]);
    await this.connectionChanged();
    this.fresh.clear(); this.deliveries.clear(); this.userIds.clear(); this.availability.clear();
  }
  async close() { this.unsubscribe(); await Promise.allSettled([...this.pending.values(), ...[...this.actions.values()].map(action => action.operation)]); this.listeners.clear(); this.fresh.clear(); this.deliveries.clear(); }
}
