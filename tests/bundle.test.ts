import { build } from "paseo-esbuild";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { runInThisContext } from "node:vm";
import { createElement, isValidElement, type FunctionComponent } from "react";
import type { PluginTimelineRendererContribution } from "@getpaseo/plugin/client";
import * as pluginRuntime from "@getpaseo/plugin";
import * as zod from "zod";
import { expect, it, vi } from "vitest";
import type { ProfileList, TaskRule } from "../shared/contracts.js";
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

it("the host-compiled server entry registers CLI connection settings", async () => {
  const setup = await bundledContribution("../index.server.ts");
  const server = new FakeServer();
  const dispose = setup(server.context);
  expect(server.settings.has("multica")).toBe(true);
  expect(server.providers.has("multica")).toBe(true);
  await dispose();
}, 15_000);

it("the host-compiled client entry offers only the Multica settings screen", async () => {
  const setup = await bundledContribution("../index.client.tsx", { "@getpaseo/plugin/client": {}, "@getpaseo/plugin/client/ui": {}, "react-native": {} });
  const entries: Array<{ kind: string; id: string; Component?: unknown }> = [];
  const add = (kind: string) => (entry: { id: string; Component?: unknown }) => {
    entries.push({ kind, ...entry });
    return () => { entries.splice(entries.findIndex(value => value.kind === kind && value.id === entry.id), 1); };
  };
  const dispose = setup({ rpc: async () => ({ status: "ready" }), addSettingsScreen: add("settings"), addScreen: add("screen"), addSidebarHeaderItem: add("sidebar"), addTimelineRenderer: () => () => {} });
  expect(entries.map(({ kind, id }) => ({ kind, id }))).toEqual([
    { kind: "settings", id: "multica" },
  ]);
  expect(entries.every(entry => typeof entry.Component === "function")).toBe(true);
  dispose();
  expect(entries).toEqual([]);
});

it("client bootstrap keeps running through successful connections and daemon restarts", async () => {
  const setup = await bundledContribution("../index.client.tsx", { "@getpaseo/plugin/client": {}, "@getpaseo/plugin/client/ui": {}, "react-native": {} });
  vi.useFakeTimers();
  try {
    const calls: string[] = [];
    const dispose = setup({ rpc: async (contract: { name: string }) => {
      calls.push(contract.name);
      if (calls.length === 1 || calls.length === 4)
        throw new Error("daemon restarted");
      return { status: "ready" };
    },
      addSettingsScreen: () => () => {}, addScreen: () => () => {}, addSidebarHeaderItem: () => () => {}, addTimelineRenderer: () => () => {} });
    await Promise.resolve();
    expect(calls).toEqual(["sync.bootstrap"]);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(calls).toEqual(["sync.bootstrap", "sync.bootstrap"]);
    await vi.advanceTimersByTimeAsync(20_000);
    expect(calls).toHaveLength(4);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(calls).toHaveLength(5);
    dispose();
    await vi.advanceTimersByTimeAsync(20_000);
    expect(calls).toHaveLength(5);
  } finally { vi.useRealTimers(); }
});

type PickerItem = { id: string; label: string; description?: string; reference: string };
/** A Paseo 0.16+ host: composer items exist and the bundle reaches the composer through `useComposer`. */
async function pickerHarness(answer: (input: unknown) => Promise<{ agents: unknown[] }>, composer: Record<string, unknown>) {
  const refs: unknown[] = [];
  let cursor = 0;
  const calls: unknown[] = [], inserted: string[] = [], focused: string[] = [];
  const surface = { context: "agent", prompt: "", agent: { provider: "multica", metadata: {} as Record<string, unknown> },
    insertText: (text: string) => { inserted.push(text); }, focus: async () => { focused.push("focused"); }, ...composer };
  const setup = await bundledContribution("../index.client.tsx", {
    react: { useRef: (initial: unknown) => (refs[cursor++] ??= { current: initial }) },
    "@getpaseo/plugin/client": { useComposer: () => surface, useRpc: () => async (input: unknown) => { calls.push(input); return answer(input); } },
    "@getpaseo/plugin/client/ui": { Combobox: () => null }, "react-native": {},
  });
  const items: Array<{ id: string; Component: (props: unknown) => unknown }> = [];
  const dispose = setup({ rpc: async () => ({ status: "ready" }), addSettingsScreen: () => () => {}, addScreen: () => () => {}, addSidebarHeaderItem: () => () => {}, addTimelineRenderer: () => () => {},
    addComposerItem: (entry: typeof items[number]) => { items.push(entry); return () => { items.splice(items.indexOf(entry), 1); }; } });
  expect(items.map(item => item.id)).toEqual(["multica-mention"]);
  return {
    calls, inserted, focused, dispose, items,
    render: () => {
      cursor = 0;
      return items[0].Component({ theme: { colors: {} }, host: { id: "host", label: "Host" }, layout: { compact: false, platform: "web" } }) as unknown as { props: { title: string; icon: string; value: null; search(event: { query: string }): Promise<readonly PickerItem[]>; onSelect(event: { item: PickerItem }): Promise<void> } } | null;
    },
  };
}
const builder = (tail: string) => ({ id: `9f3c1a2e-0000-4000-8000-00000000000${tail}`, name: "Builder", reference: `[@Builder](mention://agent/9f3c1a2e-0000-4000-8000-00000000000${tail})` });
const task = { "multica.connection": "connection", "multica.issue": "issue" };

it("the composer's agent picker reads the discussion's agents once per opening and inserts the chosen canonical reference", async () => {
  const agents = [builder("1"), builder("2")];
  const h = await pickerHarness(async () => ({ agents }), { prompt: "请检查", agent: { provider: "multica", metadata: task } });
  try {
    const picker = h.render()!;
    expect(picker).toMatchObject({ props: { title: "提及 Agent", icon: "AtSign", value: null } });
    expect(h.calls).toEqual([]);
    const choice = (agent: typeof agents[number]) => ({ ...agent, label: "Builder", description: `ID ${agent.id}` });
    expect(await picker.props.search({ query: "" })).toEqual([choice(agents[0]), choice(agents[1])]);
    expect(h.calls).toEqual([{ connectionKey: "connection", issueId: "issue" }]);
    // Typing filters the reading taken when the list opened; case and surrounding spaces do not matter,
    // and agents with the same name stay apart by ID.
    expect(await picker.props.search({ query: " BUIL" })).toEqual([choice(agents[0]), choice(agents[1])]);
    expect(await picker.props.search({ query: "0002" })).toEqual([choice(agents[1])]);
    expect(await picker.props.search({ query: "nobody" })).toEqual([]);
    expect(h.calls).toHaveLength(1);
    // Opening the list again reads the task's agents again.
    await picker.props.search({ query: "" });
    expect(h.calls).toHaveLength(2);
    await picker.props.onSelect({ item: choice(agents[1]) });
    // A reference directly after "!" or "\" is not a link in Markdown, so a non-empty prompt keeps a gap before it.
    expect(h.inserted).toEqual([` ${agents[1].reference} `]);
    expect(h.focused).toEqual(["focused"]);
  } finally { h.dispose(); }
  const empty = await pickerHarness(async () => ({ agents }), { agent: { provider: "multica", metadata: task } });
  try {
    await empty.render()!.props.onSelect({ item: { ...agents[0], label: "Builder", description: "" } });
    expect(empty.inserted).toEqual([`${agents[0].reference} `]);
  } finally { empty.dispose(); }
});

it.each([
  ["a draft composer", { context: "draft" }],
  ["a discussion whose task was not copied into metadata", { agent: { provider: "multica", metadata: {} } }],
  ["metadata that does not name a task", { agent: { provider: "multica", metadata: { ...task, "multica.issue": 7 } } }],
])("the composer's agent picker stays out of %s", async (_name, composer) => {
  const h = await pickerHarness(async () => ({ agents: [builder("1")] }), { agent: { provider: "multica", metadata: task }, ...composer });
  try { expect(h.render()).toBeNull(); expect(h.calls).toEqual([]); } finally { h.dispose(); }
});

it("a picker whose agent reading fails shows the failure and reads again on the next query", async () => {
  let offline = true;
  const agents = [builder("1")];
  const h = await pickerHarness(async () => {
    if (offline)
      throw new Error("CLI 未登录");
    return { agents };
  }, { agent: { provider: "multica", metadata: task } });
  try {
    const picker = h.render()!;
    await expect(picker.props.search({ query: "" })).rejects.toThrow("CLI 未登录");
    offline = false;
    expect(await picker.props.search({ query: "" })).toHaveLength(1);
  } finally { h.dispose(); }
});

it("the client removes the composer's agent picker when the contribution stops", async () => {
  const h = await pickerHarness(async () => ({ agents: [] }), {});
  h.dispose();
  expect(h.items).toEqual([]);
});

function renderedText(node: unknown): string {
  if (typeof node === "string") return node;
  if (typeof node === "number") return String(node);
  if (Array.isArray(node)) return node.map(renderedText).join("");
  if (!isValidElement<{ children?: unknown }>(node)) return "";
  return renderedText(typeof node.type === "function" ? (node.type as (props: unknown) => unknown)(node.props) : node.props.children);
}

