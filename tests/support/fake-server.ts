import type { PaseoApi } from "@getpaseo/client";
import { workspaceList, workspaceRule } from "../../shared/contracts.js";
import type { PluginRpcContract, SettingsDefinition } from "@getpaseo/plugin";
import type {
  PluginHookContext, PluginHookPayload, PluginHookResult, PluginHooks,
  PluginServerContext, PluginSettingsState,
} from "@getpaseo/plugin/server";
import type { ProviderRegistration } from "@getpaseo/plugin/server/provider";
import type { input, output, ZodType } from "zod";

export class FakeServer {
  readonly providers = new Map<string, ProviderRegistration>();
  readonly settings = new Map<string, SettingsDefinition>();
  private readonly settingsValues = new Map<string, unknown>();
  private readonly handlers = new Map<string, (input: unknown, paseo: PaseoApi) => Promise<unknown>>();
  private readonly hooks = new Map<keyof PluginHooks, Array<(payload: never, context: PluginHookContext) => Promise<unknown>>>();

  readonly context: PluginServerContext = {
    registerProvider: (provider) => { this.providers.set(provider.id, provider); },
    registerUsageSource: () => { throw new Error("Usage source not implemented by fake"); },
    registerSettings: <Schema extends ZodType>(definition: SettingsDefinition<Schema>) => {
      this.settings.set(definition.id, definition);
      return {
        read: async (): Promise<PluginSettingsState<Schema>> => {
          const parsed = definition.schema.safeParse(this.settingsValues.get(definition.id) ?? {});
          return parsed.success ? { status: "ready", revision: "1", values: parsed.data }
            : { status: "invalid", revision: "1", error: "Settings validation failed" };
        },
        subscribe: () => () => {},
      };
    },
    handle: (contract, handler) => {
      this.handlers.set(contract.name, async (value, paseo) =>
        contract.output.parse(await handler(contract.input.parse(value), { paseo })));
    },
    addHook: (name, handler) => {
      const handlers = this.hooks.get(name) ?? [];
      // The map erases each hook's discriminant; runHook restores the same SDK type.
      handlers.push(handler as (payload: never, context: PluginHookContext) => Promise<unknown>);
      this.hooks.set(name, handlers);
      return () => { handlers.splice(handlers.indexOf(handler as never), 1); };
    },
    on: () => { throw new Error("Use SDK addHook in tests"); },
    before: () => { throw new Error("Use SDK addHook in tests"); },
  };

  setSettings(id: string, values: unknown) { this.settingsValues.set(id, values); }

  async rpc<I extends ZodType, O extends ZodType>(contract: PluginRpcContract<I, O>, value: input<I>, paseo: PaseoApi): Promise<output<O>> {
    const handler = this.handlers.get(contract.name);
    if (!handler) throw new Error(`RPC not registered: ${contract.name}`);
    return contract.output.parse(await handler(value, paseo));
  }

  async hook<Name extends keyof PluginHooks>(name: Name, payload: PluginHookPayload<Name>, paseo: PaseoApi): Promise<PluginHookResult<Name>> {
    let result: unknown;
    for (const handler of this.hooks.get(name) ?? []) {
      result = await handler(payload as never, { paseo, signal: new AbortController().signal });
    }
    return result as PluginHookResult<Name>;
  }
}

/** Reapplying the current rule explicitly requests a fresh snapshot after bootstrap becomes idempotent. */
export async function resync(server: FakeServer, paseo: PaseoApi, workspaceId: string) {
  try {
    const workspace = (await server.rpc(workspaceList, {}, paseo)).workspaces.find(item => item.id === workspaceId);
    if (!workspace) return { status: "unavailable" as const };
    return await server.rpc(workspaceRule, { workspaceId, rule: workspace.rule }, paseo);
  } catch { return { status: "unavailable" as const }; }
}
