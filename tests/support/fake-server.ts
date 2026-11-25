import { expect } from "vitest";
import type { PaseoApi } from "@getpaseo/client";
import { workspaceList, workspaceRule, connectionStatus, type SyncStatus } from "../../shared/contracts.js";
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

  /** Existing projection tests explicitly wait; rpc() retains the real nonblocking contract. */
  async syncRpc<I extends ZodType, O extends ZodType>(contract: PluginRpcContract<I, O>, value: input<I>, paseo: PaseoApi) {
    const result = await this.rpc(contract, value, paseo) as { status: string };
    if (result.status === "unavailable") return { status: "unavailable" };
    return { status: (await waitForSync(this, paseo)).status };
  }

  async hook<Name extends keyof PluginHooks>(name: Name, payload: PluginHookPayload<Name>, paseo: PaseoApi): Promise<PluginHookResult<Name>> {
    let result: unknown;
    for (const handler of this.hooks.get(name) ?? []) {
      result = await handler(payload as never, { paseo, signal: new AbortController().signal });
    }
    return result as PluginHookResult<Name>;
  }
}

/** Wait for the background pass without weakening assertions about its native effects. */
export async function waitForSync(server: FakeServer, paseo: PaseoApi) {
  let status: SyncStatus | undefined;
  await expect.poll(async () => {
    const next = (await server.rpc(connectionStatus, {}, paseo)).sync;
    // Also let the 20ms workspace-event debounce settle before the next test action.
    const settled = next.status !== "syncing" && next.status === status?.status;
    status = next;
    return settled;
  }, { interval: 50, timeout: 4_000 }).toBe(true);
  return status!;
}

/** Reapplying the current rule explicitly requests a fresh snapshot after bootstrap becomes idempotent. */
export async function resync(server: FakeServer, paseo: PaseoApi, workspaceId: string) {
  let workspace;
  try { workspace = (await server.rpc(workspaceList, {}, paseo)).workspaces.find(item => item.id === workspaceId); }
  catch { return { status: "unavailable" as const }; }
  if (!workspace) return { status: "unavailable" as const };
  return server.syncRpc(workspaceRule, { workspaceId, rule: workspace.rule }, paseo);
}

export async function hiddenObjects(server: FakeServer, paseo: PaseoApi) { return (await server.rpc(connectionStatus, {}, paseo)).hidden; }
