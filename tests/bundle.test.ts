import { build } from "paseo-esbuild";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { runInThisContext } from "node:vm";
import * as pluginRuntime from "@getpaseo/plugin";
import * as zod from "zod";
import { expect, it, vi } from "vitest";
import { FakeServer } from "./support/fake-server.js";

async function bundledContribution(entry: string, runtime: Record<string, unknown> = {}) {
  const result = await build({ entryPoints: [fileURLToPath(new URL(entry, import.meta.url))], bundle: true,
    format: "cjs", platform: "node", target: "node20", external: ["@getpaseo/plugin", "@getpaseo/plugin/*", "zod", "react", "react/*", "react-native"], write: false });
  // Same eager-export transform as Paseo 0.15 compiler-build.ts.
  const code = result.outputFiles[0].text.replaceAll("get: () => from[key]", "value: from[key]");
  const factory = runInThisContext(`(function(require) { const module = { exports: {} }; const exports = module.exports;\n${code}\nreturn module.exports; })`);
  const nodeRequire = createRequire(import.meta.url);
  const modules = { "@getpaseo/plugin": pluginRuntime, zod, ...runtime };
  const exports = factory((name: string) => modules[name as keyof typeof modules] ?? nodeRequire(name));
  expect(typeof exports.default).toBe("function");
  return exports.default;
}

it("the host-compiled server entry registers CLI connection management", async () => {
  const setup = await bundledContribution("../index.server.ts");
  const server = new FakeServer();
  const dispose = setup(server.context);
  expect(server.settings.has("multica")).toBe(true);
  expect(server.providers.has("multica")).toBe(true);
  dispose();
});

it("the host-compiled client entry offers a Multica management screen and sidebar entry", async () => {
  const setup = await bundledContribution("../index.client.tsx", { "@getpaseo/plugin/client": {}, "@getpaseo/plugin/client/ui": {}, "react-native": {} });
  const entries: Array<{ kind: string; id: string; Component?: unknown }> = [];
  const add = (kind: string) => (entry: { id: string; Component?: unknown }) => {
    entries.push({ kind, ...entry });
    return () => { entries.splice(entries.findIndex(value => value.kind === kind && value.id === entry.id), 1); };
  };
  const dispose = setup({ rpc: async () => ({ status: "ready" }), addSettingsScreen: add("settings"), addScreen: add("screen"), addSidebarHeaderItem: add("sidebar"), addTimelineRenderer: () => () => {} });
  expect(entries.map(({ kind, id }) => ({ kind, id }))).toEqual([
    { kind: "settings", id: "multica" }, { kind: "screen", id: "management" }, { kind: "sidebar", id: "multica" },
  ]);
  expect(entries.every(entry => typeof entry.Component === "function")).toBe(true);
  dispose();
  expect(entries).toEqual([]);
});

it("client contribution bootstraps without opening management and retries after a disconnected RPC", async () => {
  const setup = await bundledContribution("../index.client.tsx", { "@getpaseo/plugin/client": {}, "@getpaseo/plugin/client/ui": {}, "react-native": {} });
  vi.useFakeTimers();
  try {
    const calls: string[] = [];
    const dispose = setup({ rpc: async (contract: { name: string }) => { calls.push(contract.name); if (calls.length === 1) throw new Error("disconnected"); return { status: "ready" }; },
      addSettingsScreen: () => () => {}, addScreen: () => () => {}, addSidebarHeaderItem: () => () => {}, addTimelineRenderer: () => () => {} });
    await Promise.resolve();
    expect(calls).toEqual(["sync.bootstrap"]);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(calls).toEqual(["sync.bootstrap", "sync.bootstrap"]);
    dispose();
    await vi.advanceTimersByTimeAsync(20_000);
    expect(calls).toHaveLength(2);
  } finally { vi.useRealTimers(); }
});


it("the native thread renderer lazily opens history and comment events render as independent records", async () => {
  const effects: Array<() => unknown> = [];
  const calls: Array<{ name: string; input: unknown }> = [];
  const renderers: Array<{ kind: string; schema: zod.ZodType; Component: (props: any) => any }> = [];
  const setup = await bundledContribution("../index.client.tsx", {
    "@getpaseo/plugin/client": { useRpc: (contract: { name: string }) => async (input: unknown) => { calls.push({ name: contract.name, input }); return { status: "ready" }; } },
    "@getpaseo/plugin/client/ui": {}, "react-native": { Text: "Text", View: "View", Pressable: "Pressable" },
    react: { useEffect: (effect: () => unknown) => effects.push(effect), useState: (initial: unknown) => [initial, () => {}] },
  });
  const dispose = setup({ rpc: async () => ({ status: "ready" }), addSettingsScreen: () => () => {}, addScreen: () => () => {}, addSidebarHeaderItem: () => () => {},
    addTimelineRenderer: (renderer: any) => { renderers.push(renderer); return () => {}; } });
  expect(renderers.map(renderer => renderer.kind)).toEqual(["thread", "comment-event"]);
  expect(calls).toEqual([]);
  const address = { connectionKey: "connection", issueId: "issue", rootId: "root" };
  const theme = { colors: { foreground: "black", foregroundMuted: "gray" } };
  renderers[0].Component({ item: { data: renderers[0].schema.parse({ ...address, title: "Thread" }) }, theme });
  for (const effect of effects.splice(0)) effect();
  await Promise.resolve();
  expect(calls).toEqual([{ name: "thread.open", input: address }]);
  const event = renderers[1].Component({ item: { data: renderers[1].schema.parse({ ...address, recordId: "correction", commentId: "root", category: "correction", text: "Updated text", sourceUpdatedAt: "2026-11-24T12:00:00Z", truncated: false }) }, theme });
  expect(JSON.stringify(event)).toContain("评论更正");
  expect(JSON.stringify(event)).toContain("Updated text");
  expect(JSON.stringify(event)).toContain("2026-11-24T12:00:00Z");
  const source = renderers[1].Component({ item: { data: renderers[1].schema.parse({ ...address, recordId: "original", commentId: "root", category: "source", text: "First observed snapshot", sourceCreatedAt: "2020-01-01T00:00:00Z", sourceUpdatedAt: "2026-11-24T12:00:00Z", truncated: false }) }, theme });
  expect(JSON.stringify(source)).toContain("评论来源");
  expect(JSON.stringify(source)).toContain("2020-01-01T00:00:00Z");
  expect(JSON.stringify(source)).toContain("2026-11-24T12:00:00Z");
  dispose();
});