it("the client renders the task description as visible Markdown and removes its renderer on disposal", async () => {
  const renderers: PluginTimelineRendererContribution[] = [];
  const setup = await bundledContribution("../index.client.tsx", {
    "react": { useEffect: () => {}, useState: (value: unknown) => [value, () => {}] },
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
    react: { useEffect: () => {}, useState: (initial: unknown) => {
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
    addSidebarHeaderItem: () => () => {}, addTimelineRenderer: (renderer: PluginTimelineRendererContribution) => {
      renderers.push(renderer);
      return () => {};
    } });
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

it.each(["task-description"])("the compiled %s reader stops stalled cursors and cancels further pages on unmount", async kind => {
  vi.useFakeTimers();
  const renderers: Array<{ kind: string; Component: (props: any) => any }> = [];
  const state: unknown[] = [], dependencies: unknown[][] = [];
  const effects: Array<() => void> = [], cleanups: Array<undefined | (() => void)> = [];
  const actions: Array<{ onPress(): void }> = [];
  const calls: number[] = [];
  const rpcs = new Map<string, (input: any) => Promise<any>>();
  let cursor = 0, cancelled = false;
  let release: (value: unknown) => void = () => {};
  const data = kind === "task-description" ? { connectionKey: "connection", issueId: "issue", revision: "revision", preview: "Preview", truncated: true }
    : { connectionKey: "connection", issueId: "issue", rootId: "root", clientMessageId: "input", idempotencyKey: "key", body: "Preview", truncated: true, createdAt: "2026-11-24T10:00:00Z", status: "failed" };
  const setup = await bundledContribution("../index.client.tsx", {
    react: {
      useState: (initial: unknown) => {
        const index = cursor++;
        if (!(index in state))
          state[index] = initial;
        return [state[index], (value: unknown) => {
          state[index] = typeof value === "function" ? value(state[index]) : value;
        }];
      },
      useEffect: (effect: () => unknown, next: unknown[]) => {
        const index = cursor++;
        if (dependencies[index] && next.every((value, i) => Object.is(value, dependencies[index][i]))) return;
        dependencies[index] = next;
        effects.push(() => {
          cleanups[index]?.();
          const result = effect();
          cleanups[index] = typeof result === "function" ? result as () => void : undefined;
        });
      },
    },
    "@getpaseo/plugin/client": { useRpc: (contract: { name: string }) => {
      if (!rpcs.has(contract.name)) rpcs.set(contract.name, async input => {
        if (!contract.name.endsWith(".read")) return data;
        calls.push(input.offset);
        if (cancelled) return new Promise(resolve => { release = resolve; });
        if (calls.length > 2) throw new Error("Fixture rejected repeated read");
        return { text: "partial", nextOffset: 8 };
      });
      return rpcs.get(contract.name);
    } },
    "@getpaseo/plugin/client/ui": { Markdown: ({ children }: any) => children, SettingsAction: ({ onPress, actionLabel }: any) => {
      actions.push({ onPress });
      return actionLabel;
    } },
    "react-native": { View: "View", Text: "Text", Pressable: ({ onPress, children }: any) => { actions.push({ onPress }); return children; } },
  });
  const dispose = setup({ rpc: async () => ({}), addSettingsScreen: () => () => {}, addScreen: () => () => {}, addSidebarHeaderItem: () => () => {}, addTimelineRenderer: (renderer: any) => {
    renderers.push(renderer);
    return () => {};
  } });
  const renderer = renderers.find(renderer => renderer.kind === kind)!;
  const render = () => {
    cursor = 0;
    actions.length = 0;
    const text = renderedText(renderer.Component({ item: { data }, theme: { colors: {} } }));
    for (const effect of effects.splice(0))
      effect();
    return text;
  };
  try {
    render(); actions[0].onPress();
    await vi.advanceTimersByTimeAsync(0);
    expect(render()).toContain(kind === "task-description" ? "完整描述暂不可用" : "无法读取原输入");
    expect(calls).toEqual([0, 8]);
    expect(render()).toContain("Preview");
    calls.length = 0; cancelled = true;
    actions[0].onPress();
    await vi.advanceTimersByTimeAsync(0);
    for (const cleanup of cleanups) cleanup?.();
    release({ text: "partial after unmount", nextOffset: 8 });
    await vi.advanceTimersByTimeAsync(0);
    expect(calls).toEqual([0]);
  } finally { for (const cleanup of cleanups) cleanup?.(); dispose(); vi.useRealTimers(); }
});

it.each(["root", "main"])("the invisible %s thread renderer still opens history and comment events render independently", async rootId => {
  const effects: Array<() => unknown> = [];
  const calls: Array<{ name: string; input: unknown }> = [];
  const renderers: Array<{ kind: string; schema: zod.ZodType; Component: (props: any) => any }> = [];
  const setup = await bundledContribution("../index.client.tsx", {
    "@getpaseo/plugin/client": { useRpc: (contract: { name: string }) => async (input: unknown) => {
      calls.push({ name: contract.name, input });
      return { status: "ready" };
    } },
    "@getpaseo/plugin/client/ui": {}, "react-native": { Text: "Text", View: "View", Pressable: "Pressable" },
    react: { useEffect: (effect: () => unknown) => effects.push(effect), useState: (initial: unknown) => [initial, () => {}] },
  });
  const dispose = setup({ rpc: async () => ({ status: "ready" }), addSettingsScreen: () => () => {}, addScreen: () => () => {}, addSidebarHeaderItem: () => () => {},
    addTimelineRenderer: (renderer: any) => { renderers.push(renderer); return () => {}; } });
  expect(renderers.map(renderer => renderer.kind)).toEqual(["task-description", "thread", "run-summary", "comment-event", "askuser", "comment-delivery"]);
  expect(calls).toEqual([]);
  const address = { connectionKey: "connection", issueId: "issue", rootId };
  const theme = { colors: { foreground: "black", foregroundMuted: "gray" } };
  const threadRenderer = renderers.find(renderer => renderer.kind === "thread")!;
  const eventRenderer = renderers.find(renderer => renderer.kind === "comment-event")!;
  expect(threadRenderer.Component({ item: { data: threadRenderer.schema.parse({ ...address, title: "Thread" }) }, theme })).toBeNull();
  const cleanups = effects.splice(0).map(effect => effect());
  await Promise.resolve();
  expect(calls).toEqual([{ name: "thread.open", input: address }]);
  for (const cleanup of cleanups) if (typeof cleanup === "function") cleanup();
  const event = eventRenderer.Component({ item: { data: eventRenderer.schema.parse({ ...address, recordId: "correction", commentId: "root", category: "correction", text: "Updated text", sourceUpdatedAt: "2026-11-24T12:00:00Z", truncated: false }) }, theme });
  expect(JSON.stringify(event)).toContain("评论更正");
  expect(JSON.stringify(event)).toContain("Updated text");
  expect(JSON.stringify(event)).toContain("2026-11-24T12:00:00Z");
  dispose();
});

it("the main-discussion success renderer shows only a brief Thread hint", async () => {
  const renderers: Array<{ kind: string; schema: zod.ZodType; Component: (props: any) => any }> = [];
  const setup = await bundledContribution("../index.client.tsx", {
    "@getpaseo/plugin/client": { useRpc: () => async () => ({}) }, "@getpaseo/plugin/client/ui": {},
    "react-native": { Text: "Text", View: "View", Pressable: "Pressable" },
    react: { useState: (initial: unknown) => [initial, () => {}], useEffect: () => {} },
  });
  const dispose = setup({ rpc: async () => ({ status: "ready" }), addSettingsScreen: () => () => {}, addScreen: () => () => {}, addSidebarHeaderItem: () => () => {}, addTimelineRenderer: (renderer: any) => {
    renderers.push(renderer);
    return () => {};
  } });
  try {
    const renderer = renderers.find(renderer => renderer.kind === "comment-delivery");
    expect(renderer).toBeDefined();
    const text = renderedText(renderer!.Component({ item: { data: renderer!.schema.parse({}) }, theme: { colors: { foregroundMuted: "gray" } } }));
    expect(text).toBe("新 Thread 已建立，可在侧边栏打开。");
  } finally { dispose(); }
});

it("renders each run's agent and actual state as a bounded summary and observes activity after timeline mounting", async () => {
  const effects: Array<() => unknown> = [];
  const calls: Array<{ name: string; input: unknown }> = [];
  const renderers: Array<{ kind: string; schema: zod.ZodType; Component: (props: any) => any }> = [];
  const setup = await bundledContribution("../index.client.tsx", {
    "@getpaseo/plugin/client": { useRpc: (contract: { name: string }) => async (input: unknown) => {
      calls.push({ name: contract.name, input });
      return { status: "ready" };
    } },
    "@getpaseo/plugin/client/ui": {}, "react-native": { Text: "Text", View: "View", Pressable: "Pressable" },
    react: { useEffect: (effect: () => unknown) => effects.push(effect), useState: (initial: unknown) => [initial, () => {}] },
  });
  const dispose = setup({ rpc: async () => ({ status: "ready" }), addSettingsScreen: () => () => {}, addScreen: () => () => {}, addSidebarHeaderItem: () => () => {}, addTimelineRenderer: (renderer: any) => {
    renderers.push(renderer);
    return () => {};
  } });
  try {
    const renderer = renderers.find(renderer => renderer.kind === "run-summary");
    expect(renderer, "a native run needs a visible registered summary renderer").toBeDefined();
    const address = { connectionKey: "connection", issueId: "issue", rootId: "root" };
    const data = renderer!.schema.parse({ ...address, runId: "run-one", agentId: "agent", agentName: "Build Agent", status: "waiting_local_directory" });
    const tree = renderer!.Component({ item: { data }, theme: { colors: { foreground: "black", foregroundMuted: "gray" } } });
    const text = renderedText(tree);
    expect(text).toContain("Build Agent");
    expect(text).toContain("waiting_local_directory");
    expect(text).not.toContain("Run ");
    expect(text).not.toContain("Agent agent");
    expect(calls).toEqual([]);
    for (const effect of effects) effect();
    await Promise.resolve();
    expect(calls).toEqual([{ name: "run.observe", input: address }]);
  } finally { dispose(); }
});

it.each(["messages", "empty", "unavailable", "terminal"])("expands source Run metadata with %s output and keeps detail reads inside expansion", async mode => {
  vi.useFakeTimers();
  const calls: Array<{ name: string; input: any }> = [];
  const renderers: Array<{ kind: string; schema: zod.ZodType; Component: (props: any) => any }> = [];
  const state: unknown[] = [];
  const dependencies: unknown[][] = [];
  const cleanups: Array<undefined | (() => void)> = [];
  const effects: Array<() => void> = [];
  let cursor = 0;
  const metadata = { error: "Runtime failed before streaming", failure_reason: "local_directory_error", work_dir: "/remote/agent/../checkout with spaces", relative_work_dir: "../checkout with spaces" };
  const messages: any[] = mode === "messages" ? [
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
  ] : [];
  const rpcs = new Map<string, (input: any) => Promise<any>>();
  const setup = await bundledContribution("../index.client.tsx", {
    react: {
      useState: (initial: unknown) => {
        const index = cursor++;
        if (!(index in state))
          state[index] = initial;
        return [state[index], (value: unknown) => {
          state[index] = typeof value === "function" ? value(state[index]) : value;
        }];
      },
      useEffect: (effect: () => unknown, next: unknown[]) => {
        const index = cursor++;
        if (dependencies[index] && next.every((value, i) => Object.is(value, dependencies[index][i]))) return;
        dependencies[index] = next;
        effects.push(() => {
          cleanups[index]?.();
          const result = effect();
          cleanups[index] = typeof result === "function" ? result as () => void : undefined;
        });
      },
    },
    "@getpaseo/plugin/client": { useRpc: (contract: { name: string }) => {
      if (!rpcs.has(contract.name)) rpcs.set(contract.name, async input => {
        calls.push({ name: contract.name, input });
        if (contract.name === "run.open")
          return { status: mode === "unavailable" ? "cached" : "ready", ...(mode !== "unavailable" ? { revision: String(messages.length) } : {}), metadataRevision: "metadata", message: mode === "unavailable" ? "No message cache" : undefined };
        if (contract.name === "run.read" && input.kind === "metadata")
          return input.offset === 0 ? { text: JSON.stringify(metadata).slice(0, 40), nextOffset: 40 } : { text: JSON.stringify(metadata).slice(40), nextOffset: null };
        if (contract.name === "run.read")
          return input.offset === 0 ? { text: JSON.stringify(messages).slice(0, 80), nextOffset: 80 } : { text: JSON.stringify(messages).slice(80), nextOffset: null };
        return { status: "ready" };
      });
      return rpcs.get(contract.name);
    } },
    "@getpaseo/plugin/client/ui": {}, "react-native": { Text: "Text", View: "View", Pressable: "Pressable" },
  });
  const dispose = setup({ rpc: async () => ({ status: "ready" }), addSettingsScreen: () => () => {}, addScreen: () => () => {}, addSidebarHeaderItem: () => () => {}, addTimelineRenderer: (renderer: any) => {
    renderers.push(renderer);
    return () => {};
  } });
  const renderer = renderers.find(value => value.kind === "run-summary")!;
  const data = renderer.schema.parse({ connectionKey: "connection", issueId: "issue", rootId: "root", runId: "run", agentId: "agent", agentName: "Build Agent", status: mode === "terminal" ? "completed" : "running" });
  let actions: Array<{ onPress(): void }> = [];
  const visit = (node: any): string => {
    if (node === null || node === undefined || typeof node === "boolean") return "";
    if (typeof node === "string" || typeof node === "number") return String(node);
    if (Array.isArray(node)) return node.map(visit).join("");
    if (typeof node.type === "function") return visit(node.type(node.props));
    if (node.type === "Pressable") actions.push(node.props);
    return visit(node.props?.children);
  };
  const render = () => {
    cursor = 0;
    actions = [];
    const text = visit(renderer.Component({ item: { data }, theme: { colors: { foreground: "black", foregroundMuted: "gray" } } }));
    for (const effect of effects.splice(0))
      effect();
    return text;
  };
  try {
    expect(render()).toContain("展开执行明细");
    await vi.advanceTimersByTimeAsync(5000);
    expect(calls.map(call => call.name)).toEqual(["run.observe"]);
    actions[0].onPress();
    render();
    await vi.advanceTimersByTimeAsync(0);
    const text = render();
    expect(text).toContain("Runtime failed before streaming");
    expect(text).toContain("local_directory_error");
    expect(text).toContain("远端目录");
    expect(text).not.toContain("REMOTE");
    expect(text).toContain("/remote/agent/../checkout with spaces");
    expect(text).toContain("../checkout with spaces");
    expect(calls.filter(call => call.name === "run.read" && call.input.kind === "metadata").map(call => call.input.offset)).toEqual([0, 40]);
    if (mode === "messages") {
      expect(text).toContain("Run text");
      expect(text.indexOf("Run thought")).toBeGreaterThan(text.indexOf("Run text"));
      expect(text.indexOf("Exact output")).toBeGreaterThan(text.indexOf("code.ts"));
      expect(text.indexOf("Source error")).toBeGreaterThan(text.indexOf("Partial output"));
      expect(text).not.toContain("调用 ID");
      expect(text).not.toContain("调用关联");
      expect(text).toContain("工具输入缺失");
      expect(text).not.toContain("输出完整性未知");
      expect(text).not.toContain("来源标记输出完整");
      expect(text).toContain("源端已截断");
      expect(text).toContain("输出缺失");
      messages.push({ task_id: "run", issue_id: "issue", seq: 13, type: "text", content: "Live update" });
      await vi.advanceTimersByTimeAsync(2100);
      expect(render()).toContain("Live update");
      expect(calls.filter(call => call.name === "run.read" && call.input.kind === "messages").map(call => call.input.offset)).toEqual([0, 80, 0, 80]);
    }
    if (mode === "terminal") {
      const reads = calls.filter(call => call.name === "run.open").length;
      await vi.advanceTimersByTimeAsync(6000);
      expect(calls.filter(call => call.name === "run.open")).toHaveLength(reads);
    }
    actions[0].onPress();
    render();
    const before = calls.filter(call => call.name === "run.open").length;
    await vi.advanceTimersByTimeAsync(6000);
    expect(calls.filter(call => call.name === "run.open")).toHaveLength(before);
  } finally { for (const cleanup of cleanups) cleanup?.(); dispose(); vi.useRealTimers(); }
});

/**
 * Hooks for calling bundled components directly. Like React, state and effects belong to a component's
 * place in the tree, so a child that mounts later does not shift the state of the components after it.
 * Effects run after each render when their dependencies change; cleanups run before a re-run and on unmount.
 */
function componentTree() {
  const state = new Map<string, unknown>();
  const mounted = new Map<string, { deps?: unknown[]; cleanup?: () => void }>();
  const pending = new Map<string, { effect: () => unknown; deps?: unknown[] }>();
  let visited = new Set<string>();
  let scope = "", stateIndex = 0, effectIndex = 0;
  const react = {
    useState: (initial: unknown) => {
      const id = `${scope}#${stateIndex++}`;
      if (!state.has(id)) state.set(id, typeof initial === "function" ? (initial as () => unknown)() : initial);
      return [state.get(id), (value: unknown) => { state.set(id, typeof value === "function" ? (value as (previous: unknown) => unknown)(state.get(id)) : value); }];
    },
    useRef: (initial: unknown) => react.useState({ current: initial })[0],
    useEffect: (effect: () => unknown, deps?: unknown[]) => {
      const id = `${scope}@${effectIndex++}`;
      const previous = mounted.get(id)?.deps;
      if (previous && deps && previous.length === deps.length && deps.every((value, index) => Object.is(value, previous[index]))) return;
      pending.set(id, { effect, deps });
    },
  };
  function visit(node: unknown, path: string): string {
    if (typeof node === "string") return node;
    if (typeof node === "number") return String(node);
    if (Array.isArray(node)) return node.map((child, position) => visit(child, `${path}.${isValidElement(child) && child.key !== null ? child.key : position}`)).join("");
    if (!isValidElement<{ children?: unknown }>(node)) return "";
    if (typeof node.type !== "function") return visit(node.props.children, path);
    const own = `${path}/${node.type.name || "component"}`;
    visited.add(own);
    const saved = [scope, stateIndex, effectIndex] as const;
    [scope, stateIndex, effectIndex] = [own, 0, 0];
    let output: unknown;
    try { output = (node.type as (props: unknown) => unknown)(node.props); } finally { [scope, stateIndex, effectIndex] = saved; }
    return visit(output, own);
  }
  return {
    react,
    render(node: unknown) {
      visited = new Set();
      const text = visit(node, "");
      for (const [id, entry] of mounted) if (!visited.has(id.slice(0, id.lastIndexOf("@")))) { entry.cleanup?.(); mounted.delete(id); }
      for (const id of state.keys()) if (!visited.has(id.slice(0, id.lastIndexOf("#")))) state.delete(id);
      for (const [id, { effect, deps }] of [...pending]) {
        pending.delete(id);
        mounted.get(id)?.cleanup?.();
        const cleanup = effect();
        mounted.set(id, { deps, cleanup: typeof cleanup === "function" ? cleanup as () => void : undefined });
      }
      return text;
    },
    unmount() { for (const entry of mounted.values()) entry.cleanup?.(); mounted.clear(); },
  };
}

type Answer = (name: string, input: unknown) => unknown;
/** `host.composerItems` is a Paseo 0.16+ host; without it the client context is the 0.15 surface. */
async function settingsHarness(answer: Answer, host: { composerItems?: boolean } = {}) {
  const tree = componentTree();
  const calls: Array<{ name: string; input: unknown }> = [];
  const actions: Array<{ label: string; hint?: string; actionLabel: string; disabled?: boolean; onPress(): unknown }> = [];
  const switches: Array<{ label: string; value: boolean; disabled?: boolean; onValueChange(value: boolean): unknown }> = [];
  const selects: Array<{ label: string; value: string; options: { label: string; value: string }[]; disabled?: boolean; hint?: string; error?: string; onValueChange(value: string): unknown }> = [];
  const pressables: Array<{ accessibilityLabel?: string; accessibilityRole?: string; accessibilityState?: { checked?: boolean | "mixed" }; disabled?: boolean; style?: { borderStyle?: string }; onPress(): unknown }> = [];
  const inputs: Array<{ accessibilityLabel: string; value: string; onChangeText(value: string): void }> = [];
  const modals: Array<{ title: string; onOpenChange(open: boolean): void }> = [];
  const modalContents: Array<{ scrollable?: boolean; children: unknown }> = [];
  const copied: string[] = [];
  const opened: unknown[] = [];
  const navigation: unknown[] = [];
  const scrolls: Array<{ style?: unknown; contentContainerStyle?: unknown }> = [];
  const rpcs = new Map<string, (input: unknown) => Promise<unknown>>();
  let profile = "";
  const settings = { status: "ready", saving: false, saveError: null as string | null, error: "Settings validation failed" };
  const settingsSave = vi.fn(async (values: { profile: string }, _revision: string) => { profile = values.profile; return true; });
  const settingsReload = vi.fn(async () => {});
  const settingsReset = vi.fn(async () => { profile = ""; settings.status = "ready"; return true; });
  const passthrough = (props: Record<string, unknown>) => [props.label, props.title, props.info, props.hint, props.error, props.trailing, props.children];
  const setup = await bundledContribution("../index.client.tsx", {
    react: tree.react,
    "@getpaseo/plugin/client": {
      useSettings: () => ({ ...settings, values: { profile }, revision: "1", reload: settingsReload, save: settingsSave, reset: settingsReset }),
      useRpc: (contract: { name: string }) => {
        if (!rpcs.has(contract.name)) rpcs.set(contract.name, async input => { calls.push({ name: contract.name, input }); return contract.name === "connection.status" ? { sync: { status: "ready", stage: "idle", completedWorkspaces: 1, enabledWorkspaces: 1 }, hidden: [], ...(await answer(contract.name, input) as object) } : answer(contract.name, input); });
        return rpcs.get(contract.name);
      },
    },
    "@getpaseo/plugin/client/ui": {
      Markdown: ({ children }: { children: string }) => children, Icon: () => null, ExternalLink: ({ children }: { children: unknown }) => children,
      SettingsSection: passthrough, SettingsCard: passthrough, SettingsRow: passthrough,
      SettingsAction: (props: typeof actions[number] & { error?: string }) => { actions.push(props); return [props.label, props.hint, props.error, props.actionLabel]; },
      SettingsSwitch: (props: typeof switches[number] & { hint?: string }) => { switches.push(props); return [props.label, props.hint]; },
      SettingsSelect: (props: typeof selects[number]) => { selects.push(props); return [props.label, props.hint, props.error]; },
      Modal: Object.assign((props: typeof modals[number] & { children: unknown }) => { modals.push(props); return [props.title, props.children]; },
        { Content: (props: typeof modalContents[number]) => { modalContents.push(props); return props.children; } }),
      TextInput: (props: typeof inputs[number]) => { inputs.push(props); return null; },
      copyText: async (text: string) => { copied.push(text); },
      ScrollView: (props: typeof scrolls[number] & { children?: unknown }) => { scrolls.push(props); return props.children; },
    },
    "react-native": { View: "View", Text: "Text", Pressable: (props: typeof pressables[number] & { children: unknown }) => { pressables.push(props); return props.children; } },
  });
  const screens: Record<string, FunctionComponent<Record<string, unknown>>> = {};
  const composerItems: string[] = [];
  const dispose = setup({ rpc: async () => ({ status: "ready" }), openScreen: (input: unknown) => opened.push(input),
    addSettingsScreen: (entry: { Component: FunctionComponent<Record<string, unknown>> }) => { screens.settings = entry.Component; return () => {}; },
    addSidebarHeaderItem: () => () => {}, addTimelineRenderer: () => () => {},
    ...(host.composerItems ? { addComposerItem: (entry: { id: string }) => { composerItems.push(entry.id); return () => {}; } } : {}) });
  const colors = { surface0: "base", surface1: "raised", surface2: "control", border: "border", accent: "accent", accentForeground: "on-accent", foreground: "fg", foregroundMuted: "muted", statusDanger: "danger", statusWarning: "warning", statusSuccess: "success" };
  return {
    calls, actions, switches, selects, pressables, inputs, modals, modalContents, copied, opened, navigation, scrolls, composerItems,
    settings, settingsSave, settingsReload, settingsReset,
    setProfile(value: string) { profile = value; },
    render(screen: "settings" = "settings", props: Record<string, unknown> = {}) {
      actions.length = 0; switches.length = 0; selects.length = 0; pressables.length = 0; scrolls.length = 0; inputs.length = 0; modals.length = 0; modalContents.length = 0;
      return tree.render(createElement(screens[screen], { host: { id: "host", label: "Host" }, theme: { colors }, layout: { compact: false, platform: "web" },
        navigation: { openAgent: (input: unknown) => navigation.push(input) }, ...props }));
    },
    action(actionLabel: string) { const found = actions.find(action => action.actionLabel === actionLabel); expect(found, actionLabel).toBeDefined(); return found!; },
    press(label: string) { const found = pressables.find(item => item.accessibilityLabel === label); expect(found, label).toBeDefined(); expect(found!.disabled).not.toBe(true); found!.onPress(); },
    async save(label = "保存", screen: "settings" = "settings") {
      let button: typeof pressables[number] | undefined;
      await vi.waitFor(() => { this.render(screen); button = pressables.find(item => item.accessibilityLabel?.startsWith(label)); expect(button, label).toBeDefined(); expect(button!.disabled).not.toBe(true); });
      button!.onPress();
    },
    checkbox(label: string) { const found = pressables.find(item => item.accessibilityRole === "checkbox" && item.accessibilityLabel === label); expect(found, label).toBeDefined(); return found!; },
    dispose() { tree.unmount(); dispose(); },
  };
}

const readyStatus = { status: "ready", message: "已验证", profile: "", connectionKey: "current", apiUrl: "https://api.example.test", appUrl: "https://app.example.test", configPath: "/home/user/.multica/config.json",
  source: { api: "config", credentials: "config", app: "config" }, user: { id: "me", name: "Lin", email: "lin@example.test" }, loginCommand: "multica login" };
const defaultRule: TaskRule = { statusCategories: ["unstarted", "started"], statuses: [], assignees: [], projectIds: [], labelIds: [] };
const empty: Answer = name => name === "workspace.preview" ? { total: 0, imported: 0, entering: 0, leaving: [] }
  : name === "profile.list" ? { profiles: [], overridden: false, isolated: false } : undefined;

it("the profile dropdown lists logged-in choices and retains logged-out or missing selections", async () => {
  const h = await settingsHarness((name, input) => name === "profile.list" ? { profiles: [
    { name: "", loggedIn: true, apiHost: "default.example.test" },
    { name: "office", loggedIn: true, apiHost: "office.example.test:8443" },
    { name: "logout", loggedIn: false, apiHost: "logout.example.test" },
    { name: "other-logout", loggedIn: false },
  ], overridden: false, isolated: false } : name === "connection.status" ? readyStatus : empty(name, input));
  try {
    h.setProfile("logout");
    await vi.waitFor(() => { h.render(); expect(h.selects[0].disabled).toBe(false); });
    expect(h.selects[0]).toMatchObject({ value: "logout", hint: "仅列出已在 daemon 主机登录的 profile。", options: [
      { value: "", label: "默认 · default.example.test" },
      { value: "office", label: "office · office.example.test:8443" },
      { value: "logout", label: "logout · logout.example.test（未登录）" },
    ] });
    h.setProfile("missing"); h.render();
    expect(h.selects[0].options).toEqual([
      { value: "", label: "默认 · default.example.test" },
      { value: "office", label: "office · office.example.test:8443" },
      { value: "missing", label: "missing（未登录）" },
    ]);
    h.selects[0].onValueChange("missing");
    expect(h.settingsSave).not.toHaveBeenCalled();
    h.selects[0].onValueChange("../unsafe");
    expect(h.render()).toContain("Profile 必须是单个名称");
    expect(h.settingsSave).not.toHaveBeenCalled();
    const statusReads = h.calls.filter(call => call.name === "connection.status").length;
    h.selects[0].onValueChange("office");
    h.render();
    expect(h.settingsSave).not.toHaveBeenCalled();
    h.press("确认切换");
    await vi.waitFor(() => { h.render(); expect(h.calls.filter(call => call.name === "connection.status").length).toBeGreaterThan(statusReads); });
    expect(h.settingsSave).toHaveBeenCalledExactlyOnceWith({ profile: "office" }, "1");
    expect(h.selects[0].value).toBe("office");
    expect(h.render()).not.toContain("Profile 必须是单个名称");
    expect(h.calls.filter(call => call.name === "profile.list")).toHaveLength(1);
    expect(h.modals).toHaveLength(0);
  } finally { h.dispose(); }
});

it("profile confirmation shows local counts and remote safety, and cancel never saves", async () => {
  const h = await settingsHarness((name, input) => name === "profile.list"
    ? { profiles: [{ name: "office", loggedIn: true }], overridden: false, isolated: false }
    : name === "connection.status" ? { ...readyStatus, localData: { projects: 2, issues: 7, discussions: 19 } } : empty(name, input));
  try {
    await vi.waitFor(() => { h.render(); expect(h.selects[0].disabled).toBe(false); });
    h.selects[0].onValueChange("office");
    const modal = h.render();
    for (const text of ["确认切换 CLI profile", "office", "Project 2", "任务 7", "讨论 19", "本地规则、映射、缓存、讨论", "不影响 Multica 远端数据（不会取消远端 Run 或删除评论）"]) expect(modal).toContain(text);
    h.press("取消"); h.render();
    expect(h.modals).toHaveLength(0);
    expect(h.settingsSave).not.toHaveBeenCalled();
    expect(h.selects[0].value).toBe("");
  } finally { h.dispose(); }
});

it("purging disables profile selection and retained Projects explain why their paths remain", async () => {
  const h = await settingsHarness((name, input) => name === "connection.status" ? { ...readyStatus,
    sync: { status: "syncing", stage: "purging", completedWorkspaces: 0, enabledWorkspaces: 0,
      retainedProjects: [{ name: "Product", cwd: "/state/placeholders/old/product" }] } } : empty(name, input));
  try {
    await vi.waitFor(() => {
      const page = h.render();
      for (const text of ["清理旧 profile 数据", "正在清理旧 profile 本地数据…", "用户自建工作区", "Product", "/state/placeholders/old/product"]) expect(page).toContain(text);
      expect(h.selects[0].disabled).toBe(true);
    });
    h.selects[0].onValueChange("office"); h.render();
    expect(h.modals).toHaveLength(0);
    expect(h.settingsSave).not.toHaveBeenCalled();
  } finally { h.dispose(); }
});

it("loads profiles on mount, header refresh and host changes, discarding late reads from the previous host", async () => {
  const pending: Array<(value: ProfileList) => void> = [];
  const result = (name: string): ProfileList => ({ profiles: [{ name, loggedIn: true }], overridden: false, isolated: false });
  const h = await settingsHarness((name, input) => name === "profile.list" ? new Promise(resolve => pending.push(resolve))
    : name === "connection.status" ? readyStatus : empty(name, input));
  try {
    h.render();
    expect(h.selects[0]).toMatchObject({ disabled: true, value: "", options: [{ value: "", label: "默认（未登录）" }] });
    expect(pending).toHaveLength(1);
    pending[0](result("office"));
    await vi.waitFor(() => { h.render(); expect(h.selects[0].disabled).toBe(false); });
    h.press("刷新"); h.render();
    expect(h.settingsReload).toHaveBeenCalledTimes(1);
    expect(h.selects[0].disabled).toBe(true);
    expect(pending).toHaveLength(2);
    const nextHost = { host: { id: "another-host", label: "Another host" } };
    h.render("settings", nextHost);
    expect(h.selects[0]).toMatchObject({ disabled: true, options: [{ value: "", label: "默认（未登录）" }] });
    expect(pending).toHaveLength(3);
    pending[2](result("new-host"));
    await vi.waitFor(() => { h.render("settings", nextHost); expect(h.selects[0].disabled).toBe(false); });
    pending[1](result("old-host"));
    await Promise.resolve(); await Promise.resolve();
    h.render("settings", nextHost);
    expect(h.selects[0].options.map(option => option.value)).toEqual(["new-host", ""]);
    expect(h.calls.filter(call => call.name === "profile.list")).toHaveLength(3);
  } finally { h.dispose(); }
});

it("a failed profile list shows a row error and only the configured profile, and refresh retries", async () => {
  let failed = true;
  const h = await settingsHarness((name, input) => {
    if (name === "profile.list") return failed ? Promise.reject(new Error("unreadable CLI root"))
      : { profiles: [{ name: "office", loggedIn: true }], overridden: false, isolated: false };
    return name === "connection.status" ? readyStatus : empty(name, input);
  });
  try {
    h.setProfile("missing");
    await vi.waitFor(() => expect(h.render()).toContain("无法读取此主机的 CLI profile"));
    expect(h.selects[0]).toMatchObject({ value: "missing", options: [{ value: "missing", label: "missing（未登录）" }] });
    failed = false; h.press("刷新");
    await vi.waitFor(() => { h.render(); expect(h.selects[0].options).toHaveLength(2); });
    expect(h.selects[0].error).toBeUndefined();
  } finally { h.dispose(); }
});

it.each([
  { overridden: true, isolated: false }, { overridden: false, isolated: true }, { overridden: true, isolated: true },
])("the profile row explains overrides and disables isolated contexts: %j", async flags => {
  const h = await settingsHarness((name, input) => name === "profile.list" ? { profiles: [{ name: "office", loggedIn: true }], ...flags }
    : name === "connection.status" ? readyStatus : empty(name, input));
  try {
    await vi.waitFor(() => { h.render(); expect(h.selects[0].hint).toContain(flags.isolated ? "任务上下文不能使用拥有者的 profile" : "环境变量覆盖 CLI 凭据"); });
    if (flags.overridden) expect(h.selects[0].hint).toContain("切换 profile 不会改变账号");
    expect(h.selects[0].disabled).toBe(flags.isolated);
    h.selects[0].onValueChange("office");
    h.render();
    if (!flags.isolated) { h.press("确认切换"); await vi.waitFor(() => expect(h.settingsSave).toHaveBeenCalledTimes(1)); }
    else expect(h.settingsSave).not.toHaveBeenCalled();
  } finally { h.dispose(); }
});

it("disables profile selection while saving and displays save failures without changing the selected profile", async () => {
  const h = await settingsHarness((name, input) => name === "profile.list" ? { profiles: [{ name: "office", loggedIn: true }], overridden: false, isolated: false }
    : name === "connection.status" ? readyStatus : empty(name, input));
  try {
    await vi.waitFor(() => { h.render(); expect(h.selects[0].disabled).toBe(false); });
    h.settings.saving = true; h.render();
    expect(h.selects[0].disabled).toBe(true);
    h.selects[0].onValueChange("office");
    expect(h.settingsSave).not.toHaveBeenCalled();
    h.settings.saving = false;
    h.settingsSave.mockImplementation(async () => { h.settings.saveError = "无法保存 profile"; return false; });
    const statusReads = h.calls.filter(call => call.name === "connection.status").length;
    h.render(); h.selects[0].onValueChange("office");
    h.render(); h.press("确认切换");
    await vi.waitFor(() => {
      const page = h.render();
      expect(h.selects[0].error).toBe("无法保存 profile");
      expect(page).toContain("无法保存 profile");
      expect(page).not.toContain("无法保存 profile，请重试。");
    });
    expect(h.modals).toHaveLength(1);
    expect(h.selects[0].value).toBe("");
    expect(h.calls.filter(call => call.name === "connection.status")).toHaveLength(statusReads);
  } finally { h.dispose(); }
});

it("keeps the settings loading row and invalid-settings reset action", async () => {
  const h = await settingsHarness((name, input) => name === "connection.status" ? readyStatus : empty(name, input));
  try {
    h.settings.status = "loading";
    expect(h.render()).toContain("正在读取设置…");
    expect(h.selects).toHaveLength(0);
    h.settings.status = "invalid";
    expect(h.render()).toContain("已保存的插件设置无效");
    h.action("重置为默认 profile").onPress();
    await vi.waitFor(() => { h.render(); expect(h.selects[0].value).toBe(""); });
    expect(h.settingsReset).toHaveBeenCalledTimes(1);
  } finally { h.dispose(); }
});

it("settings lists shared hidden objects and offers separate workspace and selected-tab restoration", async () => {
  const objects = [
    { connectionKey: "old-connection", issueId: "issue", workspaceId: "workspace", cwd: "/original", kind: "workspace", title: "Task" },
    { connectionKey: "old-connection", issueId: "issue", workspaceId: "workspace", cwd: "/original", kind: "thread", rootId: "root", agentId: "original-agent", title: "Task · Root" },
  ];
  const h = await settingsHarness(name => {
    if (name === "hidden.restore") return { status: "ready" };
    if (name === "workspace.list") return { workspaces: [] };
    if (name === "connection.status") return { hidden: objects, status: "offline", message: "offline", profile: "", source: { api: "none", credentials: "none", app: "none" }, loginCommand: "multica login" };
    return empty(name, {});
  });
  try {
    await vi.waitFor(() => { expect(h.render()).toContain("人工隐藏"); expect(h.render()).toContain("Task · Root"); });
    h.render();
    expect(h.actions.map(action => action.actionLabel)).toContain("恢复 Paseo 工作区");
    h.action("恢复讨论").onPress();
    await vi.waitFor(() => expect(h.calls).toContainEqual({ name: "hidden.restore", input: { connectionKey: "old-connection", issueId: "issue", rootId: "root" } }));
  } finally { h.dispose(); }
});

it("settings shows only connection and rules when nothing is hidden", async () => {
  const answer: Answer = (name, input) => name === "connection.status" ? readyStatus : name === "workspace.list" ? { connectionKey: "current", workspaces: [] } : empty(name, input);
  const settings = await settingsHarness(answer);
  try {
    await vi.waitFor(() => expect(settings.render()).toContain("当前没有可用的 Multica 工作区"));
    const page = settings.render();
    expect(settings.calls.some(call => ["sync.status", "hidden.list"].includes(call.name))).toBe(false);
    for (const text of ["Multica 连接", "已连接 · Lin", "https://api.example.test", "Multica 工作区与筛选规则"]) expect(page).toContain(text);
    for (const text of ["人工隐藏", "停止结果", "评论投递", "只读历史", "历史连接", "提及 Agent", "恢复 CLI 登录", readyStatus.configPath, "凭据来源", "ID me"])
      expect(page).not.toContain(text);
  } finally { settings.dispose(); }

});

it("refreshing keeps the connection, rules and unsaved modal edits on screen", async () => {
  let release: (() => void) | undefined;
  let statusReads = 0;
  const h = await settingsHarness(async (name, input) => {
    if (name === "connection.status") {
      // The refresh reading stays pending: the rows from the previous reading must stay put meanwhile.
      if (++statusReads > 1) await new Promise<void>(resolve => { release = resolve; });
      return readyStatus;
    }
    if (name === "workspace.list") return { connectionKey: "current", workspaces: [{ id: "ws", name: "Team space", enabled: true, rule: defaultRule, importedCount: 2 }] };
    if (name === "workspace.catalog") return { assignees: [], statuses: [], projects: [], labels: [{ id: "bug", name: "Bug" }] };
    return empty(name, input);
  });
  try {
    await vi.waitFor(() => expect(h.render()).toContain("Team space"));
    h.action("编辑筛选").onPress();
    await vi.waitFor(() => expect(h.render()).toContain("Bug"));
    h.press("Bug");
    expect(h.render()).toContain("有未保存的修改");
    h.press("刷新");
    await vi.waitFor(() => { h.render(); expect(release).toBeDefined(); });
    const page = h.render();
    for (const text of ["已连接", "Team space", "Bug", "有未保存的修改"]) expect(page).toContain(text);
    expect(page).not.toContain("正在验证");
    expect(h.checkbox("Bug").accessibilityState).toEqual({ checked: true });
    release!();
  } finally { h.dispose(); }
});

it("does not report an empty Multica workspace list before the list has been read", async () => {
  // The connection reads ready before the workspace list arrives, so an empty list is first a pending read.
  let release: ((value: unknown) => void) | undefined;
  const h = await settingsHarness((name, input) => name === "workspace.list" ? new Promise(resolve => { release = resolve; }) : name === "connection.status" ? readyStatus : empty(name, input));
  try {
    await vi.waitFor(() => { h.render("settings"); expect(release).toBeDefined(); });
    let page = h.render("settings");
    expect(page).toContain("已连接");
    expect(page).toContain("正在读取 Multica 工作区");
    expect(page).not.toContain("当前没有可用的 Multica 工作区");
    release!({ connectionKey: "current", workspaces: [] });
    await vi.waitFor(() => expect(h.render("settings")).toContain("当前没有可用的 Multica 工作区"));
    page = h.render("settings");
    expect(page).not.toContain("正在读取 Multica 工作区");
  } finally { h.dispose(); }
});

const filterCatalog = {
  statuses: [
    { key: "backlog", name: "Backlog", category: "unstarted" }, { key: "todo", name: "Todo", category: "unstarted" },
    { key: "progress", name: "In Progress", category: "started" }, { key: "review", name: "In Review", category: "started" }, { key: "blocked", name: "Blocked", category: "started" },
    { key: "done", name: "Done", category: "done" }, { key: "cancelled", name: "Cancelled", category: "closed" },
  ],
  assignees: [{ id: "other", name: "Other member", type: "member" }, { id: "builder", name: "拉车的🫏", type: "agent" }, { id: "me", name: "Lin", type: "member" }, { id: "team", name: "Front end", type: "squad" }],
  projects: [{ id: "plugin", name: "插件生态" }], labels: [{ id: "bug", name: "Bug" }],
};

async function filterHarness({ rule = defaultRule, catalog = filterCatalog, enabled = true, answer = () => undefined }: {
  rule?: TaskRule; catalog?: typeof filterCatalog; enabled?: boolean; answer?: Answer;
} = {}) {
  const workspace = { id: "ws", name: "Team space", enabled, rule, importedCount: enabled ? 2 : 0 };
  return settingsHarness((name, input) => {
    const result = answer(name, input);
    if (result !== undefined) return result;
    if (name === "connection.status") return readyStatus;
    if (name === "workspace.list") return { connectionKey: "current", workspaces: [workspace] };
    if (name === "workspace.catalog") return catalog;
    if (name === "workspace.preview") return { total: 2, imported: workspace.importedCount, entering: 2 - workspace.importedCount, leaving: [] };
    if (name === "workspace.rule") { workspace.rule = (input as { rule: TaskRule }).rule; return { status: "saved" }; }
    if (name === "workspace.enable") { workspace.enabled = (input as { enabled: boolean }).enabled; return { status: "saved" }; }
    return empty(name, input);
  });
}

it.each([
  { name: "whole categories", clicks: [], expected: { statusCategories: ["unstarted", "started"], statuses: [] } },
  { name: "partial statuses plus the other whole category", clicks: ["In Review"], expected: { statusCategories: [], statuses: ["backlog", "todo", "progress", "blocked"] } },
  { name: "a partial selection promoted to a whole category", clicks: ["进行中", "In Progress", "In Review", "Blocked"], expected: { statusCategories: ["unstarted", "started"], statuses: [] } },
  { name: "unlimited statuses", clicks: ["未开始", "进行中"], expected: { statusCategories: [], statuses: [] } },
])("the status editor saves $name", async ({ clicks, expected }) => {
  const h = await filterHarness();
  try {
    await vi.waitFor(() => expect(h.render()).toContain("Team space"));
    h.action("编辑筛选").onPress();
    await vi.waitFor(() => expect(h.render()).toContain("In Review"));
    expect(h.selects.map(select => select.label)).toEqual(["CLI profile"]);
    for (const label of clicks) { h.press(label); h.render(); }
    if (expected.statuses.length) {
      expect(h.checkbox("进行中").accessibilityState).toEqual({ checked: "mixed" });
      expect(h.render()).toContain("只选了部分状态，规则将按具体状态保存；今后新增的状态不会自动纳入。");
    } else expect(h.render()).toContain("按类别 · 今后新增的状态自动纳入");
    expect(h.modalContents[0].scrollable).toBe(false);
    await h.save();
    await vi.waitFor(() => expect(h.calls.filter(call => call.name === "workspace.rule")).toHaveLength(1));
    const saved = (h.calls.find(call => call.name === "workspace.rule")!.input as { rule: TaskRule }).rule;
    expect(h.calls.filter(call => call.name === "workspace.preview").at(-1)?.input).toEqual({ workspaceId: "ws", connectionKey: "current", rule: saved });
    expect({ ...saved, statuses: [...saved.statuses].sort() }).toEqual({ ...defaultRule, ...expected, statuses: [...expected.statuses].sort() });
    await vi.waitFor(() => { h.render(); expect(h.modals).toHaveLength(0); });
  } finally { h.dispose(); }
});

it("legacy mixed rules load the intersection and keep empty catalog categories selected", async () => {
  const h = await filterHarness({ rule: { ...defaultRule, statusCategories: ["started"], statuses: ["todo", "progress"] } });
  try {
    await vi.waitFor(() => expect(h.render()).toContain("Team space"));
    h.action("编辑筛选").onPress();
    await vi.waitFor(() => expect(h.render()).toContain("In Review"));
    expect(h.checkbox("Todo").accessibilityState).toEqual({ checked: false });
    expect(h.checkbox("In Progress").accessibilityState).toEqual({ checked: true });
    expect(h.checkbox("进行中").accessibilityState).toEqual({ checked: "mixed" });
    expect(h.render()).not.toContain("有未保存的修改");
    await h.save();
    await vi.waitFor(() => expect(h.calls).toContainEqual({ name: "workspace.rule", input: { workspaceId: "ws", connectionKey: "current", rule: { ...defaultRule, statusCategories: [], statuses: ["progress"] } } }));
  } finally { h.dispose(); }
  const noStatuses = await filterHarness({ catalog: { ...filterCatalog, statuses: [] } });
  try {
    await vi.waitFor(() => expect(noStatuses.render()).toContain("Team space"));
    noStatuses.action("编辑筛选").onPress();
    await vi.waitFor(() => { noStatuses.render(); expect(noStatuses.modals[0]?.title).toBe("筛选条件 · Team space"); });
    expect(noStatuses.checkbox("未开始").accessibilityState).toEqual({ checked: true });
    expect(noStatuses.checkbox("进行中").accessibilityState).toEqual({ checked: true });
    await noStatuses.save();
    await vi.waitFor(() => expect(noStatuses.calls).toContainEqual({ name: "workspace.rule", input: { workspaceId: "ws", connectionKey: "current", rule: defaultRule } }));
  } finally { noStatuses.dispose(); }
});

it("the list uses catalog names and the assignee chips group actors with the verified member first", async () => {
  const h = await filterHarness({ rule: { ...defaultRule, assignees: [{ type: "member", id: "me" }, { type: "agent", id: "builder" }], labelIds: ["bug"] } });
  try {
    await vi.waitFor(() => expect(h.render()).toContain("状态 未开始、进行中 · 负责人 我、拉车的🫏 · 标签 Bug · Multica 项目 不限"));
    h.action("编辑筛选").onPress();
    expect(h.render()).toContain("成员");
    const actors = h.pressables.filter(item => ["我 · Lin", "Other member", "拉车的🫏", "Front end"].includes(item.accessibilityLabel ?? ""));
    expect(actors.map(item => item.accessibilityLabel)).toEqual(["我 · Lin", "Other member", "拉车的🫏", "Front end"]);
    expect(actors.map(item => item.accessibilityState?.checked)).toEqual([true, false, true, false]);
    expect(h.render()).toContain("直接分配给成员，与分配给其 Agent／Squad 是不同条件，需分别选择。");
    expect(h.calls.filter(call => call.name === "workspace.catalog")).toHaveLength(1);
  } finally { h.dispose(); }
});

it("search ignores case, keeps selected and missing values visible, and allows clearing each field", async () => {
  const labels = Array.from({ length: 10 }, (_, index) => ({ id: `label-${index}`, name: `Label ${index}` }));
  const h = await filterHarness({ catalog: { ...filterCatalog, labels }, rule: { ...defaultRule, statuses: ["gone-status"], statusCategories: [], labelIds: ["label-0", "gone-label"], projectIds: ["gone-project"], assignees: [{ type: "agent", id: "gone-agent" }] } });
  try {
    await vi.waitFor(() => expect(h.render()).toContain("Team space"));
    h.action("编辑筛选").onPress();
    await vi.waitFor(() => expect(h.render()).toContain("Label 9"));
    for (const id of ["gone-status", "gone-label", "gone-project", "gone-agent"]) {
      const chip = h.checkbox(`${id}（已不在目录）`);
      expect(chip.accessibilityState).toEqual({ checked: true });
      expect(chip.style?.borderStyle).toBe("dashed");
    }
    h.inputs.find(item => item.accessibilityLabel === "搜索标签")!.onChangeText("lAbEl 9");
    let page = h.render();
    expect(page).toContain("Label 0"); expect(page).toContain("Label 9"); expect(page).toContain("gone-label（已不在目录）"); expect(page).not.toContain("Label 1");
    h.press("gone-label（已不在目录）");
    expect(h.render()).not.toContain("gone-label（已不在目录）");
    h.press("清除标签");
    page = h.render();
    expect(h.pressables.some(item => item.accessibilityLabel === "Label 0")).toBe(false);
    expect(h.pressables.some(item => item.accessibilityLabel === "清除标签")).toBe(false);
    h.press("gone-status（已不在目录）"); h.render();
    h.press("清除负责人"); h.render();
    h.press("清除Multica 项目"); h.render();
    await h.save();
    await vi.waitFor(() => expect(h.calls).toContainEqual({ name: "workspace.rule", input: { workspaceId: "ws", connectionKey: "current", rule: { ...defaultRule, statusCategories: [] } } }));
  } finally { h.dispose(); }
});

it("enabling opens the same editor and saves the rule before enabling; an enable failure retries only enable", async () => {
  let attempts = 0;
  const h = await filterHarness({ enabled: false, answer: name => name === "workspace.enable" ? (++attempts === 1 ? { status: "unavailable", message: "启用失败，规则已保存" } : { status: "saved" }) : undefined });
  try {
    await vi.waitFor(() => expect(h.render()).toContain("未启用 · 不导入任务"));
    expect(h.switches).toEqual([]);
    expect(h.calls.filter(call => call.name === "workspace.catalog")).toHaveLength(0);
    h.action("启用…").onPress();
    await vi.waitFor(() => expect(h.render()).toContain("启用并导入"));
    expect(h.modals[0].title).toBe("启用 · Team space");
    expect(h.render()).toContain("默认只导入“未开始”和“进行中”，其他条件不限；可以先缩小范围再导入。");
    expect(h.calls.filter(call => call.name === "workspace.enable")).toEqual([]);
    h.press("Bug"); h.render(); await h.save("启用并导入");
    await vi.waitFor(() => expect(h.render()).toContain("启用失败，规则已保存"));
    let writes = h.calls.filter(call => ["workspace.rule", "workspace.enable"].includes(call.name));
    expect(writes.map(call => call.name)).toEqual(["workspace.rule", "workspace.enable"]);
    expect(writes[0].input).toEqual({ workspaceId: "ws", connectionKey: "current", rule: { ...defaultRule, labelIds: ["bug"] } });
    expect(h.render()).not.toContain("有未保存的修改");
    await h.save("启用并导入");
    await vi.waitFor(() => { h.render(); expect(h.modals).toHaveLength(0); });
    writes = h.calls.filter(call => ["workspace.rule", "workspace.enable"].includes(call.name));
    expect(writes.map(call => call.name)).toEqual(["workspace.rule", "workspace.enable", "workspace.enable"]);
    expect(h.switches.find(item => item.label === "Team space")?.value).toBe(true);
  } finally { h.dispose(); }
});

it("a failed rule save keeps the error in the modal and does not enable the workspace", async () => {
  let attempts = 0;
  const h = await filterHarness({ enabled: false, answer: name => name === "workspace.rule" && ++attempts === 1 ? { status: "unavailable", message: "无法保存规则" } : undefined });
  try {
    await vi.waitFor(() => expect(h.render()).toContain("Team space"));
    h.action("启用…").onPress();
    await vi.waitFor(() => expect(h.render()).toContain("启用并导入"));
    await h.save("启用并导入");
    await vi.waitFor(() => expect(h.render()).toContain("无法保存规则"));
    expect(h.calls.filter(call => call.name === "workspace.enable")).toHaveLength(0);
    await h.save("启用并导入");
    await vi.waitFor(() => { h.render(); expect(h.modals).toHaveLength(0); });
    expect(h.calls.filter(call => ["workspace.rule", "workspace.enable"].includes(call.name)).map(call => call.name)).toEqual(["workspace.rule", "workspace.rule", "workspace.enable"]);
  } finally { h.dispose(); }
});

it("disabling needs confirmation and disables only that workspace while saving", async () => {
  let release: ((value: unknown) => void) | undefined;
  const h = await settingsHarness((name, input) => {
    if (name === "connection.status") return readyStatus;
    if (name === "workspace.list") return { connectionKey: "current", workspaces: [
      { id: "off", name: "Off space", enabled: false, rule: defaultRule, importedCount: 0 }, { id: "ws", name: "Team space", enabled: true, rule: defaultRule, importedCount: 12 }, { id: "second", name: "Second space", enabled: true, rule: defaultRule, importedCount: 5 },
    ] };
    if (name === "workspace.catalog") return filterCatalog;
    if (name === "workspace.enable") return new Promise(resolve => { release = resolve; });
    return empty(name, input);
  });
  try {
    await vi.waitFor(() => expect(h.render()).toContain("Second space"));
    let page = h.render();
    expect(page.indexOf("Team space")).toBeLessThan(page.indexOf("Off space"));
    h.switches.find(item => item.label === "Team space")!.onValueChange(false);
    page = h.render();
    expect(page).toContain("停用 Team space？");
    for (const text of ["已导入 12 项任务", "此 Multica 工作区已导入的 12 项任务会归档", "空的 Paseo 项目会移除", "评论、执行记录、讨论身份和人工隐藏都会保留", "重新启用后恢复", "不会取消远端 Run"]) expect(page).toContain(text);
    expect(h.calls.filter(call => call.name === "workspace.enable")).toHaveLength(0);
    h.press("取消"); h.render();
    expect(h.modals).toHaveLength(0);
    h.switches.find(item => item.label === "Team space")!.onValueChange(false); h.render(); h.press("停用");
    h.render();
    expect(h.switches.find(item => item.label === "Team space")?.disabled).toBe(true);
    expect(h.switches.find(item => item.label === "Second space")?.disabled).toBe(false);
    expect(h.action("启用…").disabled).toBe(false);
    expect(h.calls).toContainEqual({ name: "workspace.enable", input: { connectionKey: "current", workspaceId: "ws", enabled: false } });
    release!({ status: "unavailable", message: "停用失败" });
    await vi.waitFor(() => expect(h.render()).toContain("停用失败"));
    h.press("停用"); release!({ status: "saved" });
    await vi.waitFor(() => { h.render(); expect(h.modals).toHaveLength(0); });
  } finally { h.dispose(); }
});

it("cancel and the modal close button confirm dirty edits inline, and reopening discards them", async () => {
  const h = await filterHarness();
  try {
    await vi.waitFor(() => expect(h.render()).toContain("Team space"));
    h.action("编辑筛选").onPress();
    await vi.waitFor(() => expect(h.render()).toContain("In Review"));
    h.press("Bug"); h.render(); h.press("取消");
    expect(h.render()).toContain("放弃未保存的修改？");
    expect(h.modals).toHaveLength(1);
    h.press("继续编辑");
    expect(h.render()).toContain("有未保存的修改");
    h.modals[0].onOpenChange(false);
    expect(h.render()).toContain("放弃未保存的修改？");
    h.press("放弃修改"); h.render();
    expect(h.modals).toHaveLength(0);
    h.action("编辑筛选").onPress(); h.render();
    expect(h.checkbox("Bug").accessibilityState).toEqual({ checked: false });
    expect(h.render()).not.toContain("有未保存的修改");
    h.press("取消"); h.render();
    expect(h.modals).toHaveLength(0);
    expect(h.calls.filter(call => call.name === "workspace.rule")).toHaveLength(0);
  } finally { h.dispose(); }
});

it("ten-second polling and rule saves reuse the catalog; host changes and profile changes invalidate it", async () => {
  const h = await filterHarness();
  vi.useFakeTimers();
  try {
    await vi.waitFor(() => expect(h.render("settings")).toContain("状态 未开始、进行中"));
    expect(h.calls.filter(call => call.name === "workspace.catalog")).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(20_000); h.render("settings");
    expect(h.calls.filter(call => call.name === "workspace.list")).toHaveLength(3);
    expect(h.calls.filter(call => call.name === "workspace.catalog")).toHaveLength(1);
    h.action("编辑筛选").onPress(); h.render("settings");
    expect(h.calls.filter(call => call.name === "workspace.catalog")).toHaveLength(1);
    h.press("Bug"); h.render("settings"); await h.save("保存", "settings");
    await vi.waitFor(() => { h.render("settings"); expect(h.modals).toHaveLength(0); });
    expect(h.calls.filter(call => call.name === "workspace.catalog")).toHaveLength(1);
    h.action("编辑筛选").onPress(); h.render("settings");
    expect(h.checkbox("Bug").accessibilityState).toEqual({ checked: true });
    expect(h.calls.filter(call => call.name === "workspace.catalog")).toHaveLength(1);
    h.press("取消"); h.render("settings");
    const nextHost = { host: { id: "another-host", label: "Another host" } };
    await vi.waitFor(() => expect(h.render("settings", nextHost)).toContain("状态 未开始、进行中"));
    const hostReads = h.calls.filter(call => call.name === "workspace.catalog").length;
    expect(hostReads).toBe(2);
    h.setProfile("work");
    await vi.waitFor(() => expect(h.render("settings", nextHost)).toContain("状态 未开始、进行中"));
    expect(h.calls.filter(call => call.name === "workspace.catalog")).toHaveLength(3);
  } finally { h.dispose(); vi.useRealTimers(); }
});

it("catalog failures fall back to counts, stay cached across polling, and can retry in the editor", async () => {
  let fail = true;
  const h = await filterHarness({ rule: { ...defaultRule, labelIds: ["bug"] }, answer: name => name === "workspace.catalog" && fail ? Promise.reject(new Error("offline")) : undefined });
  vi.useFakeTimers();
  try {
    await vi.waitFor(() => expect(h.render()).toContain("标签 1 项"));
    await vi.advanceTimersByTimeAsync(20_000); h.render();
    expect(h.calls.filter(call => call.name === "workspace.catalog")).toHaveLength(1);
    h.action("编辑筛选").onPress();
    expect(h.render()).toContain("无法读取筛选目录");
    fail = false; h.press("重试");
    await vi.waitFor(() => expect(h.render()).toContain("In Review"));
    expect(h.calls.filter(call => call.name === "workspace.catalog")).toHaveLength(2);
  } finally { h.dispose(); vi.useRealTimers(); }
});

it("the preview debounces rule edits, shows footer counts and disables saving until the current result arrives", async () => {
  let release!: (value: unknown) => void;
  const h = await filterHarness({ answer: name => name === "workspace.preview" ? new Promise(resolve => { release = resolve; }) : undefined });
  vi.useFakeTimers();
  try {
    await vi.waitFor(() => expect(h.render()).toContain("状态 未开始、进行中"));
    h.action("编辑筛选").onPress();
    expect(h.render()).toContain("正在计算匹配数…");
    expect(h.pressables.find(item => item.accessibilityLabel === "正在计算…")?.disabled).toBe(true);
    await vi.advanceTimersByTimeAsync(399);
    expect(h.calls.filter(call => call.name === "workspace.preview")).toHaveLength(0);
    h.press("Bug"); h.render();
    await vi.advanceTimersByTimeAsync(399);
    expect(h.calls.filter(call => call.name === "workspace.preview")).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(1);
    expect(h.calls.filter(call => call.name === "workspace.preview")).toEqual([{ name: "workspace.preview", input: { workspaceId: "ws", connectionKey: "current", rule: { ...defaultRule, labelIds: ["bug"] } } }]);
    expect(h.render()).toContain("正在计算匹配数…");
    expect(h.calls.filter(call => call.name === "workspace.rule")).toHaveLength(0);
    release({ total: 14, imported: 12, entering: 3, leaving: [{ id: "old", title: "旧任务" }] });
    await vi.waitFor(() => expect(h.render()).toContain("将匹配 14 项任务"));
    expect(h.render()).toContain("当前已导入 12 项：新增 3 · 移出 1 · 有未保存的修改");
    expect(h.pressables.find(item => item.accessibilityLabel === "保存")?.disabled).toBe(false);
  } finally { h.dispose(); vi.useRealTimers(); }
});

it.each(["success", "failure"])("an obsolete preview %s cannot replace the current rule's result", async outcome => {
  const pending: Array<{ resolve(value: unknown): void; reject(error: Error): void }> = [];
  const h = await filterHarness({ answer: name => name === "workspace.preview" ? new Promise((resolve, reject) => pending.push({ resolve, reject })) : undefined });
  vi.useFakeTimers();
  try {
    await vi.waitFor(() => expect(h.render()).toContain("状态 未开始、进行中"));
    h.action("编辑筛选").onPress(); h.render();
    await vi.advanceTimersByTimeAsync(400);
    h.press("Bug"); h.render();
    await vi.advanceTimersByTimeAsync(400);
    expect(pending).toHaveLength(2);
    pending[1].resolve({ total: 7, imported: 2, entering: 5, leaving: [] });
    await vi.waitFor(() => expect(h.render()).toContain("将匹配 7 项任务"));
    if (outcome === "success") pending[0].resolve({ total: 99, imported: 99, entering: 0, leaving: [{ id: "stale", title: "过期任务" }] });
    else pending[0].reject(new Error("stale error"));
    await vi.advanceTimersByTimeAsync(0);
    let page = h.render();
    expect(page).toContain("将匹配 7 项任务");
    expect(page).not.toContain("将匹配 99"); expect(page).not.toContain("无法预览匹配数");
    h.press("Bug"); page = h.render();
    expect(page).toContain("正在计算匹配数…");
    expect(page).not.toContain("将匹配 7 项任务");
    expect(h.pressables.find(item => item.accessibilityLabel === "正在计算…")?.disabled).toBe(true);
  } finally { h.dispose(); vi.useRealTimers(); }
});

it("leaving tasks require an inline confirmation; returning and editing do not save, and the list shows at most ten titles", async () => {
  const leaving = Array.from({ length: 12 }, (_, index) => ({ id: `old-${index}`, title: `将移出的任务 ${index + 1}。` }));
  const h = await filterHarness({ answer: name => name === "workspace.preview" ? { total: 14, imported: 23, entering: 3, leaving } : undefined });
  vi.useFakeTimers();
  try {
    await vi.waitFor(() => expect(h.render()).toContain("状态 未开始、进行中"));
    h.action("编辑筛选").onPress();
    await h.save();
    let page = h.render();
    expect(page).toContain("保存后 12 项任务将移出");
    expect(page).toContain("它们不再符合新条件，对应的 Paseo 工作区会自动归档：");
    expect(page).toContain("将移出的任务 10。"); expect(page).not.toContain("将移出的任务 11。"); expect(page).toContain("等 12 项");
    expect(page).toContain("评论、执行记录和讨论身份都会保留，再次符合条件时恢复原工作区。不会取消远端 Run。");
    expect(h.modals).toHaveLength(1);
    expect(h.calls.filter(call => call.name === "workspace.rule")).toHaveLength(0);
    h.press("返回修改");
    expect(h.render()).not.toContain("保存后 12 项任务将移出");
    expect(h.calls.filter(call => call.name === "workspace.rule")).toHaveLength(0);
    await h.save(); h.render(); h.press("Bug");
    page = h.render();
    expect(page).not.toContain("保存后 12 项任务将移出");
    expect(page).toContain("正在计算匹配数…");
    await h.save(); h.render(); h.press("保存并归档 12 项");
    await vi.waitFor(() => { h.render(); expect(h.modals).toHaveLength(0); });
    expect(h.calls.filter(call => call.name === "workspace.rule")).toEqual([{ name: "workspace.rule", input: { workspaceId: "ws", connectionKey: "current", rule: { ...defaultRule, labelIds: ["bug"] } } }]);
  } finally { h.dispose(); vi.useRealTimers(); }
});

it("a failed preview reports the failure and still allows saving", async () => {
  const h = await filterHarness({ answer: name => name === "workspace.preview" ? Promise.reject(new Error("offline")) : undefined });
  vi.useFakeTimers();
  try {
    await vi.waitFor(() => expect(h.render()).toContain("状态 未开始、进行中"));
    h.action("编辑筛选").onPress();
    await vi.waitFor(() => expect(h.render()).toContain("无法预览匹配数"));
    h.press("保存");
    await vi.waitFor(() => { h.render(); expect(h.modals).toHaveLength(0); });
    expect(h.calls.filter(call => call.name === "workspace.rule")).toHaveLength(1);
  } finally { h.dispose(); vi.useRealTimers(); }
});

it.each([{ total: 30, warning: false }, { total: 31, warning: true }])("enabling $total matches shows the count and warns only above the large-import threshold", async ({ total, warning }) => {
  const h = await filterHarness({ enabled: false, answer: name => name === "workspace.preview" ? { total, imported: 0, entering: total, leaving: [] } : undefined });
  vi.useFakeTimers();
  try {
    await vi.waitFor(() => expect(h.render()).toContain("Team space"));
    h.action("启用…").onPress();
    await vi.waitFor(() => expect(h.render()).toContain(`启用并导入 ${total} 项`));
    expect(h.render().includes("数量较多，可按负责人或标签缩小范围")).toBe(warning);
    h.press(`启用并导入 ${total} 项`);
    await vi.waitFor(() => { h.render(); expect(h.modals).toHaveLength(0); });
    expect(h.calls.filter(call => ["workspace.rule", "workspace.enable"].includes(call.name)).map(call => call.name)).toEqual(["workspace.rule", "workspace.enable"]);
  } finally { h.dispose(); vi.useRealTimers(); }
});

it("a lost CLI login shows the recovery command with a copy action instead of an empty connection", async () => {
  const h = await settingsHarness((name, input) => name === "connection.status"
    ? { status: "not_logged_in", message: "CLI 未登录", profile: "work", configPath: "/home/user/.multica/profiles/work/config.json", source: { api: "config", credentials: "none", app: "none" }, loginCommand: "multica --profile work login" }
    : empty(name, input));
  try {
    await vi.waitFor(() => expect(h.render()).toContain("恢复 CLI 登录"));
    const page = h.render();
    for (const text of ["未登录", "multica --profile work login", "CLI 配置", "连接就绪后可配置"]) expect(page).toContain(text);
    h.action("复制命令").onPress();
    await vi.waitFor(() => expect(h.copied).toEqual(["multica --profile work login"]));
    expect(h.render()).toContain("已复制");
  } finally { h.dispose(); }
});


it("the native discussion shows only thread-open failures", async () => {
  const effects: Array<() => unknown> = [];
  const renderers: Array<{ kind: string; Component: (props: any) => any }> = [];
  const state: unknown[] = [];
  let cursor = 0;
  const setup = await bundledContribution("../index.client.tsx", {
    react: { useEffect: (effect: () => unknown) => effects.push(effect), useState: (initial: unknown) => {
      const index = cursor++; if (!(index in state)) state[index] = initial;
      return [state[index], (value: unknown) => { state[index] = value; }];
    } },
    "@getpaseo/plugin/client": { useRpc: () => async () => ({ status: "cached", message: "可阅读已读历史" }) },
    "react-native": { Text: "Text", View: "View", Pressable: "Pressable" },
    "@getpaseo/plugin/client/ui": {},
  });
  const dispose = setup({ rpc: async () => ({ status: "ready" }), addSettingsScreen: () => () => {}, addScreen: () => () => {}, addSidebarHeaderItem: () => () => {}, addTimelineRenderer: (renderer: any) => {
    renderers.push(renderer);
    return () => {};
  } });
  try {
    const renderer = renderers.find(renderer => renderer.kind === "thread")!;
    const render = () => {
      cursor = 0;
      return renderedText(renderer.Component({ item: { data: { connectionKey: "connection", issueId: "issue", rootId: "root" } }, theme: { colors: { foreground: "black", foregroundMuted: "gray" } } }));
    };
    render();
    const unmount = effects.splice(0).map(effect => effect()).filter((value): value is () => void => typeof value === "function");
    await Promise.resolve();
    expect(render()).not.toContain("同步未完成");
    expect(render()).toContain("可阅读已读历史");
    expect(render()).not.toContain("上次完成核对");
    for (const cleanup of unmount) cleanup();
  } finally { dispose(); }
});

it.each([
  ["pending", {}, ["待答"]],
  ["pending", { delivery: { status: "failed", clientMessageId: "answer", message: "回答发送失败" } }, ["回答发送失败"]],
  ["answered", { answer: { commentId: "reply", content: "**确认结果**\n\n1. **理由**：已核对", actorId: "reviewer", actorType: "member" } }, ["已答", "reviewer", "已核对"]],
  ["skipped", { skippedAt: "2026-11-24T10:00:00Z", skippedBy: "operator" }, ["已跳过", "operator"]],
  ["invalid", { error: "附件超过 64 KiB 上限。" }, ["不可解析", "64 KiB"]],
  ["pending", { readOnly: true, readOnlyReason: "仅指定用户 reviewer 可作答。" }, ["只读", "reviewer"]],
  ["pending", { offline: true, readOnly: true }, ["离线缓存", "只读"]],
])("the host-compiled askuser renderer shows %s with its warning, questions and source references", async (status, extra, labels) => {
  const renderers: PluginTimelineRendererContribution[] = [];
  const setup = await bundledContribution("../index.client.tsx", {
    react: { useEffect: () => {}, useState: (value: unknown) => [value, () => {}] },
    "@getpaseo/plugin/client": { useRpc: () => async () => ({}) },
    "@getpaseo/plugin/client/ui": { Markdown: ({ children }: { children: string }) => children },
    "react-native": { View: "View", Text: "Text" },
  });
  const dispose = setup({ rpc: async () => ({ status: "ready" }), addSettingsScreen: () => () => {}, addScreen: () => () => {}, addSidebarHeaderItem: () => () => {},
    addTimelineRenderer: (renderer: PluginTimelineRendererContribution) => { renderers.push(renderer); return () => { renderers.splice(renderers.indexOf(renderer), 1); }; } });
  try {
    const renderer = renderers.find(value => value.kind === "askuser" && value.version === 1);
    expect(renderer).toBeDefined();
    const data = renderer!.schema.parse({ connectionKey: "connection", issueId: "issue", rootId: "root", commentId: "card-comment", attachmentId: "file", revision: "v1",
      title: "发布确认", description: "警示：此操作会影响生产环境。", questions: [{ id: "reason", type: "text", title: "理由" }], status, readOnly: false, offline: false, truncated: false, ...extra });
    const text = renderedText((renderer!.Component as (props: unknown) => unknown)({ item: { type: "plugin", kind: "askuser", version: 1, data }, theme: { colors: { foreground: "black", foregroundMuted: "gray", statusDanger: "red" } } }));
    for (const label of ["发布确认", "警示：此操作会影响生产环境。", "理由", "card-comment", "file", ...labels]) expect(text).toContain(label);
  } finally { dispose(); }
  expect(renderers).toEqual([]);
});

it("the compiled askuser card loads complete warning details only on explicit read and follows every page", async () => {
  const renderers: PluginTimelineRendererContribution[] = [];
  const actions: Array<{ actionLabel: string; onPress(): void }> = [];
  const calls: Array<{ name: string; input: unknown }> = [];
  const state: unknown[] = []; let cursor = 0;
  const base = { connectionKey: "connection", issueId: "issue", rootId: "root", commentId: "comment", attachmentId: "file", revision: "v1", title: "确认", description: "警示摘要", questions: [], status: "pending", readOnly: false, offline: false, truncated: true };
  const full = JSON.stringify({ ...base, description: "完整警示说明：请先核对生产环境。", truncated: false });
  const setup = await bundledContribution("../index.client.tsx", {
    react: { useEffect: () => {}, useState: (initial: unknown) => { const index = cursor++; if (!(index in state)) state[index] = initial; return [state[index], (value: unknown) => { state[index] = value; }]; } },
    "@getpaseo/plugin/client": { useRpc: (contract: { name: string }) => async (input: { offset: number }) => { calls.push({ name: contract.name, input }); return input.offset === 0 ? { text: full.slice(0, 110), nextOffset: 110 } : { text: full.slice(110), nextOffset: null }; } },
    "@getpaseo/plugin/client/ui": { Markdown: ({ children }: { children: string }) => children, SettingsAction: (props: typeof actions[number]) => { actions.push(props); return props.actionLabel; } },
    "react-native": { View: "View", Text: "Text" },
  });
  const dispose = setup({ rpc: async () => ({ status: "ready" }), addSettingsScreen: () => () => {}, addScreen: () => () => {}, addSidebarHeaderItem: () => () => {}, addTimelineRenderer: (renderer: PluginTimelineRendererContribution) => { renderers.push(renderer); return () => {}; } });
  try {
    const renderer = renderers.find(value => value.kind === "askuser")!;
    const render = () => { cursor = 0; actions.length = 0; return renderedText((renderer.Component as (props: unknown) => unknown)({ item: { data: renderer.schema.parse(base) }, theme: { colors: { foreground: "fg", foregroundMuted: "muted", statusDanger: "danger" } } })); };
    expect(render()).toContain("警示摘要"); expect(calls).toEqual([]);
    actions[0].onPress();
    await vi.waitFor(() => expect(render()).toContain("完整警示说明：请先核对生产环境。"));
    expect(calls).toEqual([0, 110].map(offset => ({ name: "askuser.read", input: { connectionKey: "connection", issueId: "issue", commentId: "comment", attachmentId: "file", revision: "v1", offset } })));
  } finally { dispose(); }
});


async function askuserActionHarness(answer: Answer, extra: Record<string, unknown> = {}) {
  const tree = componentTree();
  const calls: Array<{ name: string; input: unknown }> = [];
  const buttons: Array<{ accessibilityLabel: string; disabled?: boolean; onPress(): unknown }> = [];
  const renderers: PluginTimelineRendererContribution[] = [];
  const rpcs = new Map<string, (input: unknown) => Promise<unknown>>();
  const base = { connectionKey: "connection", issueId: "issue", rootId: "root", commentId: "card", attachmentId: "file", revision: "v1", title: "发布确认", questions: [{ id: "reason", title: "理由", type: "text" }], status: "pending", readOnly: false, offline: false, truncated: false, collapsed: true, ...extra };
  const setup = await bundledContribution("../index.client.tsx", {
    react: tree.react,
    "@getpaseo/plugin/client": { useRpc: (contract: { name: string }) => {
      if (!rpcs.has(contract.name)) rpcs.set(contract.name, async input => { calls.push({ name: contract.name, input }); return contract.name === "askuser.observe" ? base : answer(contract.name, input); });
      return rpcs.get(contract.name);
    } },
    "@getpaseo/plugin/client/ui": { Markdown: ({ children }: { children: unknown }) => children },
    "react-native": { View: "View", Text: "Text", Pressable: (props: typeof buttons[number] & { children: unknown }) => { buttons.push(props); return props.children; } },
  });
  const dispose = setup({ rpc: async () => ({ status: "ready" }), addSettingsScreen: () => () => {}, addScreen: () => () => {}, addSidebarHeaderItem: () => () => {}, addTimelineRenderer: (renderer: PluginTimelineRendererContribution) => { renderers.push(renderer); return () => {}; } });
  const renderer = renderers.find(value => value.kind === "askuser")!;
  const render = () => { buttons.length = 0; return tree.render(createElement(renderer.Component as FunctionComponent<any>, { item: { data: renderer.schema.parse(base) }, theme: { colors: { foreground: "fg", foregroundMuted: "muted", statusDanger: "danger" } } })); };
  return { calls, buttons, render, button: (label: string) => { render(); const button = buttons.find(button => button.accessibilityLabel === label); expect(button, label).toBeDefined(); return button!; }, dispose: () => { tree.unmount(); dispose(); } };
}


it("the compiled askuser card reopens locally collapsed forms and requires a separate confirmation before remote skip", async () => {
  const h = await askuserActionHarness((name) => ({ connectionKey: "connection", issueId: "issue", rootId: "root", commentId: "card", attachmentId: "file", revision: "v2", title: "发布确认", questions: [], status: name === "askuser.skip" ? "skipped" : "pending", collapsed: false, readOnly: name === "askuser.skip", offline: false, truncated: false }));
  try {
    expect(h.render()).toContain("已在本地收起");
    h.button("跳过此卡").onPress(); expect(h.render()).toContain("此操作会在 Multica 跳过此卡");
    h.button("取消").onPress(); h.render();
    expect(h.calls.filter(call => call.name === "askuser.skip")).toEqual([]);
    h.button("重新展开作答").onPress();
    await vi.waitFor(() => expect(h.calls.filter(call => call.name === "askuser.reopen")).toHaveLength(1));
    await vi.waitFor(() => expect(h.render()).not.toContain("已在本地收起"));
    expect(h.calls.find(call => call.name === "askuser.reopen")?.input).toEqual({ connectionKey: "connection", issueId: "issue", commentId: "card", attachmentId: "file" });
    h.button("跳过此卡").onPress(); h.button("确认远端跳过").onPress();
    await vi.waitFor(() => expect(h.render()).toContain("已跳过"));
    expect(h.calls.filter(call => call.name === "askuser.skip")).toEqual([{ name: "askuser.skip", input: { connectionKey: "connection", issueId: "issue", commentId: "card", attachmentId: "file", confirmed: true } }]);
  } finally { h.dispose(); }
});

it("the compiled card reports a failed skip honestly, blocks repeated clicks, and requires confirmation again for retry", async () => {
  let reject!: (error: Error) => void;
  const h = await askuserActionHarness(() => new Promise((_, fail) => { reject = fail; }));
  try {
    h.render(); await Promise.resolve();
    h.button("跳过此卡").onPress();
    const confirm = h.button("确认远端跳过"); confirm.onPress(); confirm.onPress();
    expect(h.calls.filter(call => call.name === "askuser.skip")).toHaveLength(1);
    reject(new Error("跳过未确认（HTTP 403），请核对权限。"));
    await vi.waitFor(() => expect(h.render()).toContain("HTTP 403"));
    expect(h.render()).toContain("待答"); expect(h.render()).not.toContain("已跳过");
    expect(h.buttons.some(button => button.accessibilityLabel === "确认远端跳过")).toBe(false);
    h.button("跳过此卡").onPress(); h.button("取消").onPress();
    expect(h.calls.filter(call => call.name === "askuser.skip")).toHaveLength(1);
  } finally { h.dispose(); }
});

it.each([{ readOnly: true, readOnlyReason: "仅指定用户 other 可作答。" }, { readOnly: true, offline: true }, { status: "answered" }, { status: "skipped" }, { status: "invalid" }])("the compiled card hides reopen and skip controls for read-only or terminal cards: %j", async extra => {
  const h = await askuserActionHarness(() => { throw new Error("Unexpected action"); }, extra);
  try {
    h.render(); await Promise.resolve(); h.render();
    expect(h.buttons).toEqual([]);
    expect(h.calls.some(call => call.name === "askuser.skip" || call.name === "askuser.reopen")).toBe(false);
  } finally { h.dispose(); }
});

it("the compiled failed-answer card reports its error and explains conditions with question titles and labels", async () => {
  const renderers: PluginTimelineRendererContribution[] = [];
  const pressables: Array<{ onPress(): void }> = [];
  const opened: unknown[] = [];
  const tree = componentTree();
  const data = { connectionKey: "connection", issueId: "issue", rootId: "root", commentId: "card", attachmentId: "file", revision: "revision", title: "发布确认", status: "pending", readOnly: true, offline: false, truncated: false,
    delivery: { status: "failed", clientMessageId: "answer", message: "回答发送失败" },
    questions: [{ id: "choice", type: "single", title: "发布范围", options: [{ id: "all", label: "全量" }, { id: "small", label: "灰度" }] }, { id: "detail", type: "text", title: "理由", required_when: { question_id: "choice", option_ids: ["all"] } }] };
  const setup = await bundledContribution("../index.client.tsx", {
    react: tree.react, "@getpaseo/plugin/client": { useRpc: () => async () => data },
    "@getpaseo/plugin/client/ui": { Markdown: ({ children }: { children: string }) => children },
    "react-native": { View: "View", Text: "Text", Pressable: (props: typeof pressables[number] & { children: unknown }) => { pressables.push(props); return props.children; } },
  });
  const dispose = setup({ rpc: async () => ({ status: "ready" }), openScreen: (value: unknown) => { opened.push(value); }, addSettingsScreen: () => () => {}, addScreen: () => () => {}, addSidebarHeaderItem: () => () => {}, addTimelineRenderer: (renderer: PluginTimelineRendererContribution) => { renderers.push(renderer); return () => {}; } });
  try {
    const renderer = renderers.find(value => value.kind === "askuser")!;
    const text = tree.render(createElement(renderer.Component as FunctionComponent<any>, { item: { type: "plugin", kind: "askuser", version: 1, data: renderer.schema.parse(data) }, theme: { colors: {} } }));
    expect(text).toContain("「发布范围」选择「全量」时必填"); expect(text).toContain("回答发送失败");
    expect(pressables).toHaveLength(0); expect(opened).toEqual([]);
  } finally { tree.unmount(); dispose(); }
});

it.each([
  { categories: ["done"], statuses: [], selected: ["done"], whole: ["done"] },
  { categories: [], statuses: ["done"], selected: ["done"], whole: ["done"] },
  { categories: ["unstarted", "started"], statuses: ["todo", "done"], selected: ["todo"], whole: ["unstarted"] },
  { categories: [], statuses: [], selected: [], whole: [] },
])("normalizes category and concrete selections from an existing rule: %j", async example => {
  const rule = { ...defaultRule, statusCategories: example.categories as TaskRule["statusCategories"], statuses: example.statuses };
  const h = await settingsHarness((name, input) => {
    if (name === "connection.status") return readyStatus;
    if (name === "workspace.list") return { connectionKey: "current", workspaces: [{ id: "ws", name: "Team space", enabled: true, rule, importedCount: 0 }] };
    if (name === "workspace.catalog")
      return { assignees: [], statuses: [{ key: "todo", name: "Todo", category: "unstarted" }, { key: "doing", name: "Doing", category: "started" }, { key: "done", name: "Done", category: "done" }], projects: [], labels: [] };
    if (name === "workspace.rule") return { status: "saved" };
    return empty(name, input);
  });
  try {
    await vi.waitFor(() => expect(h.render()).toContain("Team space"));
    h.action("编辑筛选").onPress();
    await vi.waitFor(() => expect(h.render()).toContain("Todo"));
    for (const [key, label] of [["todo", "Todo"], ["doing", "Doing"], ["done", "Done"]])
      expect(h.checkbox(label).accessibilityState?.checked).toBe(example.selected.includes(key));
    await h.save();
    await vi.waitFor(() => expect(h.calls).toContainEqual({ name: "workspace.rule", input: { workspaceId: "ws", connectionKey: "current", rule: { ...rule, statusCategories: example.whole, statuses: [] } } }));
  } finally { h.dispose(); }
});

it.each(["rule", "enable", "disable"])("keeps the saved %s visible when background sync fails and shows progress separately", async action => {
  const workspace = { id: "ws", name: "Team space", enabled: action !== "enable", rule: defaultRule, importedCount: 2 };
  let sync = { status: "ready", stage: "idle", completedWorkspaces: 1, enabledWorkspaces: 1, completedArchives: 0, pendingArchives: 0, message: "" };
  const h = await settingsHarness((name, input) => {
    if (name === "connection.status") return { ...readyStatus, sync };
    if (name === "workspace.list") return { connectionKey: "current", workspaces: [workspace] };
    if (name === "workspace.catalog") return filterCatalog;
    if (name === "workspace.preview") return { total: 2, imported: 2, entering: 0, leaving: [] };
    if (name === "workspace.rule" || name === "workspace.enable") {
      if (name === "workspace.rule") workspace.rule = (input as { rule: TaskRule }).rule;
      else workspace.enabled = (input as { enabled: boolean }).enabled;
      sync = { ...sync, status: "syncing", stage: action === "disable" ? "archiving" : "issues", completedWorkspaces: 0, pendingArchives: action === "disable" ? 2 : 0 };
      return { status: "saved", sync };
    }
    return empty(name, input);
  });
  try {
    await vi.waitFor(() => expect(h.render()).toContain("Team space"));
    if (action === "disable") {
      h.switches[0].onValueChange(false); h.render(); h.press("停用");
    } else {
      h.action(action === "enable" ? "启用…" : "编辑筛选").onPress();
      await vi.waitFor(() => expect(h.render()).toContain("Bug"));
      h.press("Bug"); h.render(); await h.save(action === "enable" ? "启用并导入" : "保存");
    }
    await vi.waitFor(() => { h.render(); expect(h.modals).toHaveLength(0); });
    const page = h.render();
    expect(page).toContain(action === "disable" ? "已关闭同步，本地任务正在后台归档" : action === "enable" ? "已启用，后台正在同步任务" : "筛选规则已保存，后台同步进行中");
    expect(page).toContain(action === "disable" ? "本地任务归档 · 已归档 0 项 · 剩余 2 项" : "任务与筛选核对 · Multica 工作区 0/1");
    if (action === "disable") expect(h.action("启用…").hint).toContain("正在归档本地任务（剩余 2 项）");
    sync = { ...sync, status: "unavailable", message: "同步失败，后台将重试" };
    h.press("刷新");
    await vi.waitFor(() => expect(h.render()).toContain("同步失败，后台将重试"));
    expect(h.modals).toHaveLength(0);
    const savedReceipt = action === "disable" ? "已关闭同步。" : action === "enable" ? "已启用。" : "筛选规则已保存。";
    for (const state of ["unavailable", "ready"]) {
      sync = { ...sync, status: state, stage: state === "ready" ? "idle" : sync.stage, pendingArchives: state === "ready" ? 0 : sync.pendingArchives };
      h.press("刷新");
      await vi.waitFor(() => {
        const page = h.render();
        expect(page).toContain(savedReceipt);
        expect(page).toContain(state === "ready" ? "已完成" : "同步失败");
        for (const ongoing of ["后台同步进行中", "后台正在同步任务", "本地任务正在后台归档"]) expect(page).not.toContain(ongoing);
      });
    }
    if (action === "disable") expect(h.action("启用…").hint).toContain("待归档 2 项，后台将重试");
    else {
      expect(h.switches[0].value).toBe(true);
      h.action("编辑筛选").onPress();
      await vi.waitFor(() => { h.render(); expect(h.checkbox("Bug").accessibilityState?.checked).toBe(true); });
    }
  } finally { h.dispose(); }
});

it("polls settings every two seconds during sync and returns to ten seconds when ready", async () => {
  let syncing = true;
  const h = await settingsHarness(name => name === "connection.status"
    ? { ...readyStatus, sync: { status: syncing ? "syncing" : "ready", stage: syncing ? "issues" : "idle", completedWorkspaces: 0, enabledWorkspaces: 1 } }
    : name === "workspace.list" ? { connectionKey: "current", workspaces: [] } : empty(name, {}));
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  const reads = () => h.calls.filter(call => call.name === "connection.status").length;
  try {
    h.render();
    await vi.advanceTimersByTimeAsync(0);
    expect(h.render()).toContain("任务与筛选核对 · Multica 工作区 0/1");
    expect(reads()).toBe(1);
    await vi.advanceTimersByTimeAsync(1_999);
    expect(reads()).toBe(1);
    syncing = false;
    await vi.advanceTimersByTimeAsync(1);
    expect(reads()).toBe(2);
    h.render();
    await vi.advanceTimersByTimeAsync(9_999);
    expect(reads()).toBe(2);
    await vi.advanceTimersByTimeAsync(1);
    expect(reads()).toBe(3);
    expect(h.calls.filter(call => call.name === "profile.list")).toHaveLength(1);
  } finally { h.dispose(); vi.useRealTimers(); }
});

it("shows the daemon read error even when the previous status was syncing", async () => {
  let failed = false;
  const h = await settingsHarness(name => {
    if (name === "connection.status") {
      if (failed) throw new Error("daemon disconnected");
      return { ...readyStatus, sync: { status: "syncing", stage: "issues", completedWorkspaces: 0, enabledWorkspaces: 1 } };
    }
    return name === "workspace.list" ? { connectionKey: "current", workspaces: [] } : empty(name, {});
  });
  try {
    await vi.waitFor(() => expect(h.render()).toContain("任务与筛选核对"));
    failed = true; h.press("刷新");
    await vi.waitFor(() => expect(h.render()).toContain("已读历史仍可阅读。"));
  } finally { h.dispose(); }
});

it("does not announce task archiving when disabling a workspace with no imported tasks", async () => {
  const workspace = { id: "ws", name: "Empty space", enabled: true, rule: defaultRule, importedCount: 0 };
  let sync = { status: "ready", stage: "idle", completedWorkspaces: 1, enabledWorkspaces: 1 };
  const h = await settingsHarness((name, input) => {
    if (name === "connection.status") return { ...readyStatus, sync };
    if (name === "workspace.list") return { connectionKey: "current", workspaces: [workspace] };
    if (name === "workspace.catalog") return filterCatalog;
    if (name === "workspace.enable") {
      workspace.enabled = false;
      sync = { ...sync, status: "syncing", stage: "connection", completedWorkspaces: 0 };
      return { status: "saved", sync };
    }
    return empty(name, input);
  });
  try {
    await vi.waitFor(() => expect(h.render()).toContain("Empty space"));
    h.switches[0].onValueChange(false); h.render(); h.press("停用");
    await vi.waitFor(() => { h.render(); expect(h.modals).toHaveLength(0); });
    expect(h.render()).toContain("已关闭同步。");
    expect(h.render()).not.toContain("本地任务正在后台归档");
    expect(h.action("启用…").hint).toBeUndefined();
  } finally { h.dispose(); }
});
