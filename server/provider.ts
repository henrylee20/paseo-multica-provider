import { askuserPermission, askuserPermissionId, isLocalAskuserDismiss } from "./askuser-answers.js";
import type { AskuserCardData } from "../shared/askuser.js";
import type { AskUsers } from "./askuser.js";
import { randomUUID } from "node:crypto";
import { isActiveRun, runSummary, type RunSynchronizer } from "./runs.js";
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
import { deliveryRow, deliveryInput, type CommentDelivery } from "./delivery.js";
import type { DiscussionLifecycle } from "./discussion-lifecycle.js";

const persistenceSchema = z.object({ version: z.literal(1), data: z.object({
  connectionKey: z.string(), issueId: z.string(),
}).and(z.discriminatedUnion("discussion", [z.object({ discussion: z.literal("main") }), z.object({ discussion: z.literal("thread"), rootId: z.string() })])) });
const supported = ["prompt.message", "prompt.steer", "session.persistence", "session.list", "timeline.plugin", "session.archive", "session.unarchive", "permission"];

/** A Multica discussion projection, never a local code execution engine. */
export function createMulticaProvider(store: StateStore, threads: ThreadSynchronizer, runs: RunSynchronizer, stops: StopCoordinator, deliveries: CommentDelivery, descriptions: TaskDescriptions, lifecycle: DiscussionLifecycle, askusers: AskUsers): ProviderRegistration {
  return {
    id: providerId, label: "Multica", description: "Multica 任务讨论（目录仅为本地占位目录）",
    status: async () => ({ available: true }),
    async connect(request) {
      if (!request.versions.includes(1)) throw new Error("Unsupported Multica provider protocol");
      const capabilities = supported.filter(value => request.capabilities.includes(value));
      const listeners = new Set<(event: ProviderEvent) => void>();
      const sessions = new Set<string>();
      const addresses = new Map<string, RunAddress>();
      const runSubscriptions = new Map<string, () => void>();
      const descriptionSubscriptions = new Map<string, () => void>();
      const subscriptions = new Map<string, () => void>();
      const permissions = new Map<string, Map<string, AskuserCardData>>();
      const askuserSubscriptions = new Map<string, () => void>();
      const deliverySubscriptions = new Map<string, () => void>();
      const activeTurns = new Map<string, string>();
      const lifecycleSubscriptions = new Map<string, () => void>();
      const acceptedInterrupts = new Map<string, Set<Promise<void>>>();
      const interruptSettlements = new Map<string, (turnId: string) => void>();
      let closed = false;
      const emit = (event: ProviderEvent) => { if (!closed) for (const listener of listeners) listener(event); };
      const releaseSession = (sessionId: string) => {
        for (const permissionId of permissions.get(sessionId)?.keys() ?? []) emit({ type: "session.permission_resolved", sessionId, permissionId });
        permissions.delete(sessionId);
        askuserSubscriptions.get(sessionId)?.(); askuserSubscriptions.delete(sessionId);
        sessions.delete(sessionId);
        emittedRows.delete(sessionId);
        originalIdentities.delete(sessionId);
        descriptionSubscriptions.get(sessionId)?.(); descriptionSubscriptions.delete(sessionId);
        addresses.delete(sessionId);
        activeTurns.delete(sessionId);
        interruptSettlements.delete(sessionId);
        deliverySubscriptions.get(sessionId)?.(); deliverySubscriptions.delete(sessionId);
        runSubscriptions.get(sessionId)?.(); runSubscriptions.delete(sessionId);
        subscriptions.get(sessionId)?.(); subscriptions.delete(sessionId);
        lifecycleSubscriptions.get(sessionId)?.(); lifecycleSubscriptions.delete(sessionId);
      };
      const emittedRows = new Map<string, Set<string>>();
      const originalIdentities = new Map<string, Set<string>>();
      const rememberOriginal = (sessionId: string, row: StoredRow) => {
        const identities = originalIdentities.get(sessionId) ?? new Set<string>();
        const keys = [JSON.stringify([row.role, "comment", row.commentId]),
          ...(row.role === "user" && row.clientMessageId ? [JSON.stringify(["user", "input", row.clientMessageId])] : [])];
        const seen = keys.some(key => identities.has(key));
        for (const key of keys) identities.add(key);
        originalIdentities.set(sessionId, identities);
        return !seen;
      };
      const emitRow = (sessionId: string, address: { connectionKey: string; issueId: string; rootId: string }, row: StoredRow, includeOriginal = true) => {
        const emitted = emittedRows.get(sessionId) ?? new Set<string>();
        if (emitted.has(row.id)) return;
        emitted.add(row.id); emittedRows.set(sessionId, emitted);
        const timestamp = row.role === "event" ? row.sourceUpdatedAt ?? row.sourceCreatedAt : row.sourceCreatedAt;
        // Cached comments and durable inputs can be two representations of one
        // original. Canonical recovery also acknowledges originals it skips.
        const firstOriginal = row.role === "event" || rememberOriginal(sessionId, row);
        if ((includeOriginal && firstOriginal) || row.role === "event") emit({ type: "timeline.item", sessionId, item: projectRow(address, row), ...(timestamp && Number.isFinite(Date.parse(timestamp)) ? { timestamp } : {}) });
        if (row.role !== "event") emit({ type: "timeline.item", sessionId, item: {
          type: "plugin", id: `multica:comment-source:${row.commentId}`, pluginId: "multica", kind: "comment-event", version: 1,
          data: { ...address, recordId: row.id, commentId: row.commentId, category: "source", truncated: false,
            text: row.sourceCreatedAt || row.sourceUpdatedAt ? "首次读取时的来源记录。" : "远端记录未提供来源时间。",
            ...(row.sourceCreatedAt ? { sourceCreatedAt: row.sourceCreatedAt } : {}), ...(row.sourceUpdatedAt ? { sourceUpdatedAt: row.sourceUpdatedAt } : {}),
          },
        } });
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
              Object.entries(connection.issues).filter(([, issue]) => issue.access?.status !== "inaccessible").flatMap(([issueId, issue]) => [{
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
            if (!parsed.success || !issue || (parsed.data.data.discussion === "thread" && !issue.threads[parsed.data.data.rootId]) || issue.cwd !== input.config.cwd || sessions.has(input.sessionId)) {
              emit({ type: "request.failed", requestId: input.requestId, error: { code: "unmapped_issue", message: "请在 Multica 管理页启用任务工作区后打开已导入的主讨论。" } });
              return;
            }
            sessions.add(input.sessionId);
            emit({ type: "session.opened", requestId: input.requestId, sessionId: input.sessionId, capabilities,
              restoration: "core", persistence: parsed.data, cwd: issue.cwd, title: issue.title, description: issue.description });
            if (parsed.data.data.discussion === "thread") {
              const { connectionKey, issueId, rootId } = parsed.data.data;
              emit({ type: "timeline.item", sessionId: input.sessionId, item: { type: "plugin", id: `multica:thread:${rootId}`, pluginId: "multica", kind: "thread", version: 1,
                data: { connectionKey, issueId, rootId, title: issue.threads[rootId].title } } });
              const address = { connectionKey, issueId, rootId };
              if (input.history === "replay") for (const row of issue.threads[rootId].rows) emitRow(input.sessionId, address, row);
              subscriptions.set(input.sessionId, threads.subscribe(address, (row, includeOriginal) => emitRow(input.sessionId, address, row, includeOriginal), input.history !== "replay"));
            } else if (input.history === "replay") emit({ type: "timeline.item", sessionId: input.sessionId, item: {
              type: "plugin", pluginId: providerId, kind: taskDescriptionKind, version: taskDescriptionVersion,
              id: `multica:description:${parsed.data.data.issueId}`,
              data: taskDescriptionData(parsed.data.data.connectionKey, parsed.data.data.issueId, issue.description),
            } });
            if (parsed.data.data.discussion === "main") {
              let revision = input.history === "replay" ? taskDescriptionData(parsed.data.data.connectionKey, parsed.data.data.issueId, issue.description).revision : undefined;
              descriptionSubscriptions.set(input.sessionId, descriptions.subscribe(parsed.data.data.connectionKey, parsed.data.data.issueId, data => {
                if (revision === data.revision) return;
                revision = data.revision;
                emit({ type: "timeline.item", sessionId: input.sessionId, item: { type: "plugin", pluginId: providerId, kind: taskDescriptionKind, version: taskDescriptionVersion,
                  id: `multica:description:${parsed.data.data.issueId}`, data } });
              }));
              const address = { connectionKey: parsed.data.data.connectionKey, issueId: parsed.data.data.issueId, rootId: "main" };
              emit({ type: "timeline.item", sessionId: input.sessionId, item: { type: "plugin", id: `multica:thread:main:${address.issueId}`, pluginId: "multica", kind: "thread", version: 1, data: { ...address, title: "任务事件" } } });
              if (input.history === "replay") for (const row of issue.mainHistory.rows) emitRow(input.sessionId, address, row);
              subscriptions.set(input.sessionId, threads.subscribe(address, (row, includeOriginal) => emitRow(input.sessionId, address, row, includeOriginal), input.history !== "replay"));
            }
            const address = { connectionKey: parsed.data.data.connectionKey, issueId: parsed.data.data.issueId, rootId: parsed.data.data.discussion === "thread" ? parsed.data.data.rootId : "main" };
            addresses.set(input.sessionId, address);
            let opening = true;
            const deferredFresh = new Set<string>();
            const projectPermission = (card: AskuserCardData, announceFresh = false) => {
              if (!capabilities.includes("permission")) return;
              const permissionId = askuserPermissionId(card);
              const pending = permissions.get(input.sessionId) ?? new Map();
              permissions.set(input.sessionId, pending);
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
            askuserSubscriptions.set(input.sessionId, askusers.subscribe(address, projectAskuser));
            for (const item of await askusers.rows(address)) emit({ type: "timeline.item", sessionId: input.sessionId, item });
            for (const card of await askusers.cards(address)) projectPermission(card);
            lifecycleSubscriptions.set(input.sessionId, lifecycle.subscribe(address, async () => {
              // A Stop accepted before this resource began closing retains its
              // result before session.closed rejects outstanding host requests.
              await Promise.all([...(acceptedInterrupts.get(input.sessionId) ?? [])]);
              if (!sessions.has(input.sessionId)) return;
              const turnId = activeTurns.get(input.sessionId);
              // End only this local projection; cached remote Run status and
              // already accepted explicit Stop operations remain independent.
              if (turnId) emit({ type: "session.turn", sessionId: input.sessionId, turnId, state: "completed" });
              releaseSession(input.sessionId);
              emit({ type: "session.closed", sessionId: input.sessionId });
            }));
            const projectDelivery = (record: (typeof issue.deliveries)[string], includeOriginal = false) => {
              emit({ type: "timeline.item", sessionId: input.sessionId, item: deliveryRow(record) });
              const row = deliveryInput(record);
              if (includeOriginal && rememberOriginal(input.sessionId, row)) emit({ type: "timeline.item", sessionId: input.sessionId, item: projectRow(address, row) });
            };
            for (const record of Object.values(issue.deliveries).filter(record => record.rootId === address.rootId)) projectDelivery(deliveries.presentation(record), input.history === "replay");
            deliverySubscriptions.set(input.sessionId, deliveries.subscribe(address, projectDelivery, input.history !== "replay"));
            const projected = new Map<string, string>();
            let activeTurnId: string | undefined;
            let currentRuns: typeof issue.runs = {};
            const projectRuns = (owned: typeof issue.runs, activity = true) => {
              currentRuns = owned;
              for (const [runId, run] of Object.entries(owned)) {
                const row = runSummary(address, runId, run);
                const fingerprint = JSON.stringify(row);
                if (projected.get(runId) !== fingerprint) { emit({ type: "timeline.item", sessionId: input.sessionId, item: row }); projected.set(runId, fingerprint); }
              }
              if (!activity) return;
              const active = Object.values(owned).some(run => isActiveRun(run.status));
              if (active && !activeTurnId) {
                activeTurnId = `multica:aggregate:${randomUUID()}`;
                activeTurns.set(input.sessionId, activeTurnId);
                emit({ type: "session.turn", sessionId: input.sessionId, turnId: activeTurnId, state: "started" });
              } else if (!active && activeTurnId) {
                emit({ type: "session.turn", sessionId: input.sessionId, turnId: activeTurnId, state: "completed" });
                activeTurnId = undefined;
                activeTurns.delete(input.sessionId);
              }
            };
            const owned = Object.fromEntries(Object.entries(issue.runs).filter(([, run]) => run.ownerRootId === address.rootId));
            if (input.history === "replay") projectRuns(owned, false);
            else for (const [runId, run] of Object.entries(owned)) projected.set(runId, JSON.stringify(runSummary(address, runId, run)));
            interruptSettlements.set(input.sessionId, turnId => {
              if (activeTurnId !== turnId) return;
              // Stop settles the turn captured by the host, even if later Runs
              // remain active outside its fixed cancellation snapshot.
              emit({ type: "session.turn", sessionId: input.sessionId, turnId, state: "completed" });
              activeTurnId = undefined;
              activeTurns.delete(input.sessionId);
              projectRuns(currentRuns);
            });
            runSubscriptions.set(input.sessionId, runs.subscribe(address, owned => projectRuns(owned)));
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
            const interruptedTurnId = activeTurns.get(input.sessionId);
            const operation = (async () => {
              try {
                const address = addresses.get(input.sessionId);
                if (!address || lifecycle.unavailable(address)) throw new Error("Discussion unavailable");
                try { await stops.interrupt(address); }
                finally { await askusers.collapsePending(address); }
                if (interruptedTurnId) interruptSettlements.get(input.sessionId)?.(interruptedTurnId);
                emit({ type: "request.completed", requestId: input.requestId });
              } catch (error) {
                emit({ type: "request.failed", requestId: input.requestId, error: { code: "stop_incomplete", message: error instanceof Error ? error.message : "停止失败，请在管理页重试。" } });
              }
            })();
            const accepted = acceptedInterrupts.get(input.sessionId) ?? new Set();
            accepted.add(operation); acceptedInterrupts.set(input.sessionId, accepted);
            try { await operation; }
            finally { accepted.delete(operation); if (!accepted.size) acceptedInterrupts.delete(input.sessionId); }
            return;
          }
          if (input.type === "session.archive" || input.type === "session.unarchive") {
            emit({ type: "request.completed", requestId: input.requestId });
            return;
          }
          if (input.type === "session.permission") {
            const card = permissions.get(input.sessionId)?.get(input.permissionId);
            if (!card) throw new Error("提问权限不可用。");
            const address = addresses.get(input.sessionId);
            if (!address || lifecycle.unavailable(address)) throw new Error("讨论不可写。");
            const target = { connectionKey: address.connectionKey, issueId: address.issueId, commentId: card.commentId, attachmentId: card.attachmentId };
            if (input.response.behavior === "deny" || isLocalAskuserDismiss(card, input.response.updatedInput)) { await askusers.collapse(target); return; }
            const record = await askusers.submit(target, input.response.updatedInput, deliveries);
            const row = deliveryInput(record);
            if (rememberOriginal(input.sessionId, row)) emit({ type: "timeline.item", sessionId: input.sessionId, item: projectRow(address, row) });
            if (permissions.get(input.sessionId)?.delete(input.permissionId)) emit({ type: "session.permission_resolved", sessionId: input.sessionId, permissionId: input.permissionId });
            return;
          }
          if (input.type === "session.prompt") {
            // Capture before awaiting durability: returning a replacement cycle's ID
            // violates the host's actual changed-turn admission guard.
            const capturedTurnId = activeTurns.get(input.sessionId);
            try {
              const address = addresses.get(input.sessionId);
              if (!address) throw new Error("请在 Multica 管理页启用任务工作区后打开已导入的讨论。");
              if (lifecycle.unavailable(address)) throw new Error("此隐藏讨论正在核对本地归档状态，请稍后重试。");
              const record = await deliveries.admit(address, input.prompt);
              // Newer hosts may request local permission clearing on chat. This
              // is local collapse only; the prompt remains an ordinary comment.
              if ("clearPendingPermissions" in input.prompt && input.prompt.clearPendingPermissions === true) await askusers.collapsePending(address);
              emit({ type: "timeline.item", sessionId: input.sessionId, item: projectRow(address, deliveryInput(record)) });
              emit({ type: "session.prompt_result", sessionId: input.sessionId, clientMessageId: input.prompt.clientMessageId,
                result: input.prompt.delivery === "steer" && capturedTurnId ? { type: "steer", turnId: capturedTurnId } : { type: "completed" } });
              deliveries.start(record);
            } catch (error) {
              if (input.prompt.delivery === "steer" && capturedTurnId) {
                // The installed adapter turns failed into interrupt+replace.
                // This acknowledgement only keeps the existing host turn; the
                // explicit error states that no durable admission took place.
                emit({ type: "timeline.item", sessionId: input.sessionId, item: { type: "error", id: `multica:input-not-received:${input.prompt.clientMessageId}`,
                  message: `插件未能持久接收此输入；未发送远端评论。${error instanceof Error ? error.message : "请保留原生输入，核实存储或输入格式后重新发送。"}` } });
                emit({ type: "session.prompt_result", sessionId: input.sessionId, clientMessageId: input.prompt.clientMessageId, result: { type: "steer", turnId: capturedTurnId } });
                return;
              }
              emit({ type: "session.prompt_result", sessionId: input.sessionId, clientMessageId: input.prompt.clientMessageId,
                result: { type: "failed", error: { code: "delivery_not_received", message: error instanceof Error ? error.message : "未能持久接收输入。" } } });
            }
            return;
          }
          if ("requestId" in input) emit({ type: "request.failed", requestId: input.requestId, error: { code: "unsupported", message: "此操作尚未支持。" } });
        },
        async close() { for (const sessionId of [...sessions]) releaseSession(sessionId); listeners.clear(); closed = true; },
      };
    },
  };
}
