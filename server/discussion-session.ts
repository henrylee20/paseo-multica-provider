import { RunProjection } from "./run-projection.js";
import type { RunDetails } from "./run-details.js";
import { askuserPermission, askuserPermissionId, isLocalAskuserDismiss } from "./askuser-answers.js";
import type { AskuserCardData } from "../shared/askuser.js";
import type { AskUsers } from "./askuser.js";
import { randomUUID } from "node:crypto";
import { isActiveRun } from "../shared/runs.js";
import { sourceTime, type RunSynchronizer } from "./runs.js";
import { z } from "zod";
import type { ProviderEvent, ProviderInput, ProviderTimelineItem } from "@getpaseo/plugin/server/provider";
import type { StateStore, IssueMapping } from "./state.js";
import { providerId } from "./discussion-identity.js";
import { taskDescriptionKind, taskDescriptionVersion } from "../shared/description.js";
import { taskDescriptionData, taskDescriptionSummary, type TaskDescriptions } from "./task-description.js";
import { projectRow, projectionHistory, type ThreadSynchronizer } from "./threads.js";
import type { StoredRow } from "./thread-state.js";
import type { StopCoordinator } from "./stops.js";
import type { RunAddress } from "./runs.js";
import type { CommentDelivery } from "./delivery.js";
import type { DiscussionLifecycle } from "./discussion-lifecycle.js";
import type { NativeHost } from "./native-host.js";

export const persistenceSchema = z.object({ version: z.literal(1), data: z.object({
  connectionKey: z.string(), issueId: z.string(),
}).and(z.discriminatedUnion("discussion", [z.object({ discussion: z.literal("main") }), z.object({ discussion: z.literal("thread"), rootId: z.string() })])) });

type OpenInput = Extract<ProviderInput, { type: "session.open" }>;
type Dependencies = {
  store: StateStore;
  threads: ThreadSynchronizer;
  runs: RunSynchronizer;
  runDetails: RunDetails;
  askusers: AskUsers;
  deliveries: CommentDelivery;
  stops: StopCoordinator;
  lifecycle: DiscussionLifecycle;
  descriptions: TaskDescriptions;
  registeredHost?: (agentId: string) => Promise<NativeHost>;
};

type DiscussionState = {
  deps: Dependencies;
  emit: (event: ProviderEvent) => void;
  capabilities: readonly string[];
  input: OpenInput;
  issue: IssueMapping;
  address: RunAddress;
  emittedRows: Set<string>;
  emittedDeliveries: Map<string, string>;
  originalIdentities: Set<string>;
  hasComment: boolean;
  inputComments: Set<string>;
  subscriptions: Array<() => void>;
  interrupts: Set<Promise<void>>;
  permissions: Map<string, AskuserCardData>;
  order?: DiscussionOrder;
  turnId?: string;
  settleInterrupt?: (turnId: string) => void;
};

