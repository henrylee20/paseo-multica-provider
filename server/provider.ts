import { z } from "zod";
import type { ProviderEvent, ProviderRegistration } from "@getpaseo/plugin/server/provider";
import { StateStore } from "./state.js";
import { mainPersistence, providerId } from "./sync.js";
import { projectRow, threadPersistence, type ThreadSynchronizer } from "./threads.js";
import type { StoredRow } from "./thread-state.js";

const persistenceSchema = z.object({ version: z.literal(1), data: z.object({
  connectionKey: z.string(), issueId: z.string(),
}).and(z.discriminatedUnion("discussion", [z.object({ discussion: z.literal("main") }), z.object({ discussion: z.literal("thread"), rootId: z.string() })])) });
const supported = ["session.persistence", "session.list", "timeline.plugin", "session.archive", "session.unarchive"];

/** A Multica discussion projection, never a local code execution engine. */
export function createMulticaProvider(store: StateStore, threads: ThreadSynchronizer): ProviderRegistration {
  return {
    id: providerId, label: "Multica", description: "Multica 任务讨论（目录仅为本地占位目录）",
    status: async () => ({ available: true }),
    async connect(request) {
      if (!request.versions.includes(1)) throw new Error("Unsupported Multica provider protocol");
      const capabilities = supported.filter(value => request.capabilities.includes(value));
      const listeners = new Set<(event: ProviderEvent) => void>();
      const sessions = new Set<string>();
      const subscriptions = new Map<string, () => void>();
      let closed = false;
      const emit = (event: ProviderEvent) => { if (!closed) for (const listener of listeners) listener(event); };
      const emitRow = (sessionId: string, address: { connectionKey: string; issueId: string; rootId: string }, row: StoredRow) => {
        const timestamp = row.role === "event" ? row.sourceUpdatedAt ?? row.sourceCreatedAt : row.sourceCreatedAt;
        emit({ type: "timeline.item", sessionId, item: projectRow(address, row), ...(timestamp && Number.isFinite(Date.parse(timestamp)) ? { timestamp } : {}) });
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
              subscriptions.set(input.sessionId, threads.subscribe(address, row => emitRow(input.sessionId, address, row)));
            } else if (input.history === "replay") emit({ type: "timeline.item", sessionId: input.sessionId, item: {
              type: "notification", level: "info", id: `multica:description:${parsed.data.data.issueId}`, message: `任务描述\n\n${issue.description || "（此任务暂无描述）"}`,
            } });
            if (parsed.data.data.discussion === "main") {
              const address = { connectionKey: parsed.data.data.connectionKey, issueId: parsed.data.data.issueId, rootId: "main" };
              emit({ type: "timeline.item", sessionId: input.sessionId, item: { type: "plugin", id: `multica:thread:main:${address.issueId}`, pluginId: "multica", kind: "thread", version: 1, data: { ...address, title: "任务事件" } } });
              if (input.history === "replay") for (const row of issue.mainHistory.rows) emitRow(input.sessionId, address, row);
              subscriptions.set(input.sessionId, threads.subscribe(address, row => emitRow(input.sessionId, address, row)));
            }
            emit({ type: "session.ready", requestId: input.requestId, sessionId: input.sessionId });
            return;
          }
          if (input.type === "session.close") {
            sessions.delete(input.sessionId);
            subscriptions.get(input.sessionId)?.(); subscriptions.delete(input.sessionId);
            emit({ type: "session.closed", sessionId: input.sessionId });
            emit({ type: "request.completed", requestId: input.requestId });
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
        async close() { for (const unsubscribe of subscriptions.values()) unsubscribe(); subscriptions.clear(); sessions.clear(); listeners.clear(); closed = true; },
      };
    },
  };
}
