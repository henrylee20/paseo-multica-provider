import { RunProjection } from "./run-projection.js";
import type { RunDetails } from "./run-details.js";
import { askuserPermission, askuserPermissionId, isLocalAskuserDismiss } from "./askuser-answers.js";
import type { AskuserCardData } from "../shared/askuser.js";
import type { AskUsers } from "./askuser.js";
import { randomUUID } from "node:crypto";
import { isActiveRun } from "../shared/runs.js";
import { sourceTime, type RunSynchronizer } from "./runs.js";
import { z } from "zod";
import type { ProviderEvent, ProviderRegistration, ProviderTimelineItem } from "@getpaseo/plugin/server/provider";
import { StateStore, type IssueMapping } from "./state.js";
import { mainPersistence, providerId } from "./sync.js";
import { taskDescriptionKind, taskDescriptionVersion } from "../shared/description.js";
import { taskDescriptionData, type TaskDescriptions } from "./task-description.js";
import { projectRow, projectionHistory, threadPersistence, type ThreadSynchronizer } from "./threads.js";
import type { StoredRow } from "./thread-state.js";
import type { StopCoordinator } from "./stops.js";
import type { RunAddress } from "./runs.js";
import type { CommentDelivery } from "./delivery.js";
import type { DiscussionLifecycle } from "./discussion-lifecycle.js";

const persistenceSchema = z.object({ version: z.literal(1), data: z.object({
  connectionKey: z.string(), issueId: z.string(),
}).and(z.discriminatedUnion("discussion", [z.object({ discussion: z.literal("main") }), z.object({ discussion: z.literal("thread"), rootId: z.string() })])) });
const supported = ["prompt.message", "prompt.image", "prompt.steer", "session.persistence", "session.subsession", "session.list", "timeline.plugin", "session.archive", "session.unarchive", "permission"];