/** The host appends at first emission: hold attachments and children until their source position. */
class DiscussionOrder {
  private readonly comments = new Set<string>();
  private readonly cards = new Map<string, { item: ProviderTimelineItem; commentId: string; waitingAt: number }>();
  private readonly emittedCards = new Set<string>();
  private readonly waitingRuns = new Map<string, { anchor?: string; waitingAt: number }>();
  private readonly releasedRuns = new Set<string>();
  private completedRefresh = 0;
  private issue: IssueMapping;
  private replayMarkers: boolean;
  constructor(private readonly session: DiscussionState, private readonly projection: RunProjection, private enabled = true) {
    this.issue = session.issue; this.replayMarkers = enabled && session.input.history === "replay";
  }
  activate() { this.enabled = true; this.flush(undefined, true); }
  finishReplay() { this.replayMarkers = false; }
  update(issue: IssueMapping) {
    this.issue = issue;
    for (const [id, run] of Object.entries(issue.runs)) {
      if (run.ownerRootId !== this.session.address.rootId || this.releasedRuns.has(id)) continue;
      const triggerRoot = run.triggerCommentId ? issue.commentRoots[run.triggerCommentId] : undefined;
      const anchor = run.triggerCommentId && (triggerRoot === undefined || triggerRoot === this.session.address.rootId) ? run.triggerCommentId
        : [...new Set([...run.coalescedCommentIds, ...(run.deliveredCommentIds ?? []), ...run.supplementCommentIds])]
        .filter(id => issue.commentRoots[id] === this.session.address.rootId)
        .sort((a, b) => {
          const first = sourceTime(issue.commentCreatedAt[a]) ?? 0n, second = sourceTime(issue.commentCreatedAt[b]) ?? 0n;
          return first < second ? -1 : first > second ? 1 : a.localeCompare(b);
        })[0];
      if (!this.waitingRuns.has(id) || this.waitingRuns.get(id)!.anchor !== anchor)
        this.waitingRuns.set(id, { anchor, waitingAt: this.session.deps.threads.refreshSequence(this.session.address) });
      if (!this.replayMarkers && run.markerProjected) this.releasedRuns.add(id);
    }
    this.flush(undefined, true);
  }
  askuser(item: ProviderTimelineItem, commentId: string) {
    if (this.emittedCards.has(item.id)) { this.emitCard(item); return; }
    this.cards.set(item.id, { item, commentId, waitingAt: this.cards.get(item.id)?.waitingAt ?? this.session.deps.threads.refreshSequence(this.session.address) });
    this.flush();
  }
  beforeRow(row: StoredRow) {
    if (row.id === `multica:comment:${row.commentId}`) this.flush(sourceTime(row.sourceCreatedAt));
  }
  afterRow(row: StoredRow) { this.comments.add(row.commentId); this.flush(); }
  refreshed(sequence: number) { this.completedRefresh = sequence; this.flush(); }
  private flush(before?: bigint, projectUpdates = false) {
    const released = this.releasedRuns.size;
    const history = projectionHistory(this.issue, this.session.address.rootId);
    // Store notifications precede delivery of the rows in that same snapshot.
    const complete = history.historyLoaded && history.rows.every(row => this.session.emittedRows.has(row.id));
    const anchored = (commentId: string, waitingAt: number) => this.comments.has(commentId) || (complete && this.completedRefresh > waitingAt);
    for (const [id, card] of this.cards) {
      if (!anchored(card.commentId, card.waitingAt)) continue;
      this.cards.delete(id); this.emittedCards.add(id); this.emitCard(card.item);
    }
    const candidates = [...this.waitingRuns].filter(([id]) => !this.releasedRuns.has(id)).sort(([a], [b]) => {
      const first = sourceTime(this.issue.runs[a].createdAt), second = sourceTime(this.issue.runs[b].createdAt);
      return first === second ? a.localeCompare(b) : first === undefined ? -1 : second === undefined ? 1 : first < second ? -1 : 1;
    });
    for (const [id, { anchor, waitingAt }] of candidates) {
      if (anchor ? !anchored(anchor, waitingAt) : !history.historyLoaded) continue;
      const time = sourceTime(this.issue.runs[id].createdAt);
      if (time === undefined || complete || (before !== undefined && time < before)) this.releasedRuns.add(id);
    }
    if (projectUpdates || this.releasedRuns.size !== released) this.projectRuns(this.issue, this.releasedRuns);
  }
  private emitCard(item: ProviderTimelineItem) {
    this.session.emit({ type: "timeline.item", sessionId: this.session.input.sessionId, item });
  }
  private projectRuns(latest: IssueMapping, runIds: Iterable<string>) {
    const { deps: { store }, capabilities, address } = this.session;
    if (!this.enabled || !capabilities.includes("session.subsession")) return;
    const markers = this.projection.project(latest, this.replayMarkers, runIds);
    if (!markers.some(runId => !latest.runs[runId].markerProjected)) return;
    void store.update(state => {
      const saved = state.connections[address.connectionKey]?.issues[address.issueId];
      for (const runId of markers) if (saved?.runs[runId]) saved.runs[runId].markerProjected = true;
    }).catch(() => {});
  }
}

/** One opened discussion: local projection, permissions and aggregate activity. */
export class DiscussionSession {
  private readonly state: DiscussionState;
  private released = false;
  private projection?: RunProjection;
  closeChild(sessionId: string) { return this.projection?.closeChild(sessionId) ?? false; }

