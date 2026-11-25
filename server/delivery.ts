import { createHash, randomUUID } from "node:crypto";
import { z } from "zod";
import type { ProviderPrompt, ProviderTimelineItem } from "@getpaseo/plugin/server/provider";
import { remoteFetch, type AuthenticatedConnection } from "./connection.js";
import type { DeliveryRecord } from "./delivery-state.js";
import type { RunAddress } from "./runs.js";
import { StateStore } from "./state.js";
import type { StopCoordinator } from "./stops.js";
import { remoteJson, workspaceSchema, type RemoteWorkspace } from "./sync.js";
import { nativeOriginals, hasNativeOriginal } from "./projection-recovery.js";
import type { NativeHost } from "./native-host.js";
import type { StoredRow } from "./thread-state.js";
import { assertAskuserWritable } from "./askuser-policy.js";
import type { DiscussionLifecycle } from "./discussion-lifecycle.js";
import type { IssueMapping } from "./state.js";
import { assertWritableIssue } from "./access.js";

export const deliveryKey = (rootId: string, clientMessageId: string) => createHash("sha256").update(JSON.stringify([rootId, clientMessageId])).digest("hex");
const addressKey = (address: RunAddress) => JSON.stringify([address.connectionKey, address.issueId, address.rootId]);
const receiptSchema = z.object({ id: z.string(), issue_id: z.string(), parent_id: z.string().nullish(), content: z.string(), type: z.literal("comment"), author_type: z.literal("member"), author_id: z.string(),
  askuser_answer_to: z.string().nullish(), created_at: z.string().optional(), updated_at: z.string().optional(), trigger_outcomes: z.array(z.object({ target_type: z.string(), target_id: z.string(), status: z.string(), reason_code: z.string().optional() })).optional(),
});

export function deliveryRow(record: DeliveryRecord): ProviderTimelineItem {
  return { type: "plugin", id: `multica:delivery:${record.idempotencyKey}`, pluginId: "multica", kind: "comment-delivery", version: 1, data: {
    connectionKey: record.connectionKey, issueId: record.issueId, rootId: record.rootId, clientMessageId: record.clientMessageId,
    ...(record.parentCommentId ? { parentCommentId: record.parentCommentId } : {}), ...(record.askuserAnswerTo ? { askuserAnswerTo: record.askuserAnswerTo } : {}),
    idempotencyKey: record.idempotencyKey, createdAt: record.createdAt, status: record.status, body: [...record.body].slice(0, 4000).join(""), truncated: [...record.body].length > 4000,
    ...(record.retryOf ? { retryOf: record.retryOf } : {}), ...(record.commentId ? { commentId: record.commentId } : {}), ...(record.threadRootId ? { threadRootId: record.threadRootId } : {}), ...(record.message ? { message: record.message } : {}),
  } };
}
export function deliveryInput(record: DeliveryRecord): StoredRow {
  return { id: `multica:input:${record.idempotencyKey}`, role: "user", commentId: record.commentId ?? `multica:input:${record.idempotencyKey}`,
    clientMessageId: record.clientMessageId, text: record.body, sourceCreatedAt: record.receipt?.createdAt ?? record.createdAt, sourceUpdatedAt: record.receipt?.updatedAt };
}

