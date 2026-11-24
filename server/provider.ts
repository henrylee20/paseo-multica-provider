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

const persistenceSchema = z.object({ version: z.literal(1), data: z.object({
  connectionKey: z.string(), issueId: z.string(),
}).and(z.discriminatedUnion("discussion", [z.object({ discussion: z.literal("main") }), z.object({ discussion: z.literal("thread"), rootId: z.string() })])) });
const supported = ["session.persistence", "session.list", "timeline.plugin", "session.archive", "session.unarchive"];

/** A Multica discussion projection, never a local code execution engine. */
export function createMulticaProvider(store: StateStore, threads: ThreadSynchronizer, runs: RunSynchronizer, stops: StopCoordinator, descriptions: TaskDescriptions): ProviderRegistration {
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
      let closed = false;
      const emit = (event: ProviderEvent) => { if (!closed) for (const listener of listeners) listener(event); };
      const emittedRows = new Map<string, Set<string>>();
      const emitRow = (sessionId: string, address: { connectionKey: string; issueId: string; rootId: string }, row: StoredRow, includeOriginal = true) => {
        const emitted = emittedRows.get(sessionId) ?? new Set<string>();
        if (emitted.has(row.id)) return;
        emitted.add(row.id); emittedRows.set(sessionId, emitted);
        const timestamp = row.role === "event" ? row.sourceUpdatedAt ?? row.sourceCreatedAt : row.sourceCreatedAt;
        if (includeOriginal || row.role === "event") emit({ type: "timeline.item", sessionId, item: projectRow(address, row), ...(timestamp && Number.isFinite(Date.parse(timestamp)) ? { timestamp } : {}) });
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
            const projected = new Map<string, string>();
            let activeTurnId: string | undefined;
            const projectRuns = (owned: typeof issue.runs, activity = true) => {
              for (const [runId, run] of Object.entries(owned)) {
                const row = runSummary(address, runId, run);
                const fingerprint = JSON.stringify(row);
                if (projected.get(runId) !== fingerprint) { emit({ type: "timeline.item", sessionId: input.sessionId, item: row }); projected.set(runId, fingerprint); }
              }
              if (!activity) return;
              const active = Object.values(owned).some(run => isActiveRun(run.status));
              if (active && !activeTurnId) {
                activeTurnId = `multica:aggregate:${randomUUID()}`;
                emit({ type: "session.turn", sessionId: input.sessionId, turnId: activeTurnId, state: "started" });
              } else if (!active && activeTurnId) {
                emit({ type: "session.turn", sessionId: input.sessionId, turnId: activeTurnId, state: "completed" });
                activeTurnId = undefined;
              }
            };
            const owned = Object.fromEntries(Object.entries(issue.runs).filter(([, run]) => run.ownerRootId === address.rootId));
            if (input.history === "replay") projectRuns(owned, false);
            else for (const [runId, run] of Object.entries(owned)) projected.set(runId, JSON.stringify(runSummary(address, runId, run)));
            runSubscriptions.set(input.sessionId, runs.subscribe(address, owned => projectRuns(owned)));
            emit({ type: "session.ready", requestId: input.requestId, sessionId: input.sessionId });
            return;
          }
          if (input.type === "session.close") {
            sessions.delete(input.sessionId);
            emittedRows.delete(input.sessionId);
            descriptionSubscriptions.get(input.sessionId)?.(); descriptionSubscriptions.delete(input.sessionId);
            addresses.delete(input.sessionId);
            runSubscriptions.get(input.sessionId)?.(); runSubscriptions.delete(input.sessionId);
            subscriptions.get(input.sessionId)?.(); subscriptions.delete(input.sessionId);
            emit({ type: "session.closed", sessionId: input.sessionId });
            emit({ type: "request.completed", requestId: input.requestId });
            return;
          }
          if (input.type === "session.interrupt") {
            try {
              const address = addresses.get(input.sessionId);
              if (!address) throw new Error("Discussion unavailable");
              await stops.interrupt(address);
              emit({ type: "request.completed", requestId: input.requestId });
            } catch (error) {
              emit({ type: "request.failed", requestId: input.requestId, error: { code: "stop_incomplete", message: error instanceof Error ? error.message : "停止失败，请在管理页重试。" } });
            }
            return;
          }
          if (input.type === "session.archive" || input.type === "session.unarchive") {
            emit({ type: "request.completed", requestId: input.requestId });
            return;
          }
          if (input.type === "session.prompt") {
            emit({ type: "session.prompt_result", sessionId: input.sessionId, clientMessageId: input.prompt.clientMessageId,
              result: { type: "failed", error: { code: "read_only", message: "当前切片只读；评论投递尚未启用。" } } });
            return;
          }
          if ("requestId" in input) emit({ type: "request.failed", requestId: input.requestId, error: { code: "unsupported", message: "此操作尚未支持。" } });
        },
        async close() { for (const unsubscribe of descriptionSubscriptions.values()) unsubscribe(); descriptionSubscriptions.clear(); for (const unsubscribe of runSubscriptions.values()) unsubscribe(); runSubscriptions.clear(); for (const unsubscribe of subscriptions.values()) unsubscribe(); subscriptions.clear(); sessions.clear(); addresses.clear(); listeners.clear(); closed = true; },
      };
    },
  };
}