/** The host appends at first emission: hold attachments and children until their source position. */
class DiscussionOrder {
  private readonly comments = new Set<string>();
  private readonly cards = new Map<string, { item: ProviderTimelineItem; commentId: string; waitingAt: number }>();
  private readonly emittedCards = new Set<string>();
  private readonly waitingRuns = new Map<string, { anchor?: string; waitingAt: number }>();
  private readonly releasedRuns = new Set<string>();
  private completedRefresh = 0;
  constructor(private issue: IssueMapping, private readonly rootId: string, private readonly emittedRows: Set<string>,
    private readonly refreshSequence: () => number, private readonly replayMarkers: boolean,
    private readonly projectRuns: (issue: IssueMapping, runIds: Iterable<string>) => void,
    private readonly emitCard: (item: ProviderTimelineItem) => void) {}
  update(issue: IssueMapping) {
    this.issue = issue;
    for (const [id, run] of Object.entries(issue.runs)) {
      if (run.ownerRootId !== this.rootId || this.releasedRuns.has(id)) continue;
      const triggerRoot = run.triggerCommentId ? issue.commentRoots[run.triggerCommentId] : undefined;
      const anchor = run.triggerCommentId && (triggerRoot === undefined || triggerRoot === this.rootId) ? run.triggerCommentId
        : [...new Set([...run.coalescedCommentIds, ...(run.deliveredCommentIds ?? []), ...run.supplementCommentIds])]
        .filter(id => issue.commentRoots[id] === this.rootId)
        .sort((a, b) => {
          const first = sourceTime(issue.commentCreatedAt[a]) ?? 0n, second = sourceTime(issue.commentCreatedAt[b]) ?? 0n;
          return first < second ? -1 : first > second ? 1 : a.localeCompare(b);
        })[0];
      if (!this.waitingRuns.has(id) || this.waitingRuns.get(id)!.anchor !== anchor)
        this.waitingRuns.set(id, { anchor, waitingAt: this.refreshSequence() });
      if (!this.replayMarkers && run.markerProjected) this.releasedRuns.add(id);
    }
    this.flush(undefined, true);
  }
  askuser(item: ProviderTimelineItem, commentId: string) {
    if (this.emittedCards.has(item.id)) { this.emitCard(item); return; }
    this.cards.set(item.id, { item, commentId, waitingAt: this.cards.get(item.id)?.waitingAt ?? this.refreshSequence() });
    this.flush();
  }
  beforeRow(row: StoredRow) {
    if (row.id === `multica:comment:${row.commentId}`) this.flush(sourceTime(row.sourceCreatedAt));
  }
  afterRow(row: StoredRow) { this.comments.add(row.commentId); this.flush(); }
  refreshed(sequence: number) { this.completedRefresh = sequence; this.flush(); }
  private flush(before?: bigint, projectUpdates = false) {
    const released = this.releasedRuns.size;
    const history = projectionHistory(this.issue, this.rootId);
    // Store notifications precede delivery of the rows in that same snapshot.
    const complete = history.historyLoaded && history.rows.every(row => this.emittedRows.has(row.id));
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
}

interface SessionContext {
  address: RunAddress;
  emittedRows: Set<string>;
  originalIdentities: Set<string>;
  hasComment: boolean;
  inputComments: Set<string>;
  subscriptions: Array<() => void>;
  interrupts: Set<Promise<void>>;
  permissions: Map<string, AskuserCardData>;
  order?: DiscussionOrder;
  turnId?: string;
  settleInterrupt?: (turnId: string) => void;
}

/** A Multica discussion projection, never a local code execution engine. */
export function createMulticaProvider(store: StateStore, threads: ThreadSynchronizer, runs: RunSynchronizer, stops: StopCoordinator, deliveries: CommentDelivery, descriptions: TaskDescriptions, lifecycle: DiscussionLifecycle, askusers: AskUsers, runDetails: RunDetails, onUnarchive?: () => void): ProviderRegistration {
  return {
    id: providerId, label: "Multica", description: "Multica 任务讨论（目录仅为本地占位目录）",
    status: async () => ({ available: true }),
    async connect(request) {
      if (!request.versions.includes(1)) throw new Error("Unsupported Multica provider protocol");
      const capabilities = supported.filter(value => request.capabilities.includes(value));
      const listeners = new Set<(event: ProviderEvent) => void>();
      const sessions = new Map<string, SessionContext>();
      let closed = false;
      const emit = (event: ProviderEvent) => { if (!closed) for (const listener of listeners) listener(event); };
      const releaseSession = (sessionId: string) => {
        const session = sessions.get(sessionId);
        for (const permissionId of session?.permissions.keys() ?? []) emit({ type: "session.permission_resolved", sessionId, permissionId });
        sessions.delete(sessionId);
        for (const unsubscribe of session?.subscriptions ?? []) unsubscribe();
      };
      const rememberOriginal = (session: SessionContext, row: StoredRow) => {
        const identities = session.originalIdentities;
        const keys = [JSON.stringify([row.role, "comment", row.commentId]),
          ...(row.role === "user" && row.clientMessageId ? [JSON.stringify(["user", "input", row.clientMessageId])] : [])];
        const seen = keys.some(key => identities.has(key));
        for (const key of keys) identities.add(key);
        return !seen;
      };
      const beforeComment = (sessionId: string, id: string, clientMessageId?: string) => {
        const session = sessions.get(sessionId);
        if (!session || (clientMessageId && session.inputComments.has(clientMessageId))) return;
        if (session.hasComment) emit({ type: "timeline.item", sessionId, item: {
          type: "plugin", id, pluginId: providerId, kind: "comment-divider", version: 1, data: {},
        } });
        session.hasComment = true;
        if (clientMessageId) session.inputComments.add(clientMessageId);
      };
      const emitDeliveries = (sessionId: string, issue: IssueMapping) => {
        const session = sessions.get(sessionId);
        if (!session) return;
        for (const [clientMessageId, saved] of Object.entries(issue.commentInputs)) {
          if (saved.rootId !== session.address.rootId || (saved.rootId !== "main" && !saved.attachments?.length)) continue;
          // Keep the original main-discussion ID, including pre-attachment {} rows.
          const id = saved.rootId === "main" ? `multica:thread-created:${clientMessageId}` : `multica:comment-attachments:${clientMessageId}`;
          if (session.emittedRows.has(id)) continue;
          session.emittedRows.add(id);
          emit({ type: "timeline.item", sessionId, item: { type: "plugin", id, pluginId: providerId, kind: "comment-delivery", version: 1,
            data: saved.attachments?.length ? { threadCreated: saved.rootId === "main", attachments: saved.attachments } : {} } });
        }
      };
      const emitRow = (sessionId: string, row: StoredRow, includeOriginal = true) => {
        const session = sessions.get(sessionId);
        if (!session || session.emittedRows.has(row.id)) return;
        session.order?.beforeRow(row);
        session.emittedRows.add(row.id);
        const timestamp = row.role === "event" ? row.sourceUpdatedAt ?? row.sourceCreatedAt : row.sourceCreatedAt;
        // Canonical recovery acknowledges originals it skips, including native input IDs.
        const firstOriginal = row.role === "event" || rememberOriginal(session, row);
        if (row.role !== "event") {
          if (includeOriginal && firstOriginal) beforeComment(sessionId, `multica:divider:${row.commentId}`, row.clientMessageId);
          else session.hasComment = true;
        }
        if ((includeOriginal && firstOriginal) || row.role === "event")
          emit({ type: "timeline.item", sessionId, item: projectRow(session.address, row),
            ...(timestamp && Number.isFinite(Date.parse(timestamp)) ? { timestamp } : {}) });
        session.order?.afterRow(row);
      };
      return {
        version: 1, capabilities,
        onEvent(listener) { listeners.add(listener); return () => { listeners.delete(listener); }; },
        async send(input) {
          if (closed) throw new Error("Provider connection closed");
          if (input.type === "catalog") { emit({ type: "catalog", requestId: input.requestId, catalog: { models: [], modes: [] } }); return; }
          if (input.type === "sessions") {
            const state = await store.read();
            const entries = Object.entries(state.connections).flatMap(([connectionKey, connection]) =>
              Object.entries(connection.issues).flatMap(([issueId, issue]) => [{
                persistence: mainPersistence(connectionKey, issueId), cwd: issue.cwd, title: issue.title,
                description: issue.description, updatedAt: issue.updatedAt,
              }, ...Object.entries(issue.threads).map(([rootId, thread]) => ({ persistence: threadPersistence(connectionKey, issueId, rootId), cwd: issue.cwd, title: thread.title,
                description: `Thread · ${issue.title}`, updatedAt: issue.updatedAt }))]));
            emit({ type: "sessions", requestId: input.requestId, sessions: entries.filter(issue =>
              (!input.cwd || issue.cwd === input.cwd) && (!input.query || issue.title.toLowerCase().includes(input.query.toLowerCase())))
              .slice(0, input.limit ?? entries.length) });
            return;
          }
          if (input.type === "session.open") {
            const parsed = persistenceSchema.safeParse(input.persistence);
            const issue = parsed.success ? (await store.read()).connections[parsed.data.data.connectionKey]?.issues[parsed.data.data.issueId] : undefined;
            const openingAddress = parsed.success ? { connectionKey: parsed.data.data.connectionKey, issueId: parsed.data.data.issueId,
              rootId: parsed.data.data.discussion === "thread" ? parsed.data.data.rootId : "main" } : undefined;
            if (openingAddress && lifecycle.unavailable(openingAddress)) {
              emit({ type: "request.failed", requestId: input.requestId, error: { code: "discussion_unavailable", message: "此隐藏讨论正在核对本地归档状态，请稍后重试。" } });
              return;
            }
            if (!parsed.success || !issue || !openingAddress ||
              (parsed.data.data.discussion === "thread" && !issue.threads[parsed.data.data.rootId]) ||
              issue.cwd !== input.config.cwd || sessions.has(input.sessionId)) {
              emit({ type: "request.failed", requestId: input.requestId, error: { code: "unmapped_issue", message: "请在 Multica 设置启用任务工作区后打开已导入的主讨论。" } });
              return;
            }
            if (capabilities.includes("session.subsession")) await runDetails.openDiscussion(openingAddress);
            if (lifecycle.unavailable(openingAddress)) {
              emit({ type: "request.failed", requestId: input.requestId, error: { code: "discussion_unavailable", message: "此讨论正在清理本地状态，请稍后重试。" } });
              return;
            }
            const history = openingAddress.rootId === "main" ? issue.mainHistory : issue.threads[openingAddress.rootId];
            const hasComment = input.history !== "replay" && history.rows.some(row => row.role !== "event");
            const session: SessionContext = { address: openingAddress, emittedRows: new Set(), originalIdentities: new Set(), hasComment, inputComments: new Set(), subscriptions: [], interrupts: new Set(), permissions: new Map() };
            sessions.set(input.sessionId, session);
            const address = session.address;
            emit({ type: "session.opened", requestId: input.requestId, sessionId: input.sessionId, capabilities,
              restoration: "core", persistence: parsed.data, cwd: issue.cwd, title: issue.title, description: issue.description });
            const projection = new RunProjection(input.sessionId, address.rootId, emit, runId => runDetails.get(address, runId));
            const order = new DiscussionOrder(issue, address.rootId, session.emittedRows, () => threads.refreshSequence(address), input.history === "replay", (latest, runIds) => {
              if (!capabilities.includes("session.subsession")) return;
              const markers = projection.project(latest, input.history === "replay", runIds);
              if (!markers.some(runId => !latest.runs[runId].markerProjected)) return;
              void store.update(state => {
                const saved = state.connections[address.connectionKey]?.issues[address.issueId];
                for (const runId of markers) if (saved?.runs[runId]) saved.runs[runId].markerProjected = true;
              }).catch(() => {});
            }, item => emit({ type: "timeline.item", sessionId: input.sessionId, item }));
            session.order = order;
            order.update(issue);
            session.subscriptions.push(store.subscribe(state => {
              const latest = state.connections[address.connectionKey]?.issues[address.issueId];
              if (latest) { order.update(latest); emitDeliveries(input.sessionId, latest); }
            }), runDetails.subscribe(changed => {
              if (changed.connectionKey !== address.connectionKey || changed.issueId !== address.issueId || changed.rootId !== address.rootId) return;
              void store.read().then(state => {
                const latest = state.connections[address.connectionKey]?.issues[address.issueId];
                if (latest && sessions.get(input.sessionId) === session) order.update(latest);
              }).catch(() => {});
            }), () => projection.close());
            let replaying = input.history === "replay";
            const deferredRows: Array<() => void> = [];
            const afterReplay = (deliver: () => void) => { if (replaying) deferredRows.push(deliver); else deliver(); };
            if (parsed.data.data.discussion === "thread") {
              const { connectionKey, issueId, rootId } = parsed.data.data;
              emit({ type: "timeline.item", sessionId: input.sessionId, item: { type: "plugin", id: `multica:thread:${rootId}`, pluginId: "multica", kind: "thread", version: 1,
                data: { connectionKey, issueId, rootId, title: issue.threads[rootId].title } } });
              session.subscriptions.push(threads.subscribe(address, (row, includeOriginal) => afterReplay(() => emitRow(input.sessionId, row, includeOriginal)), input.history !== "replay", sequence => afterReplay(() => order.refreshed(sequence))));
            } else if (input.history === "replay") emit({ type: "timeline.item", sessionId: input.sessionId, item: {
              type: "plugin", pluginId: providerId, kind: taskDescriptionKind, version: taskDescriptionVersion,
              id: `multica:description:${parsed.data.data.issueId}`,
              data: taskDescriptionData(parsed.data.data.connectionKey, parsed.data.data.issueId, issue.description),
            } });
            if (parsed.data.data.discussion === "main") {
              let revision = input.history === "replay"
                ? taskDescriptionData(parsed.data.data.connectionKey, parsed.data.data.issueId, issue.description).revision : undefined;
              session.subscriptions.push(descriptions.subscribe(parsed.data.data.connectionKey, parsed.data.data.issueId, data => {
                if (revision === data.revision) return;
                revision = data.revision;
                emit({ type: "timeline.item", sessionId: input.sessionId, item: { type: "plugin", pluginId: providerId, kind: taskDescriptionKind, version: taskDescriptionVersion,
                  id: `multica:description:${parsed.data.data.issueId}`, data } });
              }));
              emit({ type: "timeline.item", sessionId: input.sessionId, item: { type: "plugin", id: `multica:thread:main:${address.issueId}`, pluginId: "multica", kind: "thread", version: 1, data: { ...address, title: "主讨论" } } });
              session.subscriptions.push(threads.subscribe(address, (row, includeOriginal) => afterReplay(() => emitRow(input.sessionId, row, includeOriginal)), input.history !== "replay", sequence => afterReplay(() => order.refreshed(sequence))));
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
            const projectAskuser = (item: import("@getpaseo/plugin/server/provider").ProviderTimelineItem, card: AskuserCardData, announceFresh: boolean) => {
              order.askuser(item, card.commentId);
              projectPermission(card, announceFresh);
            };
            session.subscriptions.push(askusers.subscribe(address, projectAskuser));
            session.subscriptions.push(lifecycle.subscribe(address, async () => {
              // A Stop accepted before this resource began closing retains its
              // result before session.closed rejects outstanding host requests.
              await Promise.all(session.interrupts);
              if (sessions.get(input.sessionId) !== session) return;
              const turnId = session.turnId;
              // End only this local projection; cached remote Run status and
              // already accepted explicit Stop operations remain independent.
              if (turnId) emit({ type: "session.turn", sessionId: input.sessionId, turnId, state: "completed" });
              releaseSession(input.sessionId);
              emit({ type: "session.closed", sessionId: input.sessionId });
            }));
            const rows = await askusers.rows(address);
            if (sessions.get(input.sessionId) !== session || lifecycle.unavailable(address)) return;
            for (const item of rows) if (item.type === "plugin") order.askuser(item, (item.data as AskuserCardData).commentId);
            const cards = await askusers.cards(address);
            if (sessions.get(input.sessionId) !== session || lifecycle.unavailable(address)) return;
            for (const card of cards) projectPermission(card);
            const latest = (await store.read()).connections[address.connectionKey]?.issues[address.issueId];
            if (sessions.get(input.sessionId) !== session || !latest || lifecycle.unavailable(address)) return;
            if (input.history === "replay") for (const row of projectionHistory(latest, address.rootId).rows) emitRow(input.sessionId, row);
            emitDeliveries(input.sessionId, latest);
            for (const deliver of deferredRows) if (sessions.get(input.sessionId) === session) deliver();
            deferredRows.length = 0;
            replaying = false;
            let currentRuns: typeof issue.runs = {};
            const projectRuns = (owned: typeof issue.runs, activity = true) => {
              currentRuns = owned;
              if (!activity) return;
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
            session.subscriptions.push(runs.subscribe(address, owned => projectRuns(owned)));
            emit({ type: "session.ready", requestId: input.requestId, sessionId: input.sessionId });
            opening = false;
            // Native registration completes after session.ready / importAgent returns.
            setImmediate(() => { if (sessions.get(input.sessionId) === session) void runs.observe(address).catch(() => {}); });
            return;
          }
          if (input.type === "session.close") {
            releaseSession(input.sessionId);
            emit({ type: "session.closed", sessionId: input.sessionId });
            emit({ type: "request.completed", requestId: input.requestId });
            return;
          }
          if (input.type === "session.interrupt") {
            const session = sessions.get(input.sessionId);
            const interruptedTurnId = session?.turnId;
            const operation = (async () => {
              try {
                const address = session?.address;
                if (!address || lifecycle.unavailable(address)) throw new Error("Discussion unavailable");
                try { await stops.interrupt(address); }
                finally {
                  await askusers.collapsePending(address);
                  if (capabilities.includes("session.subsession")) await runDetails.refreshOpened();
                }
                if (interruptedTurnId && sessions.get(input.sessionId) === session) session?.settleInterrupt?.(interruptedTurnId);
                emit({ type: "request.completed", requestId: input.requestId });
              } catch (error) {
                emit({ type: "request.failed", requestId: input.requestId, error: {
                  code: "stop_incomplete", message: error instanceof Error ? error.message : "停止失败，请重试。"
                } });
              }
            })();
            session?.interrupts.add(operation);
            try { await operation; }
            finally { session?.interrupts.delete(operation); }
            return;
          }
          if (input.type === "session.archive" || input.type === "session.unarchive") {
            emit({ type: "request.completed", requestId: input.requestId });
            if (input.type === "session.unarchive") {
              const parsed = persistenceSchema.safeParse(input.persistence);
              if (parsed.success) {
                const address = { connectionKey: parsed.data.data.connectionKey, issueId: parsed.data.data.issueId,
                  rootId: parsed.data.data.discussion === "thread" ? parsed.data.data.rootId : "main" };
                if (!lifecycle.unavailable(address)) onUnarchive?.();
              }
            }
            return;
          }
          if (input.type === "session.permission") {
            const session = sessions.get(input.sessionId);
            const card = session?.permissions.get(input.permissionId);
            if (!card) throw new Error("提问权限不可用。");
            const address = session?.address;
            if (!address || lifecycle.unavailable(address)) throw new Error("讨论不可写。");
            const target = { connectionKey: address.connectionKey, issueId: address.issueId, commentId: card.commentId, attachmentId: card.attachmentId };
            if (input.response.behavior === "deny" || isLocalAskuserDismiss(card, input.response.updatedInput)) { await askusers.collapse(target); return; }
            const record = await askusers.submit(target, input.response.updatedInput, deliveries);
            const row = { id: `multica:comment:${record.commentId}`, role: "user" as const, commentId: record.commentId, clientMessageId: record.clientMessageId, text: record.body };
            if (rememberOriginal(session, row)) {
              beforeComment(input.sessionId, `multica:divider:input:${record.clientMessageId}`, record.clientMessageId);
              emit({ type: "timeline.item", sessionId: input.sessionId, item: projectRow(address, row) });
            }
            if (session.permissions.delete(input.permissionId)) emit({ type: "session.permission_resolved", sessionId: input.sessionId, permissionId: input.permissionId });
            return;
          }
          if (input.type === "session.prompt") {
            // Admission must keep the captured turn even if network work outlives it.
            const session = sessions.get(input.sessionId);
            const capturedTurnId = session?.turnId;
            try {
              const address = session?.address;
              if (!address) throw new Error("请在 Multica 设置启用任务工作区后打开已导入的讨论。");
              if (lifecycle.unavailable(address)) throw new Error("此隐藏讨论正在核对本地归档状态，请稍后重试。");
              const { body, attachments } = await deliveries.prepare(input.prompt);
              const issue = (await store.read()).connections[address.connectionKey]?.issues[address.issueId];
              if (!issue || (address.rootId !== "main" && !issue.threads[address.rootId])) throw new Error("此任务或 Thread 尚未映射。");
              if (sessions.get(input.sessionId) !== session || lifecycle.unavailable(address)) throw new Error("此讨论已关闭，请重新打开后发送。");
              if ("clearPendingPermissions" in input.prompt && input.prompt.clearPendingPermissions === true) await askusers.collapsePending(address);
              beforeComment(input.sessionId, `multica:divider:input:${input.prompt.clientMessageId}`, input.prompt.clientMessageId);
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
            return;
          }
          if ("requestId" in input) emit({ type: "request.failed", requestId: input.requestId, error: { code: "unsupported", message: "此操作尚未支持。" } });
        },
        async close() { for (const sessionId of sessions.keys()) releaseSession(sessionId); listeners.clear(); closed = true; },
      };
    },
  };
}