/** Durable immutable input and receipt-first recovery within verified service guarantees. */
export class CommentDelivery {
  private readonly listeners = new Map<string, Set<{ deliver(record: DeliveryRecord, includeOriginal?: boolean): void; recovery: boolean }>>();
  private readonly posts = new Map<string, Promise<void>>();
  private readonly operations = new Set<Promise<void>>();
  constructor(private readonly store: StateStore, private readonly connection: () => Promise<AuthenticatedConnection>, private readonly stops: StopCoordinator,
    private readonly onSaved: () => Promise<void>, private readonly now: () => Date = () => new Date(), private readonly onChanged?: (record: DeliveryRecord) => Promise<void>, private readonly lifecycle?: DiscussionLifecycle) {}
  private writable(record: RunAddress & { askuserAnswerTo?: string }, issue: IssueMapping | undefined) {
    assertWritableIssue(issue);
    if (record.askuserAnswerTo) assertAskuserWritable(issue, record, this.lifecycle);
  }
  subscribe(address: RunAddress, deliver: (record: DeliveryRecord, includeOriginal?: boolean) => void, recovery = false) {
    const listener = { deliver, recovery };
    const id = addressKey(address), listeners = this.listeners.get(id) ?? new Set();
    listeners.add(listener); this.listeners.set(id, listeners);
    return () => { listeners.delete(listener); if (!listeners.size) this.listeners.delete(id); };
  }
  private publish(record: DeliveryRecord, includeOriginal = false) { for (const listener of this.listeners.get(addressKey(record)) ?? []) listener.deliver(record, includeOriginal); }
  presentation(record: DeliveryRecord): DeliveryRecord {
    return record.status === "received" && record.claimedAt && !this.posts.has(record.idempotencyKey)
      ? { ...record, status: "pending_verification", message: "上次投递中断，保存结果待核实；将先查询原回执。" } : record;
  }
  async recover(host: NativeHost) {
    for (const [id, listeners] of this.listeners) {
      const recovering = [...listeners].filter(listener => listener.recovery);
      if (!recovering.length) continue;
      const [connectionKey, issueId, rootId] = JSON.parse(id) as string[];
      const issue = (await this.store.read()).connections[connectionKey]?.issues[issueId];
      const agentId = rootId === "main" ? issue?.mainAgentId : issue?.threads[rootId]?.agentId;
      if (!issue || !agentId) continue;
      const records = Object.values(issue.deliveries).filter(record => record.rootId === rootId);
      const entries = records.length ? await nativeOriginals(host, agentId) : [];
      const originals = records.map(record => ({ record: this.presentation(record), includeOriginal: !hasNativeOriginal(entries, deliveryInput(record)) }));
      for (const listener of recovering) {
        for (const { record, includeOriginal } of originals) listener.deliver(record, includeOriginal);
        listener.recovery = false;
      }
    }
  }
  /** Each pass proves the live receipt API using a successful keyed lookup. */
  async reconcile(connection: AuthenticatedConnection, workspace: RemoteWorkspace, issueId: string) {
    const local = (await this.store.read()).connections[connection.connectionKey];
    const issue = local?.issues[issueId];
    if (!issue) return;
    const pending = Object.values(issue.deliveries).filter(record => record.status !== "saved" && record.status !== "failed" && !record.recoveryHalted);
    if (!pending.length) return;
    let proof = false;
    // A first keyed POST is not evidence. Verify an existing immutable receipt
    // against this actual service on every pass that might POST a retry.
    for (const anchor of Object.values(local.issues).filter(candidate => candidate.remoteWorkspaceId === workspace.id).flatMap(candidate => Object.values(candidate.deliveries)).filter(record => record.status === "saved")) {
      if (this.posts.has(anchor.idempotencyKey)) continue;
      if ((await this.lookup(anchor, connection, workspace)).kind === "saved") { proof = true; break; }
    }
    for (const candidate of pending) {
      if (this.posts.has(candidate.idempotencyKey)) continue;
      await this.track(candidate, async () => {
        // Anchor reads may outlive an active POST. Recheck after claiming this
        // key so a stale recovery snapshot cannot overwrite its final receipt.
        const record = await this.record(candidate);
        if (record.status === "saved" || record.status === "failed" || record.recoveryHalted) return;
        const result = await this.lookup(record, connection, workspace);
        if (result.kind === "saved") {
          proof = true;
          await this.finish(record, "saved", "已核实原评论保存；是否执行以独立 Run 状态为准。", result.comment);
        } else if (result.kind === "absent" && !this.withinRetention(record)) {
          await this.halt(record, "已达到 7 天回执保证期限；查无记录不能证明从未发表，请核实后决定重新发送。");
        } else if (result.kind === "absent" && proof && (record.retryCount ?? 0) === 0) {
          await this.perform(record, true, { connection, workspace });
        } else await this.halt(record, result.kind === "absent" ? "未取得可用的服务幂等保证或重试仍无回执；请核实后决定重新发送。" : result.message);
      });
    }
  }
  private withinRetention(record: DeliveryRecord) {
    const age = this.now().getTime() - Date.parse(record.createdAt);
    return age >= 0 && age < 7 * 24 * 60 * 60 * 1000;
  }
  private validKey(record: DeliveryRecord) {
    return !!record.idempotencyKey && record.idempotencyKey.trim() === record.idempotencyKey && Buffer.byteLength(record.idempotencyKey, "utf8") <= 255;
  }
  private matches(record: DeliveryRecord, connection: AuthenticatedConnection, comment: z.infer<typeof receiptSchema>) {
    return comment.issue_id === record.issueId && (comment.parent_id ?? null) === (record.parentCommentId ?? (record.rootId === "main" ? null : record.rootId))
      && (comment.askuser_answer_to === undefined || (comment.askuser_answer_to ?? undefined) === record.askuserAnswerTo)
      && comment.content === record.body && comment.author_id === connection.userId && (!record.commentId || comment.id === record.commentId);
  }
  private async lookup(record: DeliveryRecord, connection: AuthenticatedConnection, workspace: RemoteWorkspace): Promise<
    { kind: "saved"; comment: z.infer<typeof receiptSchema> } | { kind: "absent" } | { kind: "unknown"; message: string }> {
    try {
      if (connection.connectionKey !== record.connectionKey || (record.remoteWorkspaceId && record.remoteWorkspaceId !== workspace.id)) throw new Error("请连接原 Multica 身份与工作区。");
      if (!this.validKey(record)) throw new Error("原请求 key 无效。");
      const query = new URLSearchParams({ type: "comment", ...((record.parentCommentId ?? (record.rootId === "main" ? undefined : record.rootId)) ? { parent_id: record.parentCommentId ?? record.rootId } : {}), ...(record.askuserAnswerTo ? { askuser_answer_to: record.askuserAnswerTo } : {}) });
      const response = await remoteFetch(connection, `/api/issues/${encodeURIComponent(record.issueId)}/comments/idempotent?${query}`, {
        headers: { Authorization: `Bearer ${connection.token}`, "X-Workspace-Slug": workspace.slug, "Idempotency-Key": record.idempotencyKey },
        redirect: "error", signal: AbortSignal.timeout(10_000),
      });
      if (response.ok && response.headers.get("Idempotent-Replayed") === "true") {
        const comment = receiptSchema.parse(await response.json());
        await connection.assertCurrent?.();
        if (this.matches(record, connection, comment)) return { kind: "saved", comment };
      }
      if (response.status === 404) {
        const body = await response.json() as { error?: string };
        await connection.assertCurrent?.();
        if (body.error === "no comment has been posted with this Idempotency-Key") return { kind: "absent" };
      }
      await response.body?.cancel();
      return { kind: "unknown", message: response.status === 409 ? "原评论已删除；不会自动重建，请核实后决定重新发送。" : "服务不支持可核实回执，或回执与原输入冲突；请核实后决定重新发送。" };
    } catch { return { kind: "unknown", message: "回执无法确定；已停止自动重试，请核实原评论。" }; }
  }
  private async halt(record: DeliveryRecord, message: string) {
    await this.finish(record, "pending_verification", message, undefined, true);
  }
  private track(record: DeliveryRecord, action: () => Promise<void>) {
    const existing = this.posts.get(record.idempotencyKey);
    if (existing) return existing;
    const post = Promise.resolve().then(action);
    this.posts.set(record.idempotencyKey, post); this.operations.add(post);
    void post.finally(() => { this.posts.delete(record.idempotencyKey); this.operations.delete(post); }).catch(() => {});
    return post;
  }
  async admit(address: RunAddress, prompt: ProviderPrompt, target: { parentCommentId?: string; askuserAnswerTo?: string } = {}, receivedEpoch?: number): Promise<DeliveryRecord> {
    const body = prompt.input.type === "message" && prompt.input.content.every(part => part.type === "text" && !("mimeType" in part))
      ? prompt.input.content.map(part => part.type === "text" ? part.text : "").join("") : undefined;
    if (body === undefined || !body.trim() || prompt.outputSchema !== undefined) throw new Error("仅支持非空文本评论；请移除附件或结构化输出。 ");
    const stopEpoch = receivedEpoch ?? await this.stops.epoch(address);
    let record!: DeliveryRecord;
    await this.store.update(state => {
      const issue = state.connections[address.connectionKey]?.issues[address.issueId];
      if (!issue || (address.rootId !== "main" && !issue.threads[address.rootId])) throw new Error("请在 Multica 管理页启用任务工作区后打开已导入的讨论。");
      const id = deliveryKey(address.rootId, prompt.clientMessageId);
      const existing = issue.deliveries[id];
      if (existing) {
        if (existing.body !== body || existing.nativeDelivery !== prompt.delivery || existing.parentCommentId !== target.parentCommentId || existing.askuserAnswerTo !== target.askuserAnswerTo) throw new Error("同一输入身份不能改变正文或目标。");
        record = existing; return;
      }
      this.writable({ ...address, ...target }, issue);
      record = issue.deliveries[id] = { ...address, ...target, remoteWorkspaceId: issue.remoteWorkspaceId, clientMessageId: prompt.clientMessageId, idempotencyKey: randomUUID(), body, createdAt: this.now().toISOString(), stopEpoch, nativeDelivery: prompt.delivery, status: "received", retryCount: 0 };
    });
    this.publish(record); return record;
  }
  start(record: DeliveryRecord) {
    const id = record.idempotencyKey;
    if (record.status !== "received" || record.claimedAt || this.posts.has(id)) return;
    const post = this.track(record, () => this.perform(record));
    const operation = post.then(async () => {
      const current = (await this.store.read()).connections[record.connectionKey]?.issues[record.issueId]?.deliveries[deliveryKey(record.rootId, record.clientMessageId)];
      if (current?.status === "saved") await this.onSaved();
    }).catch(() => {}).finally(() => { this.operations.delete(operation); });
    this.operations.add(operation);
  }
  /** Permission responses need the durable outcome, not just background admission. */
  async settle(record: DeliveryRecord) {
    this.start(record);
    await this.posts.get(record.idempotencyKey);
    return this.record(record);
  }
  async waitForPosts() { await Promise.allSettled([...this.posts.values()]); }
  private async perform(record: DeliveryRecord, retry = false, context?: { connection: AuthenticatedConnection; workspace: RemoteWorkspace }) {
    let sent = false;
    try {
      const connection = context?.connection ?? await this.connection();
      if (connection.connectionKey !== record.connectionKey) throw new Error("登录身份已变化；原输入不会转发到新连接。");
      const issue = (await this.store.read()).connections[record.connectionKey]?.issues[record.issueId];
      this.writable(record, issue);
      const workspaces = context ? [context.workspace] : await remoteJson(connection, "/api/workspaces", z.array(workspaceSchema)) as z.infer<typeof workspaceSchema>[];
      const workspace = workspaces.find(workspace => workspace.id === issue.remoteWorkspaceId);
      if (!workspace || (record.remoteWorkspaceId && record.remoteWorkspaceId !== workspace.id)) throw new Error("原 Multica 工作区不可用；不会更改原投递目标。");
      if (!this.validKey(record)) throw new Error("原请求 key 超过服务的 255 字节限制或无效。");
      if (!this.withinRetention(record)) { await this.halt(record, "已达到 7 天回执保证期限或原始时间无法核实；需要用户决定重新发送。"); return; }
      await connection.assertCurrent?.();
      let claimed = false;
      await this.stops.guardDelivery(record, record.stopEpoch, state => {
        this.writable(record, state.connections[record.connectionKey]?.issues[record.issueId]);
        const current = state.connections[record.connectionKey].issues[record.issueId].deliveries[deliveryKey(record.rootId, record.clientMessageId)];
        if (retry ? !["received", "pending_verification"].includes(current.status) || current.recoveryHalted || current.retryCount > 0 : current.status !== "received" || current.claimedAt) return;
        if (!this.withinRetention(current)) throw new Error("已达到 7 天回执保证期限；需要用户核实。");
        if (retry) current.retryCount += 1;
        current.claimedAt ??= this.now().toISOString(); claimed = true;
      });
      if (!claimed) return;
      // No asynchronous gap between the durable Stop fence and issuing POST.
      sent = true;
      const response = await fetch(`${connection.apiUrl}/api/issues/${encodeURIComponent(record.issueId)}/comments`, {
        method: "POST", headers: { Authorization: `Bearer ${connection.token}`, "Content-Type": "application/json", "X-Workspace-Slug": workspace.slug, "Idempotency-Key": record.idempotencyKey },
        body: JSON.stringify({ content: record.body, type: "comment", ...((record.parentCommentId ?? (record.rootId === "main" ? undefined : record.rootId)) ? { parent_id: record.parentCommentId ?? record.rootId } : {}), ...(record.askuserAnswerTo ? { askuser_answer_to: record.askuserAnswerTo } : {}) }), redirect: "error", signal: AbortSignal.any([AbortSignal.timeout(10_000), ...(connection.signal ? [connection.signal] : [])]),
      });
      await connection.assertCurrent?.();
      if (!response.ok) {
        await response.body?.cancel();
        // A server error can follow a committed transaction; it is not proof of absence.
        await this.finish(record, retry || response.status >= 500 || [408, 409, 422].includes(response.status) ? "pending_verification" : "failed", `评论未确认保存（HTTP ${response.status}）；原输入已保留，将先核实回执。`); return;
      }
      const comment = receiptSchema.parse(await response.json());
      await connection.assertCurrent?.();
      if (!this.matches(record, connection, comment)) throw new Error("评论回执与原输入不匹配。");
      await this.finish(record, "saved", "评论已保存；是否开始执行以独立 Run 状态为准。", comment);
    } catch (error) {
      const status = sent || retry ? "pending_verification" : "failed";
      const message = sent ? "响应丢失或回执无法核实；原输入已保留，仅在已核实的去重保证内恢复。" : error instanceof Error ? error.message : "投递失败；原输入已保留。";
      try { if (retry && !sent) await this.halt(record, message); else await this.finish(record, status, message); }
      catch { this.publish({ ...record, status, message: "无法持久保存投递结果；请保留原生输入并核实，不会盲目重发。" }); }
    }
  }
  private async finish(record: DeliveryRecord, status: DeliveryRecord["status"], message: string, comment?: z.infer<typeof receiptSchema>, recoveryHalted = false) {
    let current!: DeliveryRecord;
    await this.store.update(state => {
      current = state.connections[record.connectionKey].issues[record.issueId].deliveries[deliveryKey(record.rootId, record.clientMessageId)];
      Object.assign(current, { status, message, ...(recoveryHalted ? { recoveryHalted: true } : {}), ...(comment ? { commentId: comment.id, threadRootId: record.rootId === "main" ? comment.id : record.rootId,
        receipt: { authorId: comment.author_id, parentId: comment.parent_id ?? null, createdAt: comment.created_at, updatedAt: comment.updated_at, triggerOutcomes: comment.trigger_outcomes } } : {}) });
    });
    this.publish(current);
    // Projection failure cannot invalidate an authoritative saved receipt.
    if (this.onChanged) await this.onChanged(current).catch(() => {});
  }
  private async record(address: RunAddress & { clientMessageId: string }) {
    const record = (await this.store.read()).connections[address.connectionKey]?.issues[address.issueId]?.deliveries[deliveryKey(address.rootId, address.clientMessageId)];
    if (!record) throw new Error("原投递记录不可用。");
    return record;
  }
  private async context(record: DeliveryRecord, writable = true) {
    const issue = (await this.store.read()).connections[record.connectionKey]?.issues[record.issueId];
    if (writable) this.writable(record, issue);
    const connection = await this.connection();
    if (connection.connectionKey !== record.connectionKey) throw new Error("请连接此投递的原 Multica 身份；不会转发到新连接。");
    const workspaces = await remoteJson(connection, "/api/workspaces", z.array(workspaceSchema)) as z.infer<typeof workspaceSchema>[];
    const workspace = workspaces.find(workspace => workspace.id === issue?.remoteWorkspaceId);
    if (!workspace || (record.remoteWorkspaceId && record.remoteWorkspaceId !== workspace.id)) throw new Error("原 Multica 工作区不可用；不会更改原投递目标。");
    return { connection, workspace };
  }
  async verify(address: RunAddress & { clientMessageId: string }) {
    const record = await this.record(address);
    const { connection, workspace } = await this.context(record, false);
    await this.track(record, async () => {
      const result = await this.lookup(record, connection, workspace);
      if (result.kind === "saved") await this.finish(record, "saved", "已核实原评论保存；是否执行以独立 Run 状态为准。", result.comment);
      else await this.halt(record, result.kind === "absent" ? (this.withinRetention(record)
        ? "当前未查到回执；此次核实没有重新发送，请检查远端后明确决定是否重发。"
        : "已达到 7 天回执保证期限；查无记录不能证明从未发表，请检查远端后决定是否重发。") : result.message);
    });
    const current = await this.record(address);
    if (current.status === "saved") await this.onSaved();
    return { status: current.status === "saved" ? "saved" as const : "pending_verification" as const, message: current.message };
  }
  async resend(address: RunAddress & { clientMessageId: string; requestId: string; acknowledgeDuplicateRisk: true }) {
    const original = await this.record(address);
    const receivedEpoch = original.askuserAnswerTo ? await this.stops.epoch(original) : undefined;
    // Revalidate the original identity before accepting a new user-authorized attempt.
    await this.context(original);
    await this.posts.get(original.idempotencyKey);
    const clientMessageId = `multica:resend:${address.requestId}`;
    let next!: DeliveryRecord;
    await this.store.update(state => {
      const issue = state.connections[original.connectionKey].issues[original.issueId];
      this.writable(original, issue);
      const existing = issue.deliveries[deliveryKey(original.rootId, clientMessageId)];
      if (existing) {
        if (existing.retryOf !== original.idempotencyKey) throw new Error("此重发决定已用于另一条输入。");
        next = existing; return;
      }
      const current = issue.deliveries[deliveryKey(original.rootId, original.clientMessageId)];
      if (current.status === "saved") throw new Error("原评论已确认保存，无需重新发送。");
      current.recoveryHalted = true;
      next = issue.deliveries[deliveryKey(original.rootId, clientMessageId)] = {
        connectionKey: original.connectionKey, issueId: original.issueId, rootId: original.rootId, parentCommentId: original.parentCommentId, askuserAnswerTo: original.askuserAnswerTo, remoteWorkspaceId: original.remoteWorkspaceId ?? issue.remoteWorkspaceId,
        clientMessageId, idempotencyKey: randomUUID(), retryOf: original.idempotencyKey, body: original.body,
        createdAt: this.now().toISOString(), stopEpoch: receivedEpoch ?? issue.stopEpochs[original.rootId] ?? 0,
        nativeDelivery: "auto", status: "received", retryCount: 0,
      };
    });
    this.publish(next, true); this.start(next);
    return { clientMessageId: next.clientMessageId, idempotencyKey: next.idempotencyKey };
  }
  async list() {
    const state = await this.store.read();
    return { records: Object.values(state.connections).flatMap(connection => Object.values(connection.issues).flatMap(issue => Object.values(issue.deliveries).map(record => ({
      ...record, body: [...record.body].slice(0, 4000).join(""), truncated: [...record.body].length > 4000,
      ...(record.threadRootId && issue.threads[record.threadRootId]?.agentId ? { threadAgentId: issue.threads[record.threadRootId].agentId } : {}),
      // A claimed request left across a crash has no authoritative save receipt.
      status: this.presentation(record).status, message: this.presentation(record).message,
    })))) };
  }
  async read(address: RunAddress & { clientMessageId: string; offset: number }) {
    const record = (await this.store.read()).connections[address.connectionKey]?.issues[address.issueId]?.deliveries[deliveryKey(address.rootId, address.clientMessageId)];
    if (!record || address.offset > record.body.length) throw new Error("原输入不可用。");
    const text = record.body.slice(address.offset, address.offset + 8192), next = address.offset + text.length;
    return { text, nextOffset: next < record.body.length ? next : null };
  }
  async targets() { const state = await this.store.read(); return { issues: Object.entries(state.connections).flatMap(([connectionKey, connection]) => Object.entries(connection.issues).filter(([, issue]) => issue.access?.status !== "inaccessible").map(([issueId, issue]) => ({ connectionKey, issueId, title: issue.title }))) }; }
  async mentions(address: { connectionKey: string; issueId: string }) {
    const issue = (await this.store.read()).connections[address.connectionKey]?.issues[address.issueId];
    assertWritableIssue(issue);
    const connection = await this.connection();
    if (!issue || connection.connectionKey !== address.connectionKey) throw new Error("请连接此讨论的原 Multica 身份。");
    const workspaces = await remoteJson(connection, "/api/workspaces", z.array(workspaceSchema)) as z.infer<typeof workspaceSchema>[];
    const workspace = workspaces.find(workspace => workspace.id === issue.remoteWorkspaceId);
    if (!workspace) throw new Error("Multica 工作区不可用。");
    const agents = await remoteJson(connection, `/api/agents?workspace_id=${encodeURIComponent(workspace.id)}&include_archived=true`, z.array(z.object({ id: z.string(), name: z.string(), archived_at: z.string().nullish() })), workspace) as Array<{ id: string; name: string; archived_at?: string | null }>;
    return { agents: agents.filter(agent => !agent.archived_at && z.uuid().safeParse(agent.id).success).map(agent => ({ id: agent.id, name: agent.name, reference: `[@${agent.name.replace(/[\\\[\]]/g, "\\$&")}](mention://agent/${agent.id})` })) };
  }
  async close() { await Promise.allSettled(this.operations); this.listeners.clear(); }
}
