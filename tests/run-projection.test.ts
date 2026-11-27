import { expect, it } from "vitest";
import type { ProviderEvent } from "@getpaseo/plugin/server/provider";
import { issueSchema } from "../server/state.js";
import type { RunDetail } from "../server/run-details.js";
import { RunProjection } from "../server/run-projection.js";

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
