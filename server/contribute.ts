import { homedir } from "node:os";
import { join } from "node:path";
import type { PluginServerContribution } from "@getpaseo/plugin/server";
import { multicaSettings, connectionStatus, syncBootstrap, workspaceList, workspaceEnable, workspaceRule, workspaceCatalog, taskRuleSchema, type ConnectionStatus } from "../shared/contracts.js";
import { createConnectionResolver, type AuthenticatedConnection, type ConnectionDependencies } from "./connection.js";
import { StateStore } from "./state.js";
import { SidebarSynchronizer } from "./sync.js";
import { connectNativeHost, type NativeHost } from "./native-host.js";
import { workspaceCatalogs } from "./catalogs.js";
import { createMulticaProvider } from "./provider.js";
import { readTaskDescription } from "../shared/description.js";
import { descriptionRevision, descriptionSlice } from "./task-description.js";

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
    server.registerProvider(createMulticaProvider(store));
    server.handle(readTaskDescription, async input => {
      const current = await connection();
      if (input.connectionKey !== current.connectionKey) throw new Error("Task description belongs to another connection");
      const issue = (await store.read()).connections[current.connectionKey]?.issues[input.issueId];
      if (!issue || descriptionRevision(issue.description) !== input.revision || input.offset > issue.description.length) {
        throw new Error("Task description changed or is unavailable; reopen the discussion");
      }
      const text = descriptionSlice(issue.description, input.offset, 8192);
      const nextOffset = input.offset + text.length;
      return { text, nextOffset: nextOffset < issue.description.length ? nextOffset : null };
    });
    const synchronizer = new SidebarSynchronizer({ store, connection,
      connectHost: () => (dependencies.connectHost ?? connectNativeHost)(owningHome), intervalMs: dependencies.syncIntervalMs ?? 15_000 });
    server.handle(syncBootstrap, async (_, context) => {
      try { await synchronizer.bootstrap(context.paseo); return { status: "ready" as const }; }
      catch { return { status: "unavailable" as const, message: "Multica 同步暂不可用，请检查 CLI 连接和 daemon。" }; }
    });
    server.handle(workspaceList, async () => {
      const context = await connection();
      const workspaces = await synchronizer.workspaces(context);
      const rules = (await store.read()).connections[context.connectionKey]?.rules;
      return { workspaces: workspaces.map(workspace => ({ id: workspace.id, name: workspace.name, enabled: rules?.[workspace.id]?.enabled ?? false, rule: taskRuleSchema.parse(rules?.[workspace.id] ?? {}) })) };
    });
    server.handle(workspaceEnable, async (input, context) => {
      try { await synchronizer.enable(context.paseo, input.workspaceId, input.enabled); return { status: "ready" as const }; }
      catch { return { status: "unavailable" as const, message: "工作区规则保存或同步失败，请检查连接后重试。" }; }
    });
    server.handle(workspaceCatalog, async input => {
      const authenticated = await connection();
      const workspace = (await synchronizer.workspaces(authenticated)).find(item => item.id === input.workspaceId);
      if (!workspace) throw new Error("Multica workspace unavailable");
      return workspaceCatalogs(authenticated, workspace);
    });
    server.handle(workspaceRule, async (input, context) => {
      try { await synchronizer.rule(context.paseo, input.workspaceId, input.rule); return { status: "ready" as const }; }
      catch { return { status: "unavailable" as const, message: "筛选规则保存或同步失败，请检查连接后重试。" }; }
    });
    return () => synchronizer.close();
  };
}
