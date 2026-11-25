import { runObserve, runOpen, runRead, runMetadataRead } from "../shared/runs.js";
import { RunSynchronizer } from "./runs.js";
import { RunDetails } from "./run-details.js";
import { homedir } from "node:os";
import { join } from "node:path";
import type { PluginServerContribution } from "@getpaseo/plugin/server";
import { multicaSettings, connectionStatus, connectionHistory, syncBootstrap, syncStatus, workspaceList, workspaceEnable, workspaceRule, workspaceCatalog, taskRuleSchema, type ConnectionStatus } from "../shared/contracts.js";
import { createConnectionResolver, type AuthenticatedConnection, type ConnectionDependencies } from "./connection.js";
import { StateStore, connectionState } from "./state.js";
import { SidebarSynchronizer } from "./sync.js";
import { connectNativeHost, type NativeHost } from "./native-host.js";
import { DiscussionMetadata } from "./discussion-metadata.js";
import { workspaceCatalogs } from "./catalogs.js";
import { createMulticaProvider } from "./provider.js";
import { DiscussionLifecycle } from "./discussion-lifecycle.js";
import { readTaskDescription, observeTaskDescription } from "../shared/description.js";
import { descriptionRevision, descriptionSlice, TaskDescriptions } from "./task-description.js";
import { projectionHistory, ThreadSynchronizer } from "./threads.js";
import { threadOpen, commentEventDetail, threadResolve } from "../shared/threads.js";
import { ManualHiding } from "./hiding.js";
import { hiddenList, hiddenRestore } from "../shared/hiding.js";
import { StopCoordinator } from "./stops.js";
import { CommentDelivery } from "./delivery.js";
import { deliveryList, deliveryRead, deliveryTargets, deliveryMentions, deliveryVerify, deliveryResend } from "../shared/delivery.js";
import { issueHistoryList, issueHistoryRead } from "../shared/access.js";
import { AskUsers } from "./askuser.js";
import { AskuserWakeups } from "./askuser-wakeup.js";
import { askuserObserve, askuserRead, askuserReopen, askuserSkip } from "../shared/askuser.js";
import { IssueHistory } from "./access.js";

export interface ServerDependencies extends ConnectionDependencies {
  stateDirectory: string;
  connectHost: (paseoHome: string) => Promise<NativeHost>;
  syncIntervalMs: number;
  now: () => Date;
}

