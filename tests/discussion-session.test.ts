import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import type { ProviderEvent } from "@getpaseo/plugin/server/provider";
import { AskUsers } from "../server/askuser.js";
import { CommentDelivery } from "../server/delivery.js";
import { threadPersistence } from "../server/discussion-identity.js";
import { DiscussionLifecycle } from "../server/discussion-lifecycle.js";
import { DiscussionMetadata } from "../server/discussion-metadata.js";
import { DiscussionSession } from "../server/discussion-session.js";
import { RunDetails } from "../server/run-details.js";
import { storedRunSchema, type StoredRun } from "../server/run-state.js";
import { RunSynchronizer } from "../server/runs.js";
import { connectionState, issueSchema, StateStore, type IssueMapping } from "../server/state.js";
import { StopCoordinator } from "../server/stops.js";
import { TaskDescriptions } from "../server/task-description.js";
import type { StoredRow } from "../server/thread-state.js";
import { ThreadSynchronizer } from "../server/threads.js";

const cleanup: Array<() => void | Promise<void>> = [];
afterEach(async () => { for (const dispose of cleanup.splice(0).reverse()) await dispose(); });
const address = { connectionKey: "connection", issueId: "issue", rootId: "root" };
const stamp = "2026-11-24T10:00:00Z";
const later = "2026-11-24T10:00:01Z";
const last = "2026-11-24T10:00:02Z";
const row = (commentId: string, sourceCreatedAt = stamp): StoredRow => ({
  id: `multica:comment:${commentId}`, commentId, role: "assistant", text: commentId, sourceCreatedAt,
});
const run = (overrides: Partial<StoredRun> = {}): StoredRun => storedRunSchema.parse({
  agentId: "agent", agentName: "Agent", status: "completed", ownerRootId: "root", triggerCommentId: "root",
  coalescedCommentIds: [], supplementCommentIds: [], createdAt: later, ...overrides,
});

async function fixture(seed: (issue: IssueMapping) => void) {
  const directory = await mkdtemp(join(tmpdir(), "multica-discussion-session-"));
  cleanup.push(() => rm(directory, { recursive: true, force: true }));
  const store = new StateStore(directory);
  const issue = issueSchema.parse({ remoteWorkspaceId: "remote-workspace", workspaceId: "workspace", cwd: directory, title: "Issue", description: "Goal",
    threads: { root: { title: "Thread", historyLoaded: true, rows: [row("root")] } }, commentRoots: { root: "root" } });
  seed(issue);
  await store.update(state => { connectionState(state, address.connectionKey).issues[address.issueId] = issue; });
  let unexpectedCalls = 0;
  const unavailable = async (): Promise<never> => { unexpectedCalls++; throw new Error("This local projection test must not request remote dependencies"); };
  const lifecycle = new DiscussionLifecycle(), metadata = new DiscussionMetadata(store);
  const askusers = new AskUsers(store, unavailable, lifecycle);
  const threads = new ThreadSynchronizer(store, unavailable, metadata, askusers);
  const runs = new RunSynchronizer(store), runDetails = new RunDetails(store, unavailable);
  const deliveries = new CommentDelivery(store, unavailable, unavailable, lifecycle);
  const stops = new StopCoordinator(store, unavailable, runs), descriptions = new TaskDescriptions(store);
  const deps = { store, threads, runs, runDetails, deliveries, stops, lifecycle, descriptions, askusers };
  const events: ProviderEvent[] = [];
  const persistence = threadPersistence(address.connectionKey, address.issueId, address.rootId);
  const saved = (await store.read()).connections[address.connectionKey].issues[address.issueId];
  const session = new DiscussionSession(deps, event => { events.push(event); }, ["session.subsession"], {
    type: "session.open", requestId: "open", sessionId: "session", history: "replay", persistence,
    config: { cwd: directory, env: {}, mcpServers: {}, settings: {}, persist: true },
  }, address, saved, persistence, { remove: () => session.release() });
  cleanup.push(async () => {
    session.release();
    await runDetails.close(); await threads.close(); await askusers.close(); await stops.close(); await deliveries.close();
    descriptions.close(); runs.close(); await metadata.close(); await store.read();
    // Connection failures may be swallowed by offline recovery; still fail the test.
    expect(unexpectedCalls).toBe(0);
  });
  await session.open();
  await store.read();
  return {
    order: () => events.flatMap(event => event.type === "timeline.item" && event.sessionId === "session" && /^multica:(comment:|run-marker:|askuser:)/.test(event.item.id)
      ? [event.item.id.replace("multica:", "")] : []),
    update: async (change: (issue: IssueMapping) => void) => {
      await store.update(state => { change(state.connections[address.connectionKey].issues[address.issueId]); });
      await store.read();
    },
  };
}

