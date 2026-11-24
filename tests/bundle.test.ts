import { build } from "paseo-esbuild";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { runInThisContext } from "node:vm";
import { isValidElement } from "react";
import type { PluginTimelineRendererContribution } from "@getpaseo/plugin/client";
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
  await dispose();
}, 15_000);

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

function renderedText(node: unknown): string {
  if (typeof node === "string") return node;
  if (Array.isArray(node)) return node.map(renderedText).join("");
  if (!isValidElement<{ children?: unknown }>(node)) return "";
  return renderedText(typeof node.type === "function" ? (node.type as (props: unknown) => unknown)(node.props) : node.props.children);
}

it("the client renders the task description as visible Markdown and removes its renderer on disposal", async () => {
  const renderers: PluginTimelineRendererContribution[] = [];
  const setup = await bundledContribution("../index.client.tsx", {
    "react": { useState: (value: unknown) => [value, () => {}] },
    "@getpaseo/plugin/client": { useRpc: () => async () => ({}) },
    "@getpaseo/plugin/client/ui": { Markdown: ({ children }: { children: string }) => children },
    "react-native": { View: "View", Text: "Text" },
  });
  const dispose = setup({ rpc: async () => ({ status: "ready" }), addSettingsScreen: () => () => {}, addScreen: () => () => {},
    addSidebarHeaderItem: () => () => {}, addTimelineRenderer: (renderer: PluginTimelineRendererContribution) => {
      renderers.push(renderer); return () => { renderers.splice(renderers.indexOf(renderer), 1); };
    } });
  try {
    const renderer = renderers.find(value => value.kind === "task-description" && value.version === 1);
    expect(renderer, "main discussion description needs a registered visible renderer").toBeDefined();
    const data = renderer!.schema.parse({ connectionKey: "connection", issueId: "issue", revision: "revision", preview: "## 登录目标\n\n使用现有 **CLI** 登录。", truncated: false });
    const Component = renderer!.Component as (props: unknown) => unknown;
    expect(renderedText(Component({ item: { type: "plugin", kind: "task-description", version: 1, data },
      theme: { colors: { foreground: "black", foregroundMuted: "gray" } } }))).toBe("任务描述## 登录目标\n\n使用现有 **CLI** 登录。");
  } finally { dispose(); }
  expect(renderers).toEqual([]);
});

