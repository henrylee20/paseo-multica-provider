import { expect, it } from "vitest";
import type { ProviderEvent } from "@getpaseo/plugin/server/provider";
import { issueSchema } from "../server/state.js";
import { RunProjection } from "../server/run-projection.js";

function fixture() {
  const issue = issueSchema.parse({ remoteWorkspaceId: "workspace", workspaceId: "native", cwd: "/placeholder", title: "Issue", description: "",
    runs: { run: { agentId: "agent", agentName: "Agent", status: "completed", ownerRootId: "main", coalescedCommentIds: [], supplementCommentIds: [], triggerCommentId: "unknown" } },
    runDetails: { run: { messages: [{ task_id: "run", issue_id: "issue", seq: 0, type: "text", content: "First available" }, { task_id: "run", issue_id: "issue", seq: 2, type: "text", content: "Last available" }] } } });
  const events: ProviderEvent[] = [];
  const projection = new RunProjection("parent", "main", event => events.push(event));
  return { issue, events, projection };
}

it("finishes a terminal child only after finalized output, including an irrecoverable sequence gap", () => {
  const { issue, events, projection } = fixture();
  projection.project(issue, true, true);
  expect(events.filter(event => event.type === "timeline.item" && event.item.type === "assistant_message")).toMatchObject([{ item: { text: "First available" } }]);
  expect(events.filter(event => event.type === "session.turn")).toMatchObject([{ state: "started" }]);
  issue.runDetails.run.finalized = true;
  projection.project(issue, false, true);
  expect(events.filter(event => event.type === "timeline.item" && event.item.type === "assistant_message")).toMatchObject([{ item: { text: "First available" } }, { item: { text: "Last available" } }]);
  expect(events.at(-1)).toMatchObject({ type: "session.turn", state: "completed" });
  expect(events).toContainEqual(expect.objectContaining({ type: "session.opened", description: "由关联评论触发" }));
});

it("a cache-only terminal projection ends without fetching or inventing the missing prefix", () => {
  const { issue, events, projection } = fixture();
  issue.runDetails.run.messages.shift();
  projection.project(issue);
  expect(events.some(event => event.type === "timeline.item" && event.item.type === "assistant_message")).toBe(false);
  expect(events.filter(event => event.type === "session.turn")).toMatchObject([{ state: "started" }, { state: "completed" }]);
});
