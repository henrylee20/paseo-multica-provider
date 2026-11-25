import { askuserPermission, askuserPermissionId, isLocalAskuserDismiss } from "./askuser-answers.js";
import type { AskuserCardData } from "../shared/askuser.js";
import type { AskUsers } from "./askuser.js";
import { randomUUID } from "node:crypto";
import { isActiveRun } from "../shared/runs.js";
import { runSummary, type RunSynchronizer } from "./runs.js";
import { z } from "zod";
import type { ProviderEvent, ProviderRegistration } from "@getpaseo/plugin/server/provider";
import { StateStore } from "./state.js";
import { mainPersistence, providerId } from "./sync.js";
import { taskDescriptionKind, taskDescriptionVersion } from "../shared/description.js";
import { taskDescriptionData, type TaskDescriptions } from "./task-description.js";
import { projectRow, threadPersistence, type ThreadSynchronizer } from "./threads.js";
import type { StoredRow } from "./thread-state.js";
import type { StopCoordinator } from "./stops.js";
import type { RunAddress } from "./runs.js";
import type { CommentDelivery } from "./delivery.js";
import type { DiscussionLifecycle } from "./discussion-lifecycle.js";

const persistenceSchema = z.object({ version: z.literal(1), data: z.object({
  connectionKey: z.string(), issueId: z.string(),
}).and(z.discriminatedUnion("discussion", [z.object({ discussion: z.literal("main") }), z.object({ discussion: z.literal("thread"), rootId: z.string() })])) });
const supported = ["prompt.message", "prompt.steer", "session.persistence", "session.list", "timeline.plugin", "session.archive", "session.unarchive", "permission"];

interface SessionContext {
  address: RunAddress;
  emittedRows: Set<string>;
  originalIdentities: Set<string>;
  subscriptions: Array<() => void>;
  interrupts: Set<Promise<void>>;
  permissions: Map<string, AskuserCardData>;
  turnId?: string;
  settleInterrupt?: (turnId: string) => void;
}

/** A Multica discussion projection, never a local code execution engine. */
export function createMulticaProvider(store: StateStore, threads: ThreadSynchronizer, runs: RunSynchronizer, stops: StopCoordinator, deliveries: CommentDelivery, descriptions: TaskDescriptions, lifecycle: DiscussionLifecycle, askusers: AskUsers): ProviderRegistration {
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
      const emitRow = (sessionId: string, row: StoredRow, includeOriginal = true) => {
        const session = sessions.get(sessionId);
        if (!session || session.emittedRows.has(row.id)) return;
        session.emittedRows.add(row.id);
        const timestamp = row.role === "event" ? row.sourceUpdatedAt ?? row.sourceCreatedAt : row.sourceCreatedAt;
        // Canonical recovery acknowledges originals it skips, including native input IDs.
        const firstOriginal = row.role === "event" || rememberOriginal(session, row);
        if ((includeOriginal && firstOriginal) || row.role === "event")
          emit({ type: "timeline.item", sessionId, item: projectRow(session.address, row),
            ...(timestamp && Number.isFinite(Date.parse(timestamp)) ? { timestamp } : {}) });
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
            const session: SessionContext = { address: openingAddress, emittedRows: new Set(), originalIdentities: new Set(), subscriptions: [], interrupts: new Set(), permissions: new Map() };
            sessions.set(input.sessionId, session);
            const address = session.address;
            emit({ type: "session.opened", requestId: input.requestId, sessionId: input.sessionId, capabilities,
              restoration: "core", persistence: parsed.data, cwd: issue.cwd, title: issue.title, description: issue.description });
            if (parsed.data.data.discussion === "thread") {
              const { connectionKey, issueId, rootId } = parsed.data.data;
              emit({ type: "timeline.item", sessionId: input.sessionId, item: { type: "plugin", id: `multica:thread:${rootId}`, pluginId: "multica", kind: "thread", version: 1,
                data: { connectionKey, issueId, rootId, title: issue.threads[rootId].title } } });
              if (input.history === "replay") for (const row of issue.threads[rootId].rows) emitRow(input.sessionId, row);
              session.subscriptions.push(threads.subscribe(address, (row, includeOriginal) => emitRow(input.sessionId, row, includeOriginal), input.history !== "replay"));
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
              if (input.history === "replay") for (const row of issue.mainHistory.rows) emitRow(input.sessionId, row);
              session.subscriptions.push(threads.subscribe(address, (row, includeOriginal) => emitRow(input.sessionId, row, includeOriginal), input.history !== "replay"));
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
              emit({ type: "timeline.item", sessionId: input.sessionId, item });
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
            for (const item of rows) emit({ type: "timeline.item", sessionId: input.sessionId, item });
            const cards = await askusers.cards(address);
            if (sessions.get(input.sessionId) !== session || lifecycle.unavailable(address)) return;
            for (const card of cards) projectPermission(card);
            const projected = new Map<string, string>();
            let currentRuns: typeof issue.runs = {};
            const projectRuns = (owned: typeof issue.runs, activity = true) => {
              currentRuns = owned;
              for (const [runId, run] of Object.entries(owned)) {
                const row = runSummary(address, runId, run);
                const fingerprint = JSON.stringify(row);
                if (projected.get(runId) !== fingerprint) {
                  emit({ type: "timeline.item", sessionId: input.sessionId, item: row });
                  projected.set(runId, fingerprint);
                }
              }
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
            if (input.history === "replay") projectRuns(owned, false);
            else for (const [runId, run] of Object.entries(owned)) projected.set(runId, JSON.stringify(runSummary(address, runId, run)));
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
                finally { await askusers.collapsePending(address); }
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
            if (rememberOriginal(session, row)) emit({ type: "timeline.item", sessionId: input.sessionId, item: projectRow(address, row) });
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
              const body = input.prompt.input.type === "message" && input.prompt.input.content.every(part => part.type === "text" && !("mimeType" in part))
                ? input.prompt.input.content.map(part => part.type === "text" ? part.text : "").join("") : undefined;
              if (!body?.trim() || input.prompt.outputSchema !== undefined) throw new Error("仅支持非空文本评论，请移除附件或结构化输出。");
              const issue = (await store.read()).connections[address.connectionKey]?.issues[address.issueId];
              if (!issue || (address.rootId !== "main" && !issue.threads[address.rootId])) throw new Error("此任务或 Thread 尚未映射。");
              if ("clearPendingPermissions" in input.prompt && input.prompt.clearPendingPermissions === true) await askusers.collapsePending(address);
              emit({ type: "timeline.item", sessionId: input.sessionId, item: {
                type: "user_message", id: `multica:input:${input.prompt.clientMessageId}`, messageId: `multica:input:${input.prompt.clientMessageId}`,
                clientMessageId: input.prompt.clientMessageId, text: body,
              } });
              void deliveries.send(address, input.prompt.clientMessageId, body).then(() => {
                if (address.rootId === "main") emit({ type: "timeline.item", sessionId: input.sessionId, item: {
                  type: "plugin", id: `multica:thread-created:${input.prompt.clientMessageId}`, pluginId: "multica", kind: "comment-delivery", version: 1, data: {},
                } });
              }).catch(error => emit({ type: "timeline.item", sessionId: input.sessionId, item: {
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