  static async admit(deps: Pick<Dependencies, "store" | "lifecycle" | "runDetails"> & {
    capabilities: readonly string[]; has: (sessionId: string) => boolean;
  }, input: OpenInput): Promise<{ address: RunAddress; issue: IssueMapping; persistence: z.infer<typeof persistenceSchema> } | Extract<ProviderEvent, { type: "request.failed" }>> {
    const { store, lifecycle, runDetails, capabilities, has } = deps;
    const parsed = persistenceSchema.safeParse(input.persistence);
    const issue = parsed.success ? (await store.read()).connections[parsed.data.data.connectionKey]?.issues[parsed.data.data.issueId] : undefined;
    const openingAddress = parsed.success ? { connectionKey: parsed.data.data.connectionKey, issueId: parsed.data.data.issueId,
      rootId: parsed.data.data.discussion === "thread" ? parsed.data.data.rootId : "main" } : undefined;
    if (openingAddress && lifecycle.unavailable(openingAddress)) {
      return { type: "request.failed", requestId: input.requestId, error: { code: "discussion_unavailable", message: "此隐藏讨论正在核对本地归档状态，请稍后重试。" } };
    }
    if (!parsed.success || !issue || !openingAddress ||
      (parsed.data.data.discussion === "thread" && !issue.threads[parsed.data.data.rootId]) ||
      issue.cwd !== input.config.cwd || has(input.sessionId)) {
      return { type: "request.failed", requestId: input.requestId, error: { code: "unmapped_issue", message: "请在 Multica 设置启用任务工作区后打开已导入的主讨论。" } };
    }
    if (capabilities.includes("session.subsession")) await runDetails.openDiscussion(openingAddress);
    return { address: openingAddress, issue, persistence: parsed.data };
  }

  constructor(deps: Dependencies, emit: (event: ProviderEvent) => void, capabilities: readonly string[], input: OpenInput,
    address: RunAddress, issue: IssueMapping, private readonly persistence: z.infer<typeof persistenceSchema>, private readonly registry: { remove(): void }) {
    const history = address.rootId === "main" ? issue.mainHistory : issue.threads[address.rootId];
    const hasComment = input.history !== "replay" && history.rows.some(row => row.role !== "event");
    this.state = { deps, emit, capabilities, input, address, issue, emittedRows: new Set(), emittedDeliveries: new Map(),
      originalIdentities: new Set(), hasComment, inputComments: new Set(), subscriptions: [], interrupts: new Set(), permissions: new Map() };
  }

