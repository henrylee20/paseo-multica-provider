import { expect, it, vi } from "vitest";
import type { ProviderEvent } from "@getpaseo/plugin/server/provider";
import { issueSchema } from "../server/state.js";
import type { RunDetail } from "../server/run-details.js";
import { missingRunItems, RunProjection } from "../server/run-projection.js";
import type { NativeHost } from "../server/native-host.js";

function fixture() {
  const issue = issueSchema.parse({ remoteWorkspaceId: "workspace", workspaceId: "native", cwd: "/placeholder", title: "Issue", description: "",
    runs: { run: { agentId: "agent", agentName: "Agent", status: "completed", ownerRootId: "main", coalescedCommentIds: [], supplementCommentIds: [], triggerCommentId: "unknown" } },
  });
  const details: Record<string, RunDetail> = { run: { messages: [{ task_id: "run", issue_id: "issue", seq: 0, type: "text", content: "First available" }, { task_id: "run", issue_id: "issue", seq: 2, type: "text", content: "Last available" }] } };
  const events: ProviderEvent[] = [];
  const projection = new RunProjection("parent", "main", event => events.push(event), runId => details[runId]);
  return { issue, events, projection, details };
}

it("ends a terminal child immediately and appends finalized output after an irrecoverable sequence gap", () => {
  const { issue, events, projection, details } = fixture();
  projection.project(issue);
  expect(events.filter(event => event.type === "timeline.item" && event.item.type === "assistant_message")).toMatchObject([{ item: { text: "First available" } }]);
  expect(events.filter(event => event.type === "session.turn")).toMatchObject([{ state: "started" }, { state: "completed" }]);
  details.run.finalized = true;
  projection.project(issue, false);
  expect(events.filter(event => event.type === "timeline.item" && event.item.type === "assistant_message")).toMatchObject([{ item: { text: "First available" } }, { item: { text: "Last available" } }]);
  expect(events.flatMap(event => event.type === "timeline.item" && event.item.type === "assistant_message" ? [event.item.messageId] : [])).toEqual(["run-text:run:0", "run-text:run:2"]);
  expect(events.at(-1)).toMatchObject({ type: "timeline.item", item: { type: "assistant_message", text: "Last available" } });
  expect(events.filter(event => event.type === "session.turn")).toMatchObject([{ state: "started" }, { state: "completed" }]);
  expect(events).toContainEqual(expect.objectContaining({ type: "session.opened", description: "由关联评论触发" }));
});

it("keeps the child identity across parent sessions and acknowledges explicit child closes", () => {
  const { issue, events, projection } = fixture();
  projection.project(issue); issue.runs.run.markerProjected = true;
  const reopened: ProviderEvent[] = [];
  new RunProjection("new-parent", "main", event => reopened.push(event)).project(issue, false);
  expect(events.find(event => event.type === "session.opened")).toMatchObject({ sessionId: "multica:run:run", parentSessionId: "parent" });
  expect(reopened.find(event => event.type === "session.opened")).toMatchObject({ sessionId: "multica:run:run", parentSessionId: "new-parent" });
  expect(reopened.some(event => event.type === "timeline.item" && event.sessionId === "new-parent")).toBe(false);
  expect(projection.closeChild("multica:run:run")).toBe(true);
  const count = events.length; projection.project(issue, false);
  expect(events.slice(count).filter(event => event.type === "session.opened")).toHaveLength(1);
  expect(events.slice(count).filter(event => event.type === "timeline.item")).toEqual([]);
});

