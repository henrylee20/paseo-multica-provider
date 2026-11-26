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
  expect(events.at(-1)).toMatchObject({ type: "timeline.item", item: { type: "assistant_message", text: "Last available" } });
  expect(events.filter(event => event.type === "session.turn")).toMatchObject([{ state: "started" }, { state: "completed" }]);
  expect(events).toContainEqual(expect.objectContaining({ type: "session.opened", description: "由关联评论触发" }));
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