it("orders mixed missing and invalid Run creation times by ID ahead of dated Runs", async () => {
  const f = await fixture(issue => {
    issue.threads.root.rows.push(row("next", last));
    issue.runs = {
      "z-invalid": run({ createdAt: "invalid" }), "m-missing": run({ createdAt: undefined }), dated: run(),
      "a-missing": run({ createdAt: undefined }), "b-invalid": run({ createdAt: "not-a-date" }),
    };
  });
  expect(f.order()).toEqual(["comment:root", "run-marker:a-missing", "run-marker:b-invalid", "run-marker:m-missing", "run-marker:z-invalid", "run-marker:dated", "comment:next"]);
});

it("waits for its own complete history when a Run trigger belongs to another discussion", async () => {
  const f = await fixture(issue => {
    issue.threads.root.historyLoaded = false; issue.threads.root.rows = [];
    issue.threads.other = { title: "Other", historyLoaded: false, rows: [], observed: {} };
    issue.commentRoots.foreign = "other";
    issue.runs.cross = run({ triggerCommentId: "foreign" });
  });
  expect(f.order()).toEqual([]);
  await f.update(issue => { issue.threads.other.historyLoaded = true; });
  expect(f.order()).toEqual([]);
  await f.update(issue => { issue.threads.root.historyLoaded = true; });
  expect(f.order()).toEqual(["run-marker:cross"]);
});

it("releases a waiting Run when its trigger changes to an already emitted local comment", async () => {
  const f = await fixture(issue => { issue.runs.waiting = run({ triggerCommentId: "unconfirmed" }); });
  expect(f.order()).toEqual(["comment:root"]);
  await f.update(issue => { issue.runs.waiting.triggerCommentId = "root"; });
  expect(f.order()).toEqual(["comment:root", "run-marker:waiting"]);
});

it("appends a late-discovered older Run without reordering or replaying existing comments", async () => {
  const f = await fixture(issue => { issue.threads.root.rows.push(row("next", last)); });
  expect(f.order()).toEqual(["comment:root", "comment:next"]);
  await f.update(issue => { issue.runs.late = run({ createdAt: "2026-11-24T09:00:00Z" }); });
  expect(f.order()).toEqual(["comment:root", "comment:next", "run-marker:late"]);
  await f.update(issue => { issue.runs.late.createdAt = "2026-11-24T09:30:00Z"; });
  expect(f.order()).toEqual(["comment:root", "comment:next", "run-marker:late"]);
});

it("emits a cached source card before a waiting Run marker when one snapshot completes history", async () => {
  const f = await fixture(issue => {
    issue.threads.root.historyLoaded = false;
    issue.runs.waiting = run();
  });
  expect(f.order()).toEqual(["comment:root"]);
  await f.update(issue => {
    issue.askuserAttachments = { form: { document: { version: "1", title: "Question", questions: [{ id: "answer", type: "text", title: "Answer" }] } } };
    issue.askuserCards = { [JSON.stringify(["root", "form"])]: { rootId: "root", commentId: "root", attachmentId: "form", status: "pending" } };
    issue.threads.root.historyLoaded = true;
  });
  expect(f.order()).toEqual(["comment:root", "askuser:root:form", "run-marker:waiting"]);
});