it("continues merged native text prefixes and skips existing reasoning, tools, errors and metadata on hot reload", async () => {
  const { issue, events, projection, details } = fixture();
  issue.runs.run.markerProjected = true; issue.runs.run.status = "running";
  issue.runs.run.metadata = { work_dir: "/remote", error: "Failure" };
  const source = { task_id: "run", issue_id: "issue" };
  details.run = { messages: [
    { ...source, seq: 1, type: "text", content: "Hello" }, { ...source, seq: 2, type: "text", content: " world" },
    { ...source, seq: 3, type: "thinking", content: "Plan" }, { ...source, seq: 4, type: "thinking", content: "More" },
    { ...source, seq: 5, type: "tool_use", tool: "read", input: {} },
    { ...source, seq: 6, type: "error", content: "Source error" },
    { ...source, seq: 7, type: "text", content: "After tool" },
  ] };
  const timeline = vi.fn(async (_agent: string, _child: string, options: { direction: string; cursor?: { seq: number } }) => ({
    parentAgentId: "native", subagentId: "multica:run:run", epoch: "epoch", hasOlder: options.direction === "tail", hasNewer: false,
    startCursor: { epoch: "epoch", seq: options.direction === "tail" ? 3 : 1 },
    rows: (options.direction === "tail" ? [
      { type: "reasoning", text: "PlanMore" }, { type: "tool_call", callId: "run-message:run:5:0" },
      { type: "error", message: "Source error" }, { type: "notification", level: "info", message: "远端目录：/remote" },
      { type: "error", message: "任务错误：Failure" },
    ] : [{ type: "notification", level: "info", message: "执行中" }, { type: "assistant_message", messageId: "run-text:run:1", text: "Hello wo" }]).map(item => ({ item })),
  }));
  const host = { listProviderSubagents: async () => ({ parentAgentId: "native", subagents: [{ id: "multica:run:run" }] }), fetchProviderSubagentTimeline: timeline } as unknown as NativeHost;
  await projection.restore(host, "native", issue); projection.project(issue, false);
  expect(timeline.mock.calls.map(call => call[2])).toMatchObject([{ direction: "tail" }, { direction: "before", cursor: { seq: 3 } }]);
  expect(events.filter(event => event.type === "timeline.item")).toMatchObject([
    { item: { type: "assistant_message", text: "rld", messageId: "run-text:run:1" } },
    { item: { type: "assistant_message", text: "After tool", messageId: "run-text:run:7" } },
  ]);
  const count = events.length;
  details.run.messages.push({ ...source, seq: 8, type: "text", content: " + new" });
  issue.runs.run.status = "completed"; projection.project(issue, false); projection.project(issue, false);
  expect(events.slice(count)).toMatchObject([
    { type: "timeline.item", item: { type: "assistant_message", text: " + new", messageId: "run-text:run:7" } },
    { type: "session.turn", sessionId: "multica:run:run", state: "completed" },
  ]);
});

it.each(["list", "timeline", "gap", "cycle"])("restores status without replaying an unknown cached batch after a native %s failure", async failure => {
  const { issue, events, projection, details } = fixture();
  issue.runs.run.markerProjected = true; issue.runs.run.status = "running";
  details.run = { messages: [{ task_id: "run", issue_id: "issue", seq: 1, type: "text", content: "Old" }] };
  const host = {
    listProviderSubagents: async () => {
      if (failure === "list") throw new Error("offline");
      return { parentAgentId: "native", subagents: [{ id: "multica:run:run" }] };
    }, fetchProviderSubagentTimeline: async () => {
      if (failure === "timeline") throw new Error("offline");
      return { parentAgentId: "native", subagentId: "multica:run:run", epoch: "epoch", gap: failure === "gap", rows: [], hasOlder: true, startCursor: { epoch: "epoch", seq: 1 } };
    },
  } as unknown as NativeHost;
  await projection.restore(host, "native", issue); projection.project(issue, false);
  expect(events.some(event => event.type === "timeline.item")).toBe(false);
  expect(events).toContainEqual(expect.objectContaining({ type: "session.turn", state: "started" }));
  details.run.messages.push({ task_id: "run", issue_id: "issue", seq: 2, type: "text", content: "New" });
  issue.runs.run.status = "completed"; projection.project(issue, false);
  expect(events.filter(event => event.type === "timeline.item")).toMatchObject([{ item: { text: "New" } }]);
  expect(events.at(-1)).toMatchObject({ type: "session.turn", state: "completed" });
});

