import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { taskRuleSchema } from "../shared/contracts.js";
import type { AuthenticatedConnection } from "../server/connection.js";
import { DiscussionLifecycle } from "../server/discussion-lifecycle.js";
import type { NativeHost } from "../server/native-host.js";
import { RunSynchronizer } from "../server/runs.js";
import { RunWakeups } from "../server/run-wakeup.js";
import { connectionState, issueSchema, StateStore, type IssueMapping } from "../server/state.js";

const cleanup: Array<() => void | Promise<void>> = [];
afterEach(async () => { vi.unstubAllGlobals(); for (const dispose of cleanup.splice(0).reverse()) await dispose(); });

async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), "multica-run-wake-"));
  cleanup.push(() => rm(directory, { recursive: true, force: true }));
  const store = new StateStore(directory), lifecycle = new DiscussionLifecycle();
  const address = { connectionKey: "connection", issueId: "issue", rootId: "root" };
  const issue = issueSchema.parse({ remoteWorkspaceId: "remote", workspaceId: "native", cwd: directory, title: "Task", description: "",
    workspaceCreated: true, mainAgentId: "main-agent", threads: { root: { title: "Thread", agentId: "thread-agent" } }, commentRoots: { root: "root" },
    runs: Object.fromEntries(["main", "root"].map(rootId => [rootId, { ownerRootId: rootId, status: "running", agentId: "agent", agentName: "Builder", coalescedCommentIds: [], supplementCommentIds: [] }])) });
  await store.update(state => { const local = connectionState(state, "connection"); local.rules.remote = { ...taskRuleSchema.parse({}), enabled: true }; local.issues.issue = issue; });
  const connection: AuthenticatedConnection = { connectionKey: "connection", apiUrl: "https://example.test", token: "synthetic", userId: "me", assertCurrent: vi.fn(async () => {}) };
  const native = { archived: false, workspace: true, wrongLabels: false, wrongProvider: false, wrongCwd: false, wrongWorkspace: false, fail: false };
  const host = {
    fetchAgent: vi.fn(async (agentId: string) => ({ agent: { id: agentId, provider: native.wrongProvider ? "other" : "multica", archivedAt: native.archived ? "stamp" : null,
      cwd: native.wrongCwd ? "/other" : directory, workspaceId: native.wrongWorkspace ? "other" : "native",
      labels: { "multica.connection": native.wrongLabels ? "other" : "connection", "multica.issue": "issue", "multica.discussion": agentId === "main-agent" ? "main" : "root" } } })),
    fetchWorkspaces: vi.fn(async () => ({ entries: native.workspace ? [{ id: "native" }] : [], pageInfo: { hasMore: false } })),
    listCommands: vi.fn(async (_id: string) => { if (native.fail) throw new Error("Native load failed"); }),
    refreshAgent: vi.fn(async () => { throw new Error("Must not interrupt"); }),
  };
  let now = 0;
  const wakeups = new RunWakeups(store, lifecycle, () => new Date(now));
  cleanup.push(() => wakeups.reset());
  const update = (change: (issue: IssueMapping) => void) => store.update(state => change(state.connections.connection.issues.issue));
  return { store, issue, lifecycle, address, host, native, connection, wakeups, update, clock: (value: number) => { now = value; },
    discover: (settled: Iterable<string> = []) => wakeups.discover(connection, "issue", host as unknown as NativeHost, settled) };
}

it("wakes both main and Thread owners through string-only listCommands with 60 second deduplication", async () => {
  const f = await fixture();
  await Promise.all([f.discover(), f.discover()]);
  expect(f.host.listCommands.mock.calls).toEqual([["main-agent"], ["thread-agent"]]);
  f.clock(59_999); await f.discover(); expect(f.host.listCommands).toHaveBeenCalledTimes(2);
  f.clock(60_000); await f.discover(); expect(f.host.listCommands).toHaveBeenCalledTimes(4);
  expect(f.host.refreshAgent).not.toHaveBeenCalled(); expect(f.connection.assertCurrent).toHaveBeenCalled();
});

it("recovers a terminal transition discovered after hot reload and retries failed wakes without waking old terminal Runs", async () => {
  const f = await fixture();
  const records = [
    { id: "main", issue_id: "issue", agent_id: "agent", status: "completed" },
    { id: "root", issue_id: "issue", agent_id: "agent", status: "failed", trigger_comment_id: "root" },
  ];
  vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify(records), { headers: { "Content-Type": "application/json" } })));
  const runs = new RunSynchronizer(f.store);
  const workspace = { id: "remote", name: "Product", slug: "product", agents: Promise.resolve([{ id: "agent", name: "Builder" }]) };
  const settled = await runs.discover(f.connection, workspace, "issue");
  expect([...settled]).toEqual(["main", "root"]);
  f.native.fail = true; await f.discover(settled);
  f.native.fail = false; await f.discover(); expect(f.host.listCommands).toHaveBeenCalledTimes(2);
  f.clock(60_000); await f.discover(); expect(f.host.listCommands).toHaveBeenCalledTimes(4);
  f.clock(120_000); await f.discover(); expect(f.host.listCommands).toHaveBeenCalledTimes(4);
  expect([...(await runs.discover(f.connection, workspace, "issue"))]).toEqual([]);
  runs.close();
});

it.each(["workspace hidden", "discussion hidden", "archiveReason", "not created", "disabled rule", "hold", "loaded", "native archive", "native workspace", "labels", "provider", "cwd", "workspace", "revoked identity"])("keeps a %s discussion asleep", async guard => {
  const f = await fixture();
  await f.update(issue => {
    delete issue.runs.main;
    if (guard === "workspace hidden") issue.manualHidden.workspace = true;
    if (guard === "discussion hidden") issue.manualHidden.discussions.push("root");
    if (guard === "archiveReason") issue.archiveReason = "filter_exit";
    if (guard === "not created") issue.workspaceCreated = false;
  });
  if (guard === "disabled rule") await f.store.update(state => { state.connections.connection.rules.remote.enabled = false; });
  if (guard === "hold") cleanup.push(await f.lifecycle.hold([f.address]));
  if (guard === "loaded") cleanup.push(f.lifecycle.subscribe(f.address, () => {}));
  if (guard === "native archive") f.native.archived = true;
  if (guard === "native workspace") f.native.workspace = false;
  if (guard === "labels") f.native.wrongLabels = true;
  if (guard === "provider") f.native.wrongProvider = true;
  if (guard === "cwd") f.native.wrongCwd = true;
  if (guard === "workspace") f.native.wrongWorkspace = true;
  if (guard === "revoked identity") f.connection.assertCurrent = async () => { throw new Error("Identity changed"); };
  await f.discover(["root"]);
  expect(f.host.listCommands).not.toHaveBeenCalled(); expect(f.host.refreshAgent).not.toHaveBeenCalled();
});

it("rechecks local guards after native reads and connection validation", async () => {
  const f = await fixture();
  f.connection.assertCurrent = () => f.update(issue => { issue.manualHidden.workspace = true; });
  await f.discover();
  expect(f.host.listCommands).not.toHaveBeenCalled();
});
