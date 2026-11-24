import { build } from "paseo-esbuild";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { runInThisContext } from "node:vm";
import * as pluginRuntime from "@getpaseo/plugin";
import * as zod from "zod";
import { expect, it } from "vitest";
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
  expect(server.providers.size).toBe(0);
  dispose();
});

it("the host-compiled client entry offers a Multica management screen and sidebar entry", async () => {
  const setup = await bundledContribution("../index.client.tsx", { "@getpaseo/plugin/client": {}, "@getpaseo/plugin/client/ui": {}, "react-native": {} });
  const entries: Array<{ kind: string; id: string; Component?: unknown }> = [];
  const add = (kind: string) => (entry: { id: string; Component?: unknown }) => {
    entries.push({ kind, ...entry });
    return () => { entries.splice(entries.findIndex(value => value.kind === kind && value.id === entry.id), 1); };
  };
  const dispose = setup({ addSettingsScreen: add("settings"), addScreen: add("screen"), addSidebarHeaderItem: add("sidebar") });
  expect(entries.map(({ kind, id }) => ({ kind, id }))).toEqual([
    { kind: "settings", id: "multica" }, { kind: "screen", id: "management" }, { kind: "sidebar", id: "multica" },
  ]);
  expect(entries.every(entry => typeof entry.Component === "function")).toBe(true);
  dispose();
  expect(entries).toEqual([]);
});
