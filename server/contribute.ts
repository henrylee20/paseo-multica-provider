import { homedir } from "node:os";
import type { PluginServerContribution } from "@getpaseo/plugin/server";
import { multicaSettings, connectionStatus, type ConnectionStatus } from "../shared/contracts.js";
import { createConnectionResolver, type ConnectionDependencies } from "./connection.js";

export function createServerContribution(dependencies: Partial<ConnectionDependencies> = {}): PluginServerContribution {
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
    return () => {};
  };
}