it("fully replays the cache when the daemon no longer has this subagent", async () => {
  const { issue, events, projection } = fixture();
  issue.runs.run.markerProjected = true;
  const host = { listProviderSubagents: async () => ({ parentAgentId: "native", subagents: [] }) } as unknown as NativeHost;
  await projection.restore(host, "native", issue); projection.project(issue, false);
  expect(events.filter(event => event.type === "timeline.item")).toMatchObject([{ item: { text: "First available" } }]);
  expect(events.at(-2)).toMatchObject({ type: "session.turn", state: "completed" });
});

it("matches thinking across native status boundaries without skipping new thinking", () => {
  expect(missingRunItems([
    { type: "reasoning", id: "one", text: "First" }, { type: "reasoning", id: "two", text: "Second" },
    { type: "error", id: "boundary", message: "Error" }, { type: "reasoning", id: "three", text: "New" },
  ], [
    { type: "reasoning", text: "First" }, { type: "notification", level: "info", message: "执行中" },
    { type: "reasoning", text: "Second" }, { type: "error", message: "Error" },
  ])).toEqual([{ type: "reasoning", id: "three", text: "New" }]);
});

it.each([true, false])("keeps the native replay baseline until an initially missing source cache arrives, native read succeeds: %s", async readable => {
  const { issue, events, projection, details } = fixture();
  issue.runs.run.markerProjected = true; issue.runs.run.status = "running"; delete details.run;
  const host = {
    listProviderSubagents: async () => ({ parentAgentId: "native", subagents: [{ id: "multica:run:run" }] }),
    fetchProviderSubagentTimeline: async () => {
      if (!readable) throw new Error("Offline");
      return { parentAgentId: "native", subagentId: "multica:run:run", rows: [{ item: { type: "assistant_message", messageId: "run-text:run:1", text: "Old" } }], hasOlder: false };
    },
  } as unknown as NativeHost;
  await projection.restore(host, "native", issue); projection.project(issue, false);
  details.run = { messages: [{ task_id: "run", issue_id: "issue", seq: 1, type: "text", content: "Old" }] };
  projection.project(issue, false);
  expect(events.some(event => event.type === "timeline.item" && event.item.type === "assistant_message")).toBe(false);
  details.run.messages.push({ task_id: "run", issue_id: "issue", seq: 2, type: "text", content: "New" });
  projection.project(issue, false);
  expect(events.filter(event => event.type === "timeline.item" && event.item.type === "assistant_message")).toMatchObject([{ item: { text: "New" } }]);
});

it("consumes old status notifications once while the source cache is missing and statuses recur", async () => {
  const { issue, events, projection, details } = fixture();
  issue.runs.run.markerProjected = true; issue.runs.run.status = "queued"; delete details.run;
  const host = {
    listProviderSubagents: async () => ({ parentAgentId: "native", subagents: [{ id: "multica:run:run" }] }),
    fetchProviderSubagentTimeline: async () => ({ parentAgentId: "native", subagentId: "multica:run:run", hasOlder: false, rows: [
      { item: { type: "notification", level: "info", message: "排队中" } },
      { item: { type: "assistant_message", messageId: "run-text:run:1", text: "Old" } },
    ] }),
  } as unknown as NativeHost;
  await projection.restore(host, "native", issue); projection.project(issue, false);
  expect(events.filter(event => event.type === "timeline.item")).toEqual([]);
  for (const status of ["running", "queued"] as const) { issue.runs.run.status = status; projection.project(issue, false); }
  expect(events.filter(event => event.type === "timeline.item")).toMatchObject([
    { item: { type: "notification", message: "执行中" } }, { item: { type: "notification", message: "排队中" } },
  ]);
  details.run = { messages: [{ task_id: "run", issue_id: "issue", seq: 1, type: "text", content: "Old" }] };
  projection.project(issue, false);
  expect(events.some(event => event.type === "timeline.item" && event.item.type === "assistant_message")).toBe(false);
});

