import { homedir } from "node:os";
import { join } from "node:path";
import type { PluginServerContribution } from "@getpaseo/plugin/server";
import { multicaSettings, connectionStatus, syncBootstrap, workspaceList, workspaceEnable, type ConnectionStatus } from "../shared/contracts.js";
import { createConnectionResolver, type AuthenticatedConnection, type ConnectionDependencies } from "./connection.js";
import { StateStore } from "./state.js";
import { SidebarSynchronizer } from "./sync.js";
import { connectNativeHost, type NativeHost } from "./native-host.js";
import { createMulticaProvider } from "./provider.js";
import { projectionHistory, ThreadSynchronizer } from "./threads.js";
import { threadOpen, commentEventDetail, threadResolve } from "../shared/threads.js";

export interface ServerDependencies extends ConnectionDependencies {
  stateDirectory: string;
  connectHost: (paseoHome: string) => Promise<NativeHost>;
  syncIntervalMs: number;
}

export function createServerContribution(dependencies: Partial<ServerDependencies> = {}): PluginServerContribution {
  return server => {
    const settings = server.registerSettings(multicaSettings);
    const resolve = createConnectionResolver({ homeDirectory: dependencies.homeDirectory ?? homedir(),
      workingDirectory: dependencies.workingDirectory ?? process.cwd(), environment: dependencies.environment ?? process.env });
    server.handle(connectionStatus, async (): Promise<ConnectionStatus> => {
      const state = await settings.read();
      if (state.status !== "ready") return { status: "invalid_settings", profile: "", source: { api: "none", credentials: "none", app: "none" },
        message: "Multica 插件设置无效，请重新选择 CLI profile。", loginCommand: "multica login" };
      return resolve(state.values.profile);
    });
    async function connection() {
      const state = await settings.read();
      if (state.status !== "ready") throw new Error("Multica settings unavailable");
      let authenticated: AuthenticatedConnection | undefined;
      await resolve(state.values.profile, value => { authenticated = value; });
      if (!authenticated) throw new Error("Multica connection unavailable");
      return authenticated;
    }
    const environment = dependencies.environment ?? process.env;
    const owningHome = environment.PASEO_HOME ?? "";
    const store = new StateStore(dependencies.stateDirectory ?? join(owningHome || join(dependencies.homeDirectory ?? homedir(), ".paseo"), "multica-provider"));
    const threads = new ThreadSynchronizer(store, connection);
    server.registerProvider(createMulticaProvider(store, threads));
    server.handle(threadOpen, async input => threads.open(input));
    server.handle(threadResolve, async input => {
      const issue = (await store.read()).connections[input.connectionKey]?.issues[input.issueId];
      return { comments: input.commentIds.map(commentId => {
        const rootId = issue?.commentRoots[commentId];
        return rootId ? { commentId, rootId, status: "resolved" as const } : { commentId, status: "unresolved" as const };
      }) };
    });
    server.handle(commentEventDetail, async input => {
      const issue = (await store.read()).connections[input.connectionKey]?.issues[input.issueId];
      const row = issue ? projectionHistory(issue, input.rootId)?.rows.find(row => row.id === input.recordId && row.role === "event") : undefined;
      if (!row) throw new Error("Comment event unavailable");
      return { text: row.text };
    });
    const synchronizer = new SidebarSynchronizer({ store, connection,
      onIssue: (connection, workspace, issueId, host) => threads.discover(connection, workspace, issueId, host),
      connectHost: () => (dependencies.connectHost ?? connectNativeHost)(owningHome), intervalMs: dependencies.syncIntervalMs ?? 15_000 });
    server.handle(syncBootstrap, async (_, context) => {
      try { await synchronizer.bootstrap(context.paseo); return { status: "ready" as const }; }
      catch { return { status: "unavailable" as const, message: "Multica 同步暂不可用，请检查 CLI 连接和 daemon。" }; }
    });
    server.handle(workspaceList, async () => {
      const context = await connection();
      const workspaces = await synchronizer.workspaces(context);
      const rules = (await store.read()).connections[context.connectionKey]?.rules;
      return { workspaces: workspaces.map(workspace => ({ id: workspace.id, name: workspace.name, enabled: rules?.[workspace.id]?.enabled ?? false })) };
    });
    server.handle(workspaceEnable, async (input, context) => {
      try { await synchronizer.enable(context.paseo, input.workspaceId, input.enabled); return { status: "ready" as const }; }
      catch { return { status: "unavailable" as const, message: "工作区规则保存或同步失败，请检查连接后重试。" }; }
    });
    return async () => { await synchronizer.close(); await threads.close(); };
  };
}
