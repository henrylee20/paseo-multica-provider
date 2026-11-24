import { z } from "zod";
import type { ProviderEvent, ProviderRegistration } from "@getpaseo/plugin/server/provider";
import { StateStore } from "./state.js";
import { mainPersistence, providerId } from "./sync.js";

const persistenceSchema = z.object({ version: z.literal(1), data: z.object({
  connectionKey: z.string(), issueId: z.string(), discussion: z.literal("main"),
}) });
const supported = ["session.persistence", "session.list"];

/** A Multica discussion projection, never a local code execution engine. */
export function createMulticaProvider(store: StateStore): ProviderRegistration {
  return {
    id: providerId, label: "Multica", description: "Multica 任务讨论（目录仅为本地占位目录）",
    status: async () => ({ available: true }),
    async connect(request) {
      if (!request.versions.includes(1)) throw new Error("Unsupported Multica provider protocol");
      const capabilities = supported.filter(value => request.capabilities.includes(value));
      const listeners = new Set<(event: ProviderEvent) => void>();
      const sessions = new Set<string>();
      let closed = false;
      const emit = (event: ProviderEvent) => { if (!closed) for (const listener of listeners) listener(event); };
      return {
        version: 1, capabilities,
        onEvent(listener) { listeners.add(listener); return () => { listeners.delete(listener); }; },
        async send(input) {
          if (closed) throw new Error("Provider connection closed");
          if (input.type === "catalog") { emit({ type: "catalog", requestId: input.requestId, catalog: { models: [], modes: [] } }); return; }
          if (input.type === "sessions") {
            const state = await store.read();
            const entries = Object.entries(state.connections).flatMap(([connectionKey, connection]) =>
              Object.entries(connection.issues).map(([issueId, issue]) => ({
                persistence: mainPersistence(connectionKey, issueId), cwd: issue.cwd, title: issue.title,
                description: issue.description, updatedAt: issue.updatedAt,
              })));
            emit({ type: "sessions", requestId: input.requestId, sessions: entries.filter(issue =>
              (!input.cwd || issue.cwd === input.cwd) && (!input.query || issue.title.toLowerCase().includes(input.query.toLowerCase())))
              .slice(0, input.limit ?? entries.length) });
            return;
          }
          if (input.type === "session.open") {
            const parsed = persistenceSchema.safeParse(input.persistence);
            const issue = parsed.success ? (await store.read()).connections[parsed.data.data.connectionKey]?.issues[parsed.data.data.issueId] : undefined;
            if (!parsed.success || !issue || issue.cwd !== input.config.cwd || sessions.has(input.sessionId)) {
              emit({ type: "request.failed", requestId: input.requestId, error: { code: "unmapped_issue", message: "请在 Multica 管理页启用任务工作区后打开已导入的主讨论。" } });
              return;
            }
            sessions.add(input.sessionId);
            emit({ type: "session.opened", requestId: input.requestId, sessionId: input.sessionId, capabilities,
              restoration: "core", persistence: parsed.data, cwd: issue.cwd, title: issue.title, description: issue.description });
            if (input.history === "replay") emit({ type: "timeline.item", sessionId: input.sessionId, item: {
              type: "notification", level: "info", id: `multica:description:${parsed.data.data.issueId}`, message: `任务描述\n\n${issue.description || "（此任务暂无描述）"}`,
            } });
            emit({ type: "session.ready", requestId: input.requestId, sessionId: input.sessionId });
            return;
          }
          if (input.type === "session.close") {
            sessions.delete(input.sessionId);
            emit({ type: "session.closed", sessionId: input.sessionId });
            emit({ type: "request.completed", requestId: input.requestId });
            return;
          }
          if (input.type === "session.prompt") {
            emit({ type: "session.prompt_result", sessionId: input.sessionId, clientMessageId: input.prompt.clientMessageId,
              result: { type: "failed", error: { code: "read_only", message: "当前切片仅支持读取任务描述。" } } });
            return;
          }
          if ("requestId" in input) emit({ type: "request.failed", requestId: input.requestId, error: { code: "unsupported", message: "此操作尚未支持。" } });
        },
        async close() { sessions.clear(); listeners.clear(); closed = true; },
      };
    },
  };
}