export function createServerContribution(dependencies: Partial<ServerDependencies> = {}): PluginServerContribution {
  return server => {
    const settings = server.registerSettings(multicaSettings);
    const resolve = createConnectionResolver({ homeDirectory: dependencies.homeDirectory ?? homedir(),
      workingDirectory: dependencies.workingDirectory ?? process.cwd(), environment: dependencies.environment ?? process.env,
      currentProfile: async () => { const state = await settings.read(); return state.status === "ready" ? state.values.profile : undefined; } });
    server.handle(connectionStatus, async (): Promise<ConnectionStatus> => {
      const state = await settings.read();
      if (state.status !== "ready") { resolve.invalidate(); await askusers.connectionChanged(); return { status: "invalid_settings", profile: "", source: { api: "none", credentials: "none", app: "none" },
        message: "Multica 插件设置无效，请重新选择 CLI profile。", loginCommand: "multica login" }; }
      return resolveStatus(state.values.profile);
    });
    async function connection() {
      const state = await settings.read();
      if (state.status !== "ready") { resolve.invalidate(); await askusers.connectionChanged(); throw new Error("Multica settings unavailable"); }
      let authenticated: AuthenticatedConnection | undefined;
      await resolveStatus(state.values.profile, value => { authenticated = value; });
      if (!authenticated) throw new Error("Multica connection unavailable");
      return authenticated;
    }
    const environment = dependencies.environment ?? process.env;
    const owningHome = environment.PASEO_HOME ?? "";
    const store = new StateStore(dependencies.stateDirectory ?? join(owningHome || join(dependencies.homeDirectory ?? homedir(), ".paseo"), "multica-provider"));
    const watchedConnections = new WeakSet<AbortSignal>();
    const identityRefreshes = new Set<Promise<unknown>>();
    let resolvingIdentity = 0;
    let reconciledIdentity = 0;
    let shuttingDown = false;
    async function resolveStatus(profile: string, authenticated?: (connection: AuthenticatedConnection) => void) {
      const generation = ++resolvingIdentity;
      let context: AuthenticatedConnection | undefined;
      const status = await resolve(profile, value => { context = value; authenticated?.(value); });
      if (generation < reconciledIdentity || shuttingDown) return status;
      reconciledIdentity = generation;
      if (context?.signal && !watchedConnections.has(context.signal)) {
        const signal = context.signal;
        watchedConnections.add(signal);
        signal.addEventListener("abort", () => {
          if (shuttingDown) return;
          // Revocation also happens for same-account token rotation. Verify the
          // replacement identity before changing card permissions or collapse.
          const refresh = Promise.resolve().then(() => connection()).catch(() => {});
          identityRefreshes.add(refresh);
          void refresh.finally(() => { identityRefreshes.delete(refresh); });
        }, { once: true });
      }
      await askusers.connectionChanged(status.status === "ready" && status.connectionKey && status.user ? { connectionKey: status.connectionKey, userId: status.user.id } : undefined);
      if (status.status === "ready" && status.connectionKey && status.apiUrl && status.user) {
        const { connectionKey, apiUrl, appUrl, user } = status;
        await store.update(state => {
          const connection = connectionState(state, connectionKey);
          connection.identity = { apiUrl, ...(appUrl ? { appUrl } : {}), user,
            profiles: [...new Set([...(connection.identity?.profiles ?? []), profile])], lastVerifiedAt: new Date().toISOString() };
        });
      }
      return status;
    }
    server.handle(connectionHistory, async () => ({ connections: Object.entries((await store.read()).connections).map(([connectionKey, connection]) => {
      const issues = Object.values(connection.issues);
      return { ...connection.identity, connectionKey, profiles: connection.identity?.profiles ?? [], projectCount: Object.keys(connection.projects).length, issueCount: issues.length,
        hiddenCount: issues.reduce((count, issue) => count + Number(issue.manualHidden.workspace) + issue.manualHidden.discussions.length, 0),
        pendingDeliveryCount: issues.reduce((count, issue) => count + Object.values(issue.deliveries).filter(record => record.status === "received" || record.status === "pending_verification").length, 0),
      };
    }) }));
    const lifecycle = new DiscussionLifecycle();
    const askusers = new AskUsers(store, connection, lifecycle);
    server.handle(askuserObserve, input => askusers.observe(input));
    server.handle(askuserRead, input => askusers.read(input));
    const threads = new ThreadSynchronizer(store, connection, askusers);
    const metadata = new DiscussionMetadata(store);
    const history = new IssueHistory(store);
    server.handle(issueHistoryList, () => history.list());
    server.handle(issueHistoryRead, input => history.read(input));
    const wakeups = new AskuserWakeups(store, askusers, lifecycle, dependencies.now);
    server.handle(askuserReopen, async (input, context) => {
      const card = await askusers.reopen(input, lifecycle);
      await synchronizer.withNativeHost(context.paseo, async host => {
        const current = await connection();
        if (current.connectionKey !== input.connectionKey) throw new Error("登录身份已变化；请连接原 Multica 身份。");
        await wakeups.reopen(current, card, host);
      });
      return card;
    });
    const hiding = new ManualHiding(store, lifecycle);
    server.addHook("agent.archive.after", async ({ agent }) => { await hiding.archivedAgent(agent); });
    server.addHook("workspace.archive.after", async ({ workspace }) => { await hiding.archivedWorkspace(workspace.id); });
    server.handle(hiddenList, async () => hiding.list());
    const runs = new RunSynchronizer(store);
    const runDetails = new RunDetails(store, connection);
    const stops = new StopCoordinator(store, connection, runs);
    server.handle(askuserSkip, input => askusers.skip(input, lifecycle));
    const deliveries = new CommentDelivery(store, connection, () => synchronizer.reconcile(), dependencies.now, record => askusers.deliveryChanged(record), lifecycle);
    threads.coordinateDeliveries(() => deliveries.waitForPosts());
    server.handle(deliveryVerify, async input => deliveries.verify(input));
    server.handle(deliveryResend, async input => deliveries.resend(input));
    server.handle(deliveryList, async () => deliveries.list());
    server.handle(deliveryRead, async input => deliveries.read(input));
    server.handle(deliveryTargets, async () => deliveries.targets());
    server.handle(deliveryMentions, async input => deliveries.mentions(input));
    const descriptions = new TaskDescriptions(store);
    server.registerProvider(createMulticaProvider(store, threads, runs, stops, deliveries, descriptions, lifecycle, askusers));
    server.handle(observeTaskDescription, input => descriptions.observe(input));
    server.handle(readTaskDescription, async input => {
      // The host authenticates this RPC. Cached history belongs to its persisted
      // connection, even while the CLI is offline, logged out, or using another account.
      const issue = (await store.read()).connections[input.connectionKey]?.issues[input.issueId];
      if (!issue || descriptionRevision(issue.description) !== input.revision || input.offset > issue.description.length) {
        throw new Error("Task description changed or is unavailable; reopen the discussion");
      }
      const text = descriptionSlice(issue.description, input.offset, 8192);
      const nextOffset = input.offset + text.length;
      return { text, nextOffset: nextOffset < issue.description.length ? nextOffset : null };
    });
    server.handle(runObserve, async input => runs.observe(input));
    server.handle(runOpen, async input => runDetails.open(input));
    server.handle(runRead, async input => runDetails.read(input));
    server.handle(runMetadataRead, async input => runDetails.readMetadata(input));
    server.handle(threadOpen, async input => threads.open(input));
    server.handle(threadResolve, async input => {
      const issue = (await store.read()).connections[input.connectionKey]?.issues[input.issueId];
      return { comments: input.commentIds.map(commentId => {
        const rootId = issue?.commentRoots[commentId];
        return rootId ? { commentId, rootId, createdAt: issue?.commentCreatedAt[commentId], status: "resolved" as const } : { commentId, status: "unresolved" as const };
      }) };
    });
    server.handle(commentEventDetail, async input => {
      const issue = (await store.read()).connections[input.connectionKey]?.issues[input.issueId];
      const row = issue ? projectionHistory(issue, input.rootId)?.rows.find(row => row.id === input.recordId && row.role === "event") : undefined;
      if (!row) throw new Error("Comment event unavailable");
      return { text: row.text };
    });
    const synchronizer = new SidebarSynchronizer({ store, connection, lifecycle,
      onCached: async host => { await threads.reconcile(host); await deliveries.recover(host); },
      onIssue: async (connection, workspace, issueId, host) => {
        await descriptions.observe({ connectionKey: connection.connectionKey, issueId });
        await deliveries.reconcile(connection, workspace, issueId);
        await threads.discover(connection, workspace, issueId, host);
        await runs.discover(connection, workspace, issueId);
        await wakeups.discover(connection, issueId, host);
      },
      connectHost: () => (dependencies.connectHost ?? connectNativeHost)(owningHome), intervalMs: dependencies.syncIntervalMs ?? 15_000 });
    server.handle(hiddenRestore, async (input, context) => {
      try { await synchronizer.withNativeHost(context.paseo, host => hiding.restore(input, host)); return { status: "ready" as const }; }
      catch (error) { return { status: "unavailable" as const, message: error instanceof Error ? error.message : "隐藏对象恢复失败，请重试。" }; }
    });
    server.handle(syncStatus, async () => synchronizer.status());
    server.handle(syncBootstrap, async (_, context) => {
      // The composer's agent picker reads a discussion's task from agent metadata. A connected client
      // bootstraps every ten seconds, which also reaches discussions imported since.
      void metadata.mirror(context.paseo);
      try { await synchronizer.bootstrap(context.paseo); return { status: "ready" as const }; }
      catch { return { status: "unavailable" as const, message: "Multica 同步暂不可用，请检查 CLI 连接和 daemon。" }; }
    });
    server.handle(workspaceList, async () => {
      const context = await connection();
      const workspaces = await synchronizer.workspaces(context);
      const rules = (await store.read()).connections[context.connectionKey]?.rules;
      return { connectionKey: context.connectionKey, workspaces: workspaces.map(workspace => ({ id: workspace.id, name: workspace.name, enabled: rules?.[workspace.id]?.enabled ?? false, rule: taskRuleSchema.parse(rules?.[workspace.id] ?? {}) })) };
    });
    server.handle(workspaceEnable, async (input, context) => {
      try { await synchronizer.enable(context.paseo, input.workspaceId, input.enabled, input.connectionKey); return { status: "ready" as const }; }
      catch { return { status: "unavailable" as const, message: "Multica 工作区规则保存或同步失败，请检查连接后重试。" }; }
    });
    server.handle(workspaceCatalog, async input => {
      const authenticated = await connection();
      if (input.connectionKey && input.connectionKey !== authenticated.connectionKey) throw new Error("Connection identity changed");
      const workspace = (await synchronizer.workspaces(authenticated)).find(item => item.id === input.workspaceId);
      if (!workspace) throw new Error("Multica workspace unavailable");
      return workspaceCatalogs(authenticated, workspace);
    });
    server.handle(workspaceRule, async (input, context) => {
      try { await synchronizer.rule(context.paseo, input.workspaceId, input.rule, input.connectionKey); return { status: "ready" as const }; }
      catch { return { status: "unavailable" as const, message: "筛选规则保存或同步失败，请检查连接后重试。" }; }
    });
    return async () => { shuttingDown = true; await Promise.allSettled(identityRefreshes); await deliveries.close(); await synchronizer.close(); await metadata.close(); await stops.close(); await threads.close(); await askusers.close(); await runDetails.close(); runs.close(); descriptions.close(); };
  };
}