  async open() {
    const session = this.state;
    const { deps: { store, threads, runs, runDetails, descriptions, askusers, lifecycle }, input, issue, emit, capabilities } = session;
    const address = session.address;
    emit({ type: "session.opened", requestId: input.requestId, sessionId: input.sessionId, capabilities,
      restoration: "core", persistence: this.persistence, cwd: issue.cwd, title: issue.title,
      description: address.rootId === "main" ? taskDescriptionSummary(issue.description) : `Thread · ${issue.title}` });
    const projection = new RunProjection(input.sessionId, address.rootId, emit, runId => runDetails.get(address, runId));
    this.projection = projection;
    const agentId = address.rootId === "main" ? issue.mainAgentId : issue.threads[address.rootId]?.agentId;
    // Imports need child events in their collected history. Persisted agents
    // instead need live events after the manager has subscribed to the parent.
    const deferred = !!agentId && !!session.deps.registeredHost;
    let live = !deferred, ready = false, activating: Promise<void> | undefined;
    const order = new DiscussionOrder(session, projection, !deferred);
    session.order = order;
    order.update(issue);
    session.subscriptions.push(store.subscribe(state => {
      const latest = state.connections[address.connectionKey]?.issues[address.issueId];
      if (latest) { order.update(latest); this.emitDeliveries(latest); }
    }), runDetails.subscribe(changed => {
      if (changed.connectionKey !== address.connectionKey || changed.issueId !== address.issueId || changed.rootId !== address.rootId) return;
      void store.read().then(state => {
        const latest = state.connections[address.connectionKey]?.issues[address.issueId];
        if (latest && this.isValid()) order.update(latest);
      }).catch(() => {});
    }), () => projection.close());
    let replaying = input.history === "replay";
    const deferredRows: Array<() => void> = [];
    const afterReplay = (deliver: () => void) => { if (replaying) deferredRows.push(deliver); else deliver(); };
    if (this.persistence.data.discussion === "thread") {
      const { connectionKey, issueId, rootId } = this.persistence.data;
      emit({ type: "timeline.item", sessionId: input.sessionId, item: { type: "plugin", id: `multica:thread:${rootId}`, pluginId: "multica", kind: "thread", version: 1,
        data: { connectionKey, issueId, rootId, title: issue.threads[rootId].title } } });
      session.subscriptions.push(threads.subscribe(address, (row, includeOriginal) => afterReplay(() => this.emitRow(row, includeOriginal)), input.history !== "replay", sequence => afterReplay(() => order.refreshed(sequence))));
    } else if (input.history === "replay") emit({ type: "timeline.item", sessionId: input.sessionId, item: {
      type: "plugin", pluginId: providerId, kind: taskDescriptionKind, version: taskDescriptionVersion,
      id: `multica:description:${this.persistence.data.issueId}`,
      data: taskDescriptionData(this.persistence.data.connectionKey, this.persistence.data.issueId, issue.description, issue.overview),
    } });
    if (this.persistence.data.discussion === "main") {
      let revision = input.history === "replay"
        ? JSON.stringify(taskDescriptionData(this.persistence.data.connectionKey, this.persistence.data.issueId, issue.description, issue.overview)) : undefined;
      session.subscriptions.push(descriptions.subscribe(this.persistence.data.connectionKey, this.persistence.data.issueId, data => {
        // The text revision also guards description.read; overview changes still replace this stable row.
        const nextRevision = JSON.stringify(data);
        if (revision === nextRevision) return;
        revision = nextRevision;
        emit({ type: "timeline.item", sessionId: input.sessionId, item: { type: "plugin", pluginId: providerId, kind: taskDescriptionKind, version: taskDescriptionVersion,
          id: `multica:description:${this.persistence.data.issueId}`, data } });
      }));
      emit({ type: "timeline.item", sessionId: input.sessionId, item: { type: "plugin", id: `multica:thread:main:${address.issueId}`, pluginId: "multica", kind: "thread", version: 1, data: { ...address, title: "主讨论" } } });
      session.subscriptions.push(threads.subscribe(address, (row, includeOriginal) => afterReplay(() => this.emitRow(row, includeOriginal)), input.history !== "replay", sequence => afterReplay(() => order.refreshed(sequence))));
    }
    let opening = true;
    const deferredFresh = new Set<string>();
    const projectPermission = (card: AskuserCardData, announceFresh = false) => {
      if (!capabilities.includes("permission")) return;
      const permissionId = askuserPermissionId(card);
      const pending = session.permissions;
      if (card.status === "pending" && !card.collapsed && !card.readOnly && !lifecycle.unavailable(address)) {
        if (askusers.isFresh(card) && opening) { deferredFresh.add(permissionId); askusers.deferFresh(card); }
        // Ready only finishes provider replay. The native manager may still
        // be registering this session until import/listCommands returns.
        if (deferredFresh.has(permissionId) && !announceFresh) return;
        if (!pending.has(permissionId)) {
          pending.set(permissionId, card); emit({ type: "session.permission", sessionId: input.sessionId, request: askuserPermission(card) });
          deferredFresh.delete(permissionId); askusers.projectedFresh(card);
        }
      } else if (pending.delete(permissionId)) emit({ type: "session.permission_resolved", sessionId: input.sessionId, permissionId });
    };
    const projectAskuser = (item: ProviderTimelineItem, card: AskuserCardData, announceFresh: boolean) => {
      order.askuser(item, card.commentId);
      projectPermission(card, announceFresh);
    };
    session.subscriptions.push(askusers.subscribe(address, projectAskuser));
    session.subscriptions.push(lifecycle.subscribe(address, async () => {
      // A Stop accepted before this resource began closing retains its
      // result before session.closed rejects outstanding host requests.
      await Promise.all(session.interrupts);
      if (!this.isValid()) return;
      const turnId = session.turnId;
      // End only this local projection; cached remote Run status and
      // already accepted explicit Stop operations remain independent.
      if (turnId) emit({ type: "session.turn", sessionId: input.sessionId, turnId, state: "completed" });
      this.registry.remove();
      emit({ type: "session.closed", sessionId: input.sessionId });
    }));
    const rows = await askusers.rows(address);
    if (!this.isValid(true)) return;
    for (const item of rows) if (item.type === "plugin") order.askuser(item, (item.data as AskuserCardData).commentId);
    const cards = await askusers.cards(address);
    if (!this.isValid(true)) return;
    for (const card of cards) projectPermission(card);
    const latest = (await store.read()).connections[address.connectionKey]?.issues[address.issueId];
    if (!latest || !this.isValid(true)) return;
    if (input.history === "replay") for (const row of projectionHistory(latest, address.rootId).rows) this.emitRow(row);
    this.emitDeliveries(latest);
    for (const deliver of deferredRows) if (this.isValid()) deliver();
    deferredRows.length = 0;
    replaying = false;
    let currentRuns: typeof issue.runs = {};
    const projectRuns = (owned: typeof issue.runs, activity = true) => {
      currentRuns = owned;
      if (!activity || !live) return;
      const active = Object.values(owned).some(run => isActiveRun(run.status));
      if (active && !session.turnId) {
        session.turnId = `multica:aggregate:${randomUUID()}`;
        emit({ type: "session.turn", sessionId: input.sessionId, turnId: session.turnId, state: "started" });
      } else if (!active && session.turnId) {
        emit({ type: "session.turn", sessionId: input.sessionId, turnId: session.turnId, state: "completed" });
        session.turnId = undefined;
      }
    };
    const owned = Object.fromEntries(Object.entries(issue.runs).filter(([, run]) => run.ownerRootId === address.rootId));
    projectRuns(owned, false);
    session.settleInterrupt = turnId => {
      if (session.turnId !== turnId) return;
      // Stop settles the turn captured by the host, even if later Runs
      // remain active outside its fixed cancellation snapshot.
      emit({ type: "session.turn", sessionId: input.sessionId, turnId, state: "completed" });
      session.turnId = undefined;
      projectRuns(currentRuns);
    };
    const activate = () => {
      if (!ready || live || !this.isValid(true)) return;
      if (!Object.keys(currentRuns).length) return;
      if (activating) return;
      activating = (async () => {
        const host = await session.deps.registeredHost!(agentId!);
        if (!this.isValid(true)) return;
        let latest = (await store.read()).connections[address.connectionKey]?.issues[address.issueId];
        if (!latest) return;
        if (capabilities.includes("session.subsession")) await projection.restore(host, agentId!, latest);
        if (!this.isValid(true)) return;
        latest = (await store.read()).connections[address.connectionKey]?.issues[address.issueId];
        if (!latest) return;
        live = true; order.update(latest); order.activate();
        await runs.observe(address);
      })().catch(() => {}).finally(() => { activating = undefined; });
    };
    session.subscriptions.push(runs.subscribe(address, owned => {
      projectRuns(owned);
      if (!live) activate();
    }));
    emit({ type: "session.ready", requestId: input.requestId, sessionId: input.sessionId });
    opening = false; ready = true; order.finishReplay();
    // Never await a listCommands request inside session.open: it waits for
    // this open to finish registering. Direct unit callers retain the fallback.
    setImmediate(() => { if (this.isValid()) void runs.observe(address).catch(() => {}); });
  }