it("keeps adjacent text fragments in one native assistant message", () => {
  const { issue, events, projection, details } = fixture();
  issue.runs.run.status = "running";
  const fragments = ["已", "确认：仅部署 connector", "。接下来建立测试集。\n"];
  details.run = { messages: fragments.map((content, seq) => ({ task_id: "run", issue_id: "issue", seq, type: "text", content })) };
  projection.project(issue);
  const items = events.flatMap(event => event.type === "timeline.item" && event.item.type === "assistant_message" ? [event.item] : []);
  expect(items.map(item => item.text).join("")).toBe(fragments.join(""));
  expect(new Set(items.map(item => item.messageId ?? item.id)).size).toBe(1);
  expect(items.map(item => item.id)).toEqual(fragments.map((_, seq) => `run-message:run:${seq}:0`));
});

it.each(["tool_use", "tool_result", "thinking", "error"] as const)("starts a new native assistant message after a %s source message", type => {
  const { issue, events, projection, details } = fixture();
  details.run = { messages: [
    { task_id: "run", issue_id: "issue", seq: 0, type: "text", content: "Before" },
    { task_id: "run", issue_id: "issue", seq: 1, type, content: "Boundary" },
    { task_id: "run", issue_id: "issue", seq: 2, type: "text", content: "After" },
  ] };
  projection.project(issue);
  const items = events.flatMap(event => event.type === "timeline.item" && event.item.type === "assistant_message" ? [event.item] : []);
  expect(items.map(item => item.messageId)).toEqual(["run-text:run:0", "run-text:run:2"]);
});

it("shares one native assistant message across transport chunks of a long source text", () => {
  const { issue, events, projection, details } = fixture();
  details.run = { messages: [{ task_id: "run", issue_id: "issue", seq: 0, type: "text", content: "x".repeat(8192) + "尾" }] };
  projection.project(issue);
  const items = events.flatMap(event => event.type === "timeline.item" && event.item.type === "assistant_message" ? [event.item] : []);
  expect(items.map(item => item.text)).toEqual(["x".repeat(8192), "尾"]);
  expect(items.map(item => item.messageId)).toEqual(["run-text:run:0", "run-text:run:0"]);
  expect(items.map(item => item.id)).toEqual(["run-message:run:0:0", "run-message:run:0:1"]);
});

it("continues a text segment across incremental reads and restores the same identity on replay", () => {
  const { issue, events, projection, details } = fixture();
  issue.runs.run.status = "running";
  details.run = { messages: [{ task_id: "run", issue_id: "issue", seq: 1, type: "text", content: "First" }] };
  projection.project(issue);
  expect(events.filter(event => event.type === "timeline.item" && event.item.type === "assistant_message")).toHaveLength(1);
  details.run.messages.push({ task_id: "run", issue_id: "issue", seq: 2, type: "text", content: "\n\nNext" });
  projection.project(issue);
  const replay: ProviderEvent[] = [];
  new RunProjection("parent", "main", event => replay.push(event), runId => details[runId]).project(issue);
  for (const projected of [events, replay]) {
    const items = projected.flatMap(event => event.type === "timeline.item" && event.item.type === "assistant_message" ? [event.item] : []);
    expect(items.map(item => item.text)).toEqual(["First", "\n\nNext"]);
    expect(items.map(item => item.messageId)).toEqual(["run-text:run:1", "run-text:run:1"]);
  }
});

it.each(["completed", "failed", "cancelled"] as const)("a cached %s Run ends even without finalized details or a message cache", status => {
  for (const cached of [true, false]) {
    const { issue, events, projection, details } = fixture();
    issue.runs.run.status = status;
    if (cached) { details.run.messages.shift(); details.run.finalized = false; }
    else delete details.run;
    projection.project(issue);
    expect(events.some(event => event.type === "timeline.item" && event.item.type === "assistant_message")).toBe(false);
    expect(events.filter(event => event.type === "session.turn")).toMatchObject([{ state: "started" }, { state: status === "cancelled" ? "canceled" : status }]);
    const count = events.length;
    projection.project(issue);
    expect(events).toHaveLength(count);
  }
});