it("a reader can explicitly load every page of a long description from its visible preview", async () => {
  const renderers: PluginTimelineRendererContribution[] = [];
  const calls: Array<{ name: string; input: unknown }> = [];
  const actions: Array<{ onPress(): void }> = [];
  const state: unknown[] = [];
  let cursor = 0;
  const setup = await bundledContribution("../index.client.tsx", {
    react: { useState: (initial: unknown) => {
      const index = cursor++;
      if (!(index in state)) state[index] = initial;
      return [state[index], (value: unknown) => { state[index] = value; }];
    } },
    "@getpaseo/plugin/client": { useRpc: (contract: { name: string }) => async (input: { offset: number }) => {
      calls.push({ name: contract.name, input });
      return input.offset === 0 ? { text: "## 完整目标\n\n", nextOffset: 10 } : { text: "最后一段。", nextOffset: null };
    } },
    "@getpaseo/plugin/client/ui": { Markdown: ({ children }: { children: string }) => children,
      SettingsAction: (props: { onPress(): void; actionLabel: string }) => { actions.push(props); return props.actionLabel; } },
    "react-native": { View: "View", Text: "Text" },
  });
  const dispose = setup({ rpc: async () => ({ status: "ready" }), addSettingsScreen: () => () => {}, addScreen: () => () => {},
    addSidebarHeaderItem: () => () => {}, addTimelineRenderer: (renderer: PluginTimelineRendererContribution) => { renderers.push(renderer); return () => {}; } });
  try {
    const renderer = renderers.find(value => value.kind === "task-description")!;
    const data = renderer.schema.parse({ connectionKey: "connection", issueId: "issue", revision: "revision", preview: "目标预览", truncated: true });
    const Component = renderer.Component as (props: unknown) => unknown;
    const render = () => {
      cursor = 0; actions.length = 0;
      return renderedText(Component({ item: { type: "plugin", kind: "task-description", version: 1, data },
        theme: { colors: { foregroundMuted: "gray", statusDanger: "red" } } }));
    };
    expect(render()).toContain("目标预览");
    expect(calls).toEqual([]);
    expect(actions, "long descriptions need an explicit full-text action").toHaveLength(1);
    actions[0].onPress();
    await vi.waitFor(() => { expect(render()).toBe("任务描述## 完整目标\n\n最后一段。"); });
    expect(calls).toEqual([
      { name: "description.read", input: { connectionKey: "connection", issueId: "issue", revision: "revision", offset: 0 } },
      { name: "description.read", input: { connectionKey: "connection", issueId: "issue", revision: "revision", offset: 10 } },
    ]);
  } finally { dispose(); }
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
  expect(renderers.map(renderer => renderer.kind)).toEqual(["task-description", "thread", "run-summary", "comment-event"]);
  expect(calls).toEqual([]);
  const address = { connectionKey: "connection", issueId: "issue", rootId: "root" };
  const theme = { colors: { foreground: "black", foregroundMuted: "gray" } };
  const threadRenderer = renderers.find(renderer => renderer.kind === "thread")!;
  const eventRenderer = renderers.find(renderer => renderer.kind === "comment-event")!;
  threadRenderer.Component({ item: { data: threadRenderer.schema.parse({ ...address, title: "Thread" }) }, theme });
  for (const effect of effects.splice(0)) effect();
  await Promise.resolve();
  expect(calls).toEqual([{ name: "thread.open", input: address }]);
  const event = eventRenderer.Component({ item: { data: eventRenderer.schema.parse({ ...address, recordId: "correction", commentId: "root", category: "correction", text: "Updated text", sourceUpdatedAt: "2026-11-24T12:00:00Z", truncated: false }) }, theme });
  expect(JSON.stringify(event)).toContain("评论更正");
  expect(JSON.stringify(event)).toContain("Updated text");
  expect(JSON.stringify(event)).toContain("2026-11-24T12:00:00Z");
  const source = eventRenderer.Component({ item: { data: eventRenderer.schema.parse({ ...address, recordId: "original", commentId: "root", category: "source", text: "First observed snapshot", sourceCreatedAt: "2020-01-01T00:00:00Z", sourceUpdatedAt: "2026-11-24T12:00:00Z", truncated: false }) }, theme });
  expect(JSON.stringify(source)).toContain("评论来源");
  expect(JSON.stringify(source)).toContain("2020-01-01T00:00:00Z");
  expect(JSON.stringify(source)).toContain("2026-11-24T12:00:00Z");
  dispose();
});

it("renders each run's agent and actual state as a bounded summary and observes activity after timeline mounting", async () => {
  const effects: Array<() => unknown> = [];
  const calls: Array<{ name: string; input: unknown }> = [];
  const renderers: Array<{ kind: string; schema: zod.ZodType; Component: (props: any) => any }> = [];
  const setup = await bundledContribution("../index.client.tsx", {
    "@getpaseo/plugin/client": { useRpc: (contract: { name: string }) => async (input: unknown) => { calls.push({ name: contract.name, input }); return { status: "ready" }; } },
    "@getpaseo/plugin/client/ui": {}, "react-native": { Text: "Text", View: "View", Pressable: "Pressable" },
    react: { useEffect: (effect: () => unknown) => effects.push(effect), useState: (initial: unknown) => [initial, () => {}] },
  });
  const dispose = setup({ rpc: async () => ({ status: "ready" }), addSettingsScreen: () => () => {}, addScreen: () => () => {}, addSidebarHeaderItem: () => () => {}, addTimelineRenderer: (renderer: any) => { renderers.push(renderer); return () => {}; } });
  try {
    const renderer = renderers.find(renderer => renderer.kind === "run-summary");
    expect(renderer, "a native run needs a visible registered summary renderer").toBeDefined();
    const address = { connectionKey: "connection", issueId: "issue", rootId: "root" };
    const data = renderer!.schema.parse({ ...address, runId: "run-one", agentId: "agent", agentName: "Build Agent", status: "waiting_local_directory" });
    const tree = renderer!.Component({ item: { data }, theme: { colors: { foreground: "black", foregroundMuted: "gray" } } });
    const text = renderedText(tree);
    expect(text).toContain("Build Agent");
    expect(text).toContain("waiting_local_directory");
    expect(calls).toEqual([]);
    for (const effect of effects) effect();
    await Promise.resolve();
    expect(calls).toEqual([{ name: "run.observe", input: address }]);
  } finally { dispose(); }
});