  async interrupt(input: Extract<ProviderInput, { type: "session.interrupt" }>) {
    const { deps: { stops, askusers, runDetails, lifecycle }, capabilities, emit } = this.state;
    const session = this.state;
    const interruptedTurnId = session.turnId;
    const operation = (async () => {
      try {
        const address = session.address;
        if (lifecycle.unavailable(address)) throw new Error("Discussion unavailable");
        try { await stops.interrupt(address); }
        finally {
          await askusers.collapsePending(address);
          if (capabilities.includes("session.subsession")) await runDetails.refreshOpened();
        }
        if (interruptedTurnId && this.isValid()) session.settleInterrupt?.(interruptedTurnId);
        emit({ type: "request.completed", requestId: input.requestId });
      } catch (error) {
        emit({ type: "request.failed", requestId: input.requestId, error: {
          code: "stop_incomplete", message: error instanceof Error ? error.message : "停止失败，请重试。"
        } });
      }
    })();
    session.interrupts.add(operation);
    try { await operation; }
    finally { session.interrupts.delete(operation); }
  }

  async permission(input: Extract<ProviderInput, { type: "session.permission" }>) {
    const { deps: { lifecycle, askusers, deliveries }, emit } = this.state;
    const session = this.state;
    const card = session.permissions.get(input.permissionId);
    if (!card) throw new Error("提问权限不可用。");
    const address = session.address;
    if (lifecycle.unavailable(address)) throw new Error("讨论不可写。");
    const target = { connectionKey: address.connectionKey, issueId: address.issueId, commentId: card.commentId, attachmentId: card.attachmentId };
    if (input.response.behavior === "deny" || isLocalAskuserDismiss(card, input.response.updatedInput)) { await askusers.collapse(target); return; }
    const record = await askusers.submit(target, input.response.updatedInput, deliveries);
    const row = { id: `multica:comment:${record.commentId}`, role: "user" as const, commentId: record.commentId, clientMessageId: record.clientMessageId, text: record.body };
    if (this.rememberOriginal(row)) {
      this.beforeComment(`multica:divider:input:${record.clientMessageId}`, record.clientMessageId);
      emit({ type: "timeline.item", sessionId: input.sessionId, item: projectRow(address, row) });
    }
    if (session.permissions.delete(input.permissionId)) emit({ type: "session.permission_resolved", sessionId: input.sessionId, permissionId: input.permissionId });
  }

