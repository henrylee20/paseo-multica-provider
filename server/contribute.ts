import { runObserve, runOpen, runRead } from "../shared/runs.js";
import { RunSynchronizer } from "./runs.js";
import { RunDetails } from "./run-details.js";
import { homedir } from "node:os";
import { join } from "node:path";
import type { PluginServerContribution } from "@getpaseo/plugin/server";
import { multicaSettings, connectionStatus, syncBootstrap, workspaceList, workspaceEnable, workspaceRule, workspacePreview, workspaceCatalog, taskRuleSchema } from "../shared/contracts.js";
import { createConnectionResolver, type AuthenticatedConnection, type ConnectionDependencies } from "./connection.js";
import { StateStore } from "./state.js";
import { SidebarSynchronizer, importedIssues } from "./sync.js";
import { connectNativeHost, type NativeHost } from "./native-host.js";
import { DiscussionMetadata } from "./discussion-metadata.js";
import { workspaceCatalogs } from "./catalogs.js";
import { createMulticaProvider } from "./provider.js";
import { DiscussionLifecycle } from "./discussion-lifecycle.js";
import { readText } from "./chunked-text.js";
import { readTaskDescription } from "../shared/description.js";
import { TaskDescriptions } from "./task-description.js";
import { projectionHistory, ThreadSynchronizer } from "./threads.js";
import { threadOpen, commentEventDetail } from "../shared/threads.js";
import { ManualHiding } from "./hiding.js";
import { hiddenRestore } from "../shared/hiding.js";
import { StopCoordinator } from "./stops.js";
import { CommentDelivery } from "./delivery.js";
import { deliveryMentions } from "../shared/delivery.js";
import { AskUsers } from "./askuser.js";
import { AskuserWakeups } from "./askuser-wakeup.js";
import { askuserObserve, askuserRead, askuserReopen, askuserSkip } from "../shared/askuser.js";

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
    server.handle(connectionStatus, async () => {
      const details = { sync: synchronizer.status(), hidden: (await hiding.list()).objects };
      const state = await settings.read();
      if (state.status !== "ready") {
        resolve.invalidate();
        await askusers.connectionChanged();
        return { ...details, status: "invalid_settings", profile: "", source: { api: "none", credentials: "none", app: "none" },
        message: "Multica 插件设置无效，请重新选择 CLI profile。", loginCommand: "multica login" } as const;
      }
      return { ...await resolveStatus(state.values.profile), ...details };
    });
    async function connection(notifyIdentity = true) {
      const state = await settings.read();
      if (state.status !== "ready") { resolve.invalidate(); if (notifyIdentity) await askusers.connectionChanged(); throw new Error("Multica settings unavailable"); }
      let authenticated: AuthenticatedConnection | undefined;
      await (notifyIdentity ? resolveStatus : resolve)(state.values.profile, value => { authenticated = value; });
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
      return status;
    }
    const lifecycle = new DiscussionLifecycle();
    const askusers = new AskUsers(store, connection, lifecycle);
    server.handle(askuserObserve, input => askusers.observe(input));
    server.handle(askuserRead, input => askusers.read(input));
    const metadata = new DiscussionMetadata(store);
    const threads = new ThreadSynchronizer(store, connection, metadata, askusers);
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
    const hiding = new ManualHiding(store, lifecycle, metadata);
    server.addHook("agent.archive.after", async ({ agent }) => { await hiding.archivedAgent(agent); });
    server.addHook("workspace.archive.after", async ({ workspace }) => { await hiding.archivedWorkspace(workspace.id); });
    const runs = new RunSynchronizer(store);
    const runDetails = new RunDetails(store, connection);
    const stops = new StopCoordinator(store, connection, runs);
    server.handle(askuserSkip, input => askusers.skip(input, lifecycle));
    const deliveries = new CommentDelivery(store, connection, () => synchronizer.reconcile(), lifecycle);
    threads.coordinateDeliveries(() => deliveries.waitForPosts());
    server.handle(deliveryMentions, async input => deliveries.mentions(input));
    const descriptions = new TaskDescriptions(store);
    server.registerProvider(createMulticaProvider(store, threads, runs, stops, deliveries, descriptions, lifecycle, askusers));
    server.handle(readTaskDescription, async input => {
      // The host authenticates this RPC. Cached history belongs to its persisted
      // connection, even while the CLI is offline, logged out, or using another account.
      const issue = (await store.read()).connections[input.connectionKey]?.issues[input.issueId];
      if (!issue) throw new Error("Task description unavailable");
      return readText(issue.description, input);
    });
    server.handle(runObserve, async input => runs.observe(input));
    server.handle(runOpen, async input => runDetails.open(input));
    server.handle(runRead, async input => runDetails.read(input));
    server.handle(threadOpen, async input => threads.open(input));
    server.handle(commentEventDetail, async input => {
      const issue = (await store.read()).connections[input.connectionKey]?.issues[input.issueId];
      const row = issue ? projectionHistory(issue, input.rootId)?.rows.find(row => row.id === input.recordId && row.role === "event") : undefined;
      if (!row) throw new Error("Comment event unavailable");
      return { text: row.text };
    });
    const synchronizer = new SidebarSynchronizer({ store, connection, lifecycle, metadata,
      onCached: host => threads.reconcile(host),
      onIssue: async (connection, workspace, issueId, host) => {
        await descriptions.observe({ connectionKey: connection.connectionKey, issueId });
        await threads.discover(connection, workspace, issueId, host);
        await runs.discover(connection, workspace, issueId);
        await wakeups.discover(connection, issueId, host);
      },
      connectHost: () => (dependencies.connectHost ?? connectNativeHost)(owningHome), intervalMs: dependencies.syncIntervalMs ?? 15_000 });
    server.handle(hiddenRestore, async (input, context) => {
      try { await synchronizer.withNativeHost(context.paseo, host => hiding.restore(input, host)); return { status: "ready" as const }; }
      catch (error) { return { status: "unavailable" as const, message: error instanceof Error ? error.message : "隐藏对象恢复失败，请重试。" }; }
    });
    server.handle(syncBootstrap, async (_, context) => {
      // Backfill existing discussions once; imports write their own metadata.
      void metadata.mirror(context.paseo);
      try { await synchronizer.bootstrap(context.paseo); return { status: "ready" as const }; }
      catch { return { status: "unavailable" as const, message: "Multica 同步暂不可用，请检查 CLI 连接和 daemon。" }; }
    });
    server.handle(workspaceList, async () => {
      const context = await connection();
      const workspaces = await synchronizer.workspaces(context);
      const local = (await store.read()).connections[context.connectionKey];
      return { connectionKey: context.connectionKey, workspaces: workspaces.map(workspace => ({
        id: workspace.id, name: workspace.name, enabled: local?.rules[workspace.id]?.enabled ?? false,
        rule: taskRuleSchema.parse(local?.rules[workspace.id] ?? {}), importedCount: importedIssues(local, workspace.id).length
      })) };
    });
    server.handle(workspacePreview, input => synchronizer.preview(input.workspaceId, input.rule, input.connectionKey));
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
    return async () => {
      shuttingDown = true;
      await Promise.allSettled(identityRefreshes);
      await deliveries.close();
      await synchronizer.close();
      await metadata.close();
      await stops.close();
      await threads.close();
      await askusers.close();
      await runDetails.close();
      runs.close();
      descriptions.close();
    };
  };
}