it("expands run messages in source order with honest tool correlation and keeps live detail reads inside expansion", async () => {
  vi.useFakeTimers();
  const calls: Array<{ name: string; input: any }> = [];
  const renderers: Array<{ kind: string; schema: zod.ZodType; Component: (props: any) => any }> = [];
  const state: unknown[] = [];
  const dependencies: unknown[][] = [];
  const cleanups: Array<undefined | (() => void)> = [];
  const effects: Array<() => void> = [];
  let cursor = 0;
  const messages: any[] = [
    { task_id: "run", issue_id: "issue", seq: 1, type: "text", content: "Run text" },
    { task_id: "run", issue_id: "issue", seq: 2, type: "thinking", content: "Run thought" },
    { task_id: "run", issue_id: "issue", seq: 3, type: "tool_use", call_id: "reliable", tool: "read", input: { file: "code.ts" } },
    { task_id: "run", issue_id: "issue", seq: 4, type: "tool_result", call_id: "reliable", output: "Exact output", output_truncated: false },
    { task_id: "run", issue_id: "issue", seq: 5, type: "tool_use", tool: "missing-input" },
    { task_id: "run", issue_id: "issue", seq: 6, type: "tool_result", output: "Unknown completeness" },
    { task_id: "run", issue_id: "issue", seq: 7, type: "tool_result", call_id: "no-input", output: "Partial output", output_truncated: true },
    { task_id: "run", issue_id: "issue", seq: 8, type: "tool_result", call_id: "missing-output", output_truncated: false },
    { task_id: "run", issue_id: "issue", seq: 9, type: "error", content: "Source error" },
    { task_id: "run", issue_id: "issue", seq: 10, type: "tool_use", call_id: "ambiguous", input: {} },
    { task_id: "run", issue_id: "issue", seq: 11, type: "tool_use", call_id: "ambiguous", input: {} },
    { task_id: "run", issue_id: "issue", seq: 12, type: "tool_result", call_id: "ambiguous", output: "Cannot pair" },
  ];
  const rpcs = new Map<string, (input: any) => Promise<any>>();
  const setup = await bundledContribution("../index.client.tsx", {
    react: {
      useState: (initial: unknown) => { const index = cursor++; if (!(index in state)) state[index] = initial; return [state[index], (value: unknown) => { state[index] = typeof value === "function" ? value(state[index]) : value; }]; },
      useEffect: (effect: () => unknown, next: unknown[]) => {
        const index = cursor++;
        if (dependencies[index] && next.every((value, i) => Object.is(value, dependencies[index][i]))) return;
        dependencies[index] = next;
        effects.push(() => { cleanups[index]?.(); const result = effect(); cleanups[index] = typeof result === "function" ? result as () => void : undefined; });
      },
    },
    "@getpaseo/plugin/client": { useRpc: (contract: { name: string }) => {
      if (!rpcs.has(contract.name)) rpcs.set(contract.name, async input => {
        calls.push({ name: contract.name, input });
        if (contract.name === "run.open") return { status: "ready", revision: String(messages.length) };
        if (contract.name === "run.read") return input.offset === 0 ? { text: JSON.stringify(messages).slice(0, 80), nextOffset: 80 } : { text: JSON.stringify(messages).slice(80), nextOffset: null };
        return { status: "ready" };
      });
      return rpcs.get(contract.name);
    } },
    "@getpaseo/plugin/client/ui": {}, "react-native": { Text: "Text", View: "View", Pressable: "Pressable" },
  });
  const dispose = setup({ rpc: async () => ({ status: "ready" }), addSettingsScreen: () => () => {}, addScreen: () => () => {}, addSidebarHeaderItem: () => () => {}, addTimelineRenderer: (renderer: any) => { renderers.push(renderer); return () => {}; } });
  const renderer = renderers.find(value => value.kind === "run-summary")!;
  const data = renderer.schema.parse({ connectionKey: "connection", issueId: "issue", rootId: "root", runId: "run", agentId: "agent", agentName: "Build Agent", status: "running" });
  let actions: Array<{ onPress(): void }> = [];
  const visit = (node: any): string => {
    if (node === null || node === undefined || typeof node === "boolean") return "";
    if (typeof node === "string" || typeof node === "number") return String(node);
    if (Array.isArray(node)) return node.map(visit).join("");
    if (typeof node.type === "function") return visit(node.type(node.props));
    if (node.type === "Pressable") actions.push(node.props);
    return visit(node.props?.children);
  };
  const render = () => { cursor = 0; actions = []; const text = visit(renderer.Component({ item: { data }, theme: { colors: { foreground: "black", foregroundMuted: "gray" } } })); for (const effect of effects.splice(0)) effect(); return text; };
  try {
    expect(render()).toContain("展开执行明细");
    await vi.advanceTimersByTimeAsync(5000);
    expect(calls.map(call => call.name)).toEqual(["run.observe"]);
    actions[0].onPress();
    render();
    await vi.advanceTimersByTimeAsync(0);
    const text = render();
    expect(text).toContain("Run text");
    expect(text.indexOf("Run thought")).toBeGreaterThan(text.indexOf("Run text"));
    expect(text.indexOf("Exact output")).toBeGreaterThan(text.indexOf("code.ts"));
    expect(text.indexOf("Source error")).toBeGreaterThan(text.indexOf("Partial output"));
    expect(text).toContain("结果序号 #4");
    expect(text).toContain("输入序号 #3");
    expect(text).toContain("调用关联未知");
    expect(text).toContain("工具输入缺失");
    expect(text).toContain("输出完整性未知");
    expect(text).toContain("源端已截断");
    expect(text).toContain("输出缺失");
    expect(text).toContain("调用 ID：ambiguous · 调用关联未知（调用 ID 不唯一）");
    messages.push({ task_id: "run", issue_id: "issue", seq: 13, type: "text", content: "Live update" });
    await vi.advanceTimersByTimeAsync(2100);
    expect(render()).toContain("Live update");
    expect(calls.filter(call => call.name === "run.read").map(call => call.input.offset)).toEqual([0, 80, 0, 80]);
    actions[0].onPress();
    render();
    const before = calls.filter(call => call.name === "run.open").length;
    await vi.advanceTimersByTimeAsync(6000);
    expect(calls.filter(call => call.name === "run.open")).toHaveLength(before);
  } finally { for (const cleanup of cleanups) cleanup?.(); dispose(); vi.useRealTimers(); }
});