  async prompt(input: Extract<ProviderInput, { type: "session.prompt" }>) {
    const { deps: { store, lifecycle, askusers, deliveries }, emit } = this.state;
    // Admission must keep the captured turn even if network work outlives it.
    const session = this.state;
    const capturedTurnId = session.turnId;
    try {
      const address = session.address;
      if (lifecycle.unavailable(address)) throw new Error("此隐藏讨论正在核对本地归档状态，请稍后重试。");
      const { body, attachments } = await deliveries.prepare(input.prompt);
      const issue = (await store.read()).connections[address.connectionKey]?.issues[address.issueId];
      if (!issue || (address.rootId !== "main" && !issue.threads[address.rootId])) throw new Error("此任务或 Thread 尚未映射。");
      if (!this.isValid(true)) throw new Error("此讨论已关闭，请重新打开后发送。");
      if ("clearPendingPermissions" in input.prompt && input.prompt.clearPendingPermissions === true) await askusers.collapsePending(address);
      this.beforeComment(`multica:divider:input:${input.prompt.clientMessageId}`, input.prompt.clientMessageId);
      emit({ type: "timeline.item", sessionId: input.sessionId, item: {
        type: "user_message", id: `multica:input:${input.prompt.clientMessageId}`, messageId: `multica:input:${input.prompt.clientMessageId}`,
        clientMessageId: input.prompt.clientMessageId, text: body,
      } });
      void deliveries.send(address, input.prompt.clientMessageId, body, {}, attachments).catch(error => emit({ type: "timeline.item", sessionId: input.sessionId, item: {
        type: "error", id: `multica:send-error:${input.prompt.clientMessageId}`, message: error instanceof Error ? error.message : "评论发送失败，请重试。",
      } }));
      emit({ type: "session.prompt_result", sessionId: input.sessionId, clientMessageId: input.prompt.clientMessageId,
        result: input.prompt.delivery === "steer" && capturedTurnId ? { type: "steer", turnId: capturedTurnId } : { type: "completed" } });
    } catch (error) {
      if (input.prompt.delivery === "steer" && capturedTurnId) {
        // The installed adapter turns failed into interrupt+replace.
        // Preserve the captured turn and report the rejected input once.
        emit({ type: "timeline.item", sessionId: input.sessionId, item: { type: "error", id: `multica:input-not-received:${input.prompt.clientMessageId}`,
          message: `未发送远端评论。${error instanceof Error ? error.message : "请重试。"}` } });
        emit({ type: "session.prompt_result", sessionId: input.sessionId, clientMessageId: input.prompt.clientMessageId, result: { type: "steer", turnId: capturedTurnId } });
        return;
      }
      emit({ type: "session.prompt_result", sessionId: input.sessionId, clientMessageId: input.prompt.clientMessageId,
        result: { type: "failed", error: { code: "delivery_not_received", message: error instanceof Error ? error.message : "未发送评论，请重试。" } } });
    }
  }

