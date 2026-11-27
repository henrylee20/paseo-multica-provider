import type { ProviderEvent, ProviderRegistration } from "@getpaseo/plugin/server/provider";
import type { StateStore } from "./state.js";
import type { ThreadSynchronizer } from "./threads.js";
import type { RunSynchronizer } from "./runs.js";
import type { RunDetails } from "./run-details.js";
import type { StopCoordinator } from "./stops.js";
import type { CommentDelivery } from "./delivery.js";
import type { DiscussionLifecycle } from "./discussion-lifecycle.js";
import type { AskUsers } from "./askuser.js";
import { taskDescriptionSummary, type TaskDescriptions } from "./task-description.js";
import { mainPersistence, providerId, threadPersistence } from "./discussion-identity.js";
import { DiscussionSession, persistenceSchema } from "./discussion-session.js";

const supported = ["prompt.message", "prompt.image", "prompt.steer", "session.persistence", "session.subsession", "session.list", "timeline.plugin", "session.archive", "session.unarchive", "permission"];

/** A Multica discussion projection, never a local code execution engine. */
export function createMulticaProvider(store: StateStore, threads: ThreadSynchronizer, runs: RunSynchronizer, stops: StopCoordinator, deliveries: CommentDelivery, descriptions: TaskDescriptions, lifecycle: DiscussionLifecycle, askusers: AskUsers, runDetails: RunDetails, onUnarchive?: () => void): ProviderRegistration {
  const deps = { store, threads, runs, stops, deliveries, descriptions, lifecycle, askusers, runDetails };
  return {
    id: providerId, label: "Multica", description: "Multica 任务讨论（目录仅为本地占位目录）",
    status: async () => ({ available: true }),
    async connect(request) {
      if (!request.versions.includes(1)) throw new Error("Unsupported Multica provider protocol");
      const capabilities = supported.filter(value => request.capabilities.includes(value));
      const listeners = new Set<(event: ProviderEvent) => void>();
      const sessions = new Map<string, DiscussionSession>();
      let closed = false;
      const emit = (event: ProviderEvent) => { if (!closed) for (const listener of listeners) listener(event); };
      const releaseSession = (sessionId: string) => {
        const session = sessions.get(sessionId);
        session?.release();
        sessions.delete(sessionId);
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
                description: taskDescriptionSummary(issue.description), updatedAt: issue.updatedAt,
              }, ...Object.entries(issue.threads).map(([rootId, thread]) => ({ persistence: threadPersistence(connectionKey, issueId, rootId), cwd: issue.cwd, title: thread.title,
                description: `Thread · ${issue.title}`, updatedAt: issue.updatedAt }))]));
            emit({ type: "sessions", requestId: input.requestId, sessions: entries.filter(issue =>
              (!input.cwd || issue.cwd === input.cwd) && (!input.query || issue.title.toLowerCase().includes(input.query.toLowerCase())))
              .slice(0, input.limit ?? entries.length) });
            return;
          }
          if (input.type === "session.open") {
            const admitted = await DiscussionSession.admit({ ...deps, capabilities, has: sessionId => sessions.has(sessionId) }, input);
            if ("type" in admitted) { emit(admitted); return; }
            const { address, issue, persistence } = admitted;
            // Keep these checks with sessions.set in one synchronous segment; moving them into admit would reintroduce the race fixed by f373f51.
            if (lifecycle.unavailable(address)) {
              emit({ type: "request.failed", requestId: input.requestId, error: { code: "discussion_unavailable", message: "此讨论正在清理本地状态，请稍后重试。" } });
              return;
            }
            if (sessions.has(input.sessionId)) {
              emit({ type: "request.failed", requestId: input.requestId, error: { code: "unmapped_issue", message: "请在 Multica 设置启用任务工作区后打开已导入的主讨论。" } });
              return;
            }
            const session = new DiscussionSession(deps, emit, capabilities, input, address, issue, persistence, { remove: () => releaseSession(input.sessionId) });
            sessions.set(input.sessionId, session);
            await session.open();
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
            if (session) await session.interrupt(input);
            else emit({ type: "request.failed", requestId: input.requestId, error: { code: "stop_incomplete", message: "Discussion unavailable" } });
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
            if (!session) throw new Error("提问权限不可用。");
            await session.permission(input);
            return;
          }
          if (input.type === "session.prompt") {
            const session = sessions.get(input.sessionId);
            if (session) await session.prompt(input);
            else emit({ type: "session.prompt_result", sessionId: input.sessionId, clientMessageId: input.prompt.clientMessageId,
              result: { type: "failed", error: { code: "delivery_not_received", message: "请在 Multica 设置启用任务工作区后打开已导入的讨论。" } } });
            return;
          }
          if ("requestId" in input) emit({ type: "request.failed", requestId: input.requestId, error: { code: "unsupported", message: "此操作尚未支持。" } });
        },
        async close() { for (const sessionId of sessions.keys()) releaseSession(sessionId); listeners.clear(); closed = true; },
      };
    },
  };
}