it("management lists shared hidden objects and offers separate workspace and selected-tab restoration", async () => {
  const effects: Array<() => unknown> = [];
  const cleanups: Array<() => void> = [];
  const actions: Array<{ actionLabel: string; onPress(): unknown }> = [];
  const state: unknown[] = [];
  const calls: Array<{ name: string; input: unknown }> = [];
  let cursor = 0;
  let Component: (props: unknown) => unknown = () => null;
  const objects = [
    { connectionKey: "old-connection", issueId: "issue", workspaceId: "workspace", cwd: "/original", kind: "workspace", title: "Task" },
    { connectionKey: "old-connection", issueId: "issue", workspaceId: "workspace", cwd: "/original", kind: "thread", rootId: "root", agentId: "original-agent", title: "Task · Root" },
  ];
  const rpcs = new Map<string, (input: unknown) => Promise<unknown>>();
  const passthrough = (props: { label?: string; title?: string; hint?: string; children?: unknown }) => [props.label, props.title, props.hint, props.children];
  const setup = await bundledContribution("../index.client.tsx", {
    react: { useState: (initial: unknown) => {
      const index = cursor++;
      if (!(index in state)) state[index] = initial;
      return [state[index], (value: unknown) => { state[index] = typeof value === "function" ? value(state[index]) : value; }];
    }, useEffect: (effect: () => unknown) => effects.push(effect) },
    "@getpaseo/plugin/client": {
      useSettings: () => ({ status: "ready", values: { profile: "" }, revision: "1" }),
      useRpc: (contract: { name: string }) => {
        if (!rpcs.has(contract.name)) rpcs.set(contract.name, async input => {
          calls.push({ name: contract.name, input });
          if (contract.name === "stop.list") return { records: [{ connectionKey: "old-connection", issueId: "issue", rootId: "root", runId: "failed-run", title: "Closed Task", status: "running", cleanup: "unknown", retryable: true, message: "cancel failed" },
            { connectionKey: "old-connection", issueId: "issue", rootId: "root", runId: "cancelled-run", title: "Stopped Task", status: "cancelled", cleanup: "pending", retryable: false }] };
          if (contract.name === "stop.retry") return { status: "ready" };
          if (contract.name === "hidden.list") return { objects };
          if (contract.name === "hidden.restore") return { status: "ready" };
          if (contract.name === "workspace.list") return { workspaces: [] };
          return { status: "offline", message: "offline", profile: "", source: { api: "none", credentials: "none", app: "none" } };
        });
        return rpcs.get(contract.name);
      },
    },
    "@getpaseo/plugin/client/ui": { SettingsSection: passthrough, SettingsCard: passthrough, SettingsInput: passthrough, SettingsRow: passthrough,
      SettingsAction: (props: { label: string; actionLabel: string; onPress(): unknown }) => { actions.push(props); return [props.label, props.actionLabel]; } },
    "react-native": { View: "View", Text: "Text" },
  });
  const dispose = setup({ rpc: async () => ({ status: "ready" }), addSettingsScreen: () => () => {}, addScreen: (entry: { Component: typeof Component }) => { Component = entry.Component; return () => {}; },
    addSidebarHeaderItem: () => () => {}, addTimelineRenderer: () => () => {} });
  const render = () => { cursor = 0; actions.length = 0; return renderedText(Component({ host: { id: "host", label: "Host" }, theme: { colors: {} } })); };
  try {
    render();
    for (const effect of effects.splice(0)) { const cleanup = effect(); if (typeof cleanup === "function") cleanups.push(cleanup as () => void); }
    await vi.waitFor(() => { expect(render()).toContain("人工隐藏"); expect(render()).toContain("Task · Root"); });
    expect(render()).toContain("原生停止结果");
    expect(render()).toContain("cancel failed");
    expect(render()).toContain("进程清理尚待确认");
    actions.find(action => action.actionLabel === "重试此 Run")!.onPress();
    await vi.waitFor(() => expect(calls).toContainEqual({ name: "stop.retry", input: { connectionKey: "old-connection", issueId: "issue", rootId: "root", runId: "failed-run" } }));
    expect(actions.map(action => action.actionLabel)).toContain("仅恢复工作区");
    const action = actions.find(action => action.actionLabel === "恢复此讨论")!;
    action.onPress();
    await vi.waitFor(() => expect(calls).toContainEqual({ name: "hidden.restore", input: { connectionKey: "old-connection", issueId: "issue", rootId: "root" } }));
  } finally { for (const cleanup of cleanups) cleanup(); dispose(); }
});