  release() {
    const { input: { sessionId }, emit, permissions, subscriptions } = this.state;
    for (const permissionId of permissions.keys()) emit({ type: "session.permission_resolved", sessionId, permissionId });
    for (const unsubscribe of subscriptions) unsubscribe();
    this.released = true;
  }

  private isValid(checkAvailability = false) {
    return !this.released && (!checkAvailability || !this.state.deps.lifecycle.unavailable(this.state.address));
  }

  private rememberOriginal(row: StoredRow) {
    const session = this.state;
    const identities = session.originalIdentities;
    const keys = [JSON.stringify([row.role, "comment", row.commentId]),
      ...(row.role === "user" && row.clientMessageId ? [JSON.stringify(["user", "input", row.clientMessageId])] : [])];
    const seen = keys.some(key => identities.has(key));
    for (const key of keys) identities.add(key);
    return !seen;
  }
  private beforeComment(id: string, clientMessageId?: string) {
    const session = this.state;
    const { emit, input: { sessionId } } = session;
    if (!this.isValid() || (clientMessageId && session.inputComments.has(clientMessageId))) return;
    if (session.hasComment) emit({ type: "timeline.item", sessionId, item: {
      type: "plugin", id, pluginId: providerId, kind: "comment-divider", version: 1, data: {},
    } });
    session.hasComment = true;
    if (clientMessageId) session.inputComments.add(clientMessageId);
  }
  private emitDeliveries(issue: IssueMapping) {
    const session = this.state;
    const { emit, input: { sessionId } } = session;
    if (!this.isValid()) return;
    for (const [clientMessageId, saved] of Object.entries(issue.commentInputs)) {
      if (saved.rootId !== session.address.rootId || (saved.rootId !== "main" && !saved.attachments?.length)) continue;
      // Keep the original main-discussion ID, including pre-attachment {} rows.
      const id = saved.rootId === "main" ? `multica:thread-created:${clientMessageId}` : `multica:comment-attachments:${clientMessageId}`;
      const threadTitle = saved.rootId === "main" ? issue.threads[saved.commentId]?.title : undefined;
      const data = { ...(saved.attachments?.length ? { threadCreated: saved.rootId === "main", attachments: saved.attachments } : {}),
        ...(threadTitle ? { threadTitle } : {}) };
      const revision = JSON.stringify(data);
      if (session.emittedDeliveries.get(id) === revision) continue;
      session.emittedDeliveries.set(id, revision);
      emit({ type: "timeline.item", sessionId, item: { type: "plugin", id, pluginId: providerId, kind: "comment-delivery", version: 1,
        data } });
    }
  }
  private emitRow(row: StoredRow, includeOriginal = true) {
    const session = this.state;
    const { emit, input: { sessionId } } = session;
    if (!this.isValid() || session.emittedRows.has(row.id)) return;
    session.order?.beforeRow(row);
    session.emittedRows.add(row.id);
    const timestamp = row.role === "event" ? row.sourceUpdatedAt ?? row.sourceCreatedAt : row.sourceCreatedAt;
    // Canonical recovery acknowledges originals it skips, including native input IDs.
    const firstOriginal = row.role === "event" || this.rememberOriginal(row);
    if (row.role !== "event") {
      if (includeOriginal && firstOriginal) this.beforeComment(`multica:divider:${row.commentId}`, row.clientMessageId);
      else session.hasComment = true;
    }
    if ((includeOriginal && firstOriginal) || row.role === "event")
      emit({ type: "timeline.item", sessionId, item: projectRow(session.address, row),
        ...(timestamp && Number.isFinite(Date.parse(timestamp)) ? { timestamp } : {}) });
    session.order?.afterRow(row);
  }
}
