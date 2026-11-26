import { mkdtemp, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, expect, it, vi } from "vitest";
import { StateStore, connectionState, issueSchema } from "../server/state.js";
import { SidebarSynchronizer } from "../server/sync.js";
import { DiscussionLifecycle } from "../server/discussion-lifecycle.js";
import { DiscussionMetadata } from "../server/discussion-metadata.js";
import { taskRuleSchema, type TaskRule } from "../shared/contracts.js";

const cleanup: Array<() => Promise<unknown>> = [];
afterEach(async () => { for (const dispose of cleanup.splice(0).reverse()) await dispose(); vi.unstubAllGlobals(); });
const all = taskRuleSchema.parse({ statusCategories: [] });
async function fixture(mode: "supported" | "ignored" | "rejected" = "supported") {
  const directory = await mkdtemp(join(tmpdir(), "multica-preview-"));
  cleanup.push(() => rm(directory, { recursive: true, force: true }));
  const store = new StateStore(directory);
  await store.update(state => {
    const local = connectionState(state, "connection");
    for (let i = 0; i < 205; i++) local.issues[`issue-${i}`] = issueSchema.parse({ remoteWorkspaceId: "workspace", workspaceId: String(i), cwd: directory, title: `Issue ${i}`, description: "",
      ...(i === 0 ? { manualHidden: { workspace: true, discussions: ["main"] } } : {}) });
    local.issues.archived = issueSchema.parse({ ...local.issues["issue-0"], archiveReason: "filter_exit" });
    local.issues.other = issueSchema.parse({ ...local.issues["issue-0"], remoteWorkspaceId: "other" });
  });
  const issues = Array.from({ length: 300 }, (_, offset) => {
    const i = offset + 50;
    return { id: `issue-${i}`, workspace_id: "workspace", title: `Issue ${i}`, description: "full description", status: i % 2 ? "open" : "done", status_category: i % 2 ? "started" : "done",
      assignee: i % 3 ? "agent:agent" : "member:me", project: i % 2 ? "project" : "other", label: i % 3 ? "red" : "blue" };
  });
  const requests: Array<{ url: URL; signal: AbortSignal; slug: string | null }> = [];
  const remote = { mode, mismatch: false, partial: false, changedIdentity: false, authFailure: false,
    before: undefined as ((url: URL, signal: AbortSignal) => Promise<void>) | undefined };
  const fetch = vi.fn(async (input: string, init: RequestInit) => {
    const url = new URL(input), signal = init.signal!;
    signal.throwIfAborted();
    const slug = new Headers(init.headers).get("X-Workspace-Slug");
    requests.push({ url, signal, slug });
    await remote.before?.(url, signal);
    signal.throwIfAborted();
    if (url.pathname === "/api/workspaces") return Response.json([{ id: "workspace", name: "Workspace", slug: "workspace" }, { id: "other", name: "Other", slug: "other" }]);
    if (remote.authFailure) return new Response("", { status: 401 });
    const query = url.searchParams;
    if (query.has("ids") && remote.mode === "rejected") return new Response("", { status: 400 });
    const selected = (key: string, value: string) => !query.has(key) || query.get(key)!.split(",").includes(value);
    const found = slug === "other" ? [] : issues.filter(issue => selected("status_categories", issue.status_category) && selected("statuses", issue.status) &&
      selected("assignee_filters", issue.assignee) && selected("project_ids", issue.project) && selected("label_ids", issue.label) &&
      (remote.mode !== "supported" || selected("ids", issue.id)));
    const offset = Number(query.get("offset") ?? 0), limit = Number(query.get("limit") ?? 100);
    let rows = found.slice(offset, offset + limit);
    if (remote.partial && query.get("ids")) rows = rows.slice(0, 1);
    return Response.json({ total: found.length, issues: rows.map(issue => ({ ...issue, workspace_id: remote.mismatch ? "wrong" : issue.workspace_id })) });
  });
  vi.stubGlobal("fetch", fetch);
  const assertCurrent = vi.fn(async () => { if (remote.changedIdentity) throw new Error("Connection identity changed"); });
  const native = vi.fn(async () => { throw new Error("Preview must not connect to the native host"); });
  let connectionKey = "connection";
  const sync = new SidebarSynchronizer({ store, connection: async () => ({ apiUrl: "https://multica.test", token: "secret", userId: "me", connectionKey, assertCurrent }),
    lifecycle: new DiscussionLifecycle(), metadata: new DiscussionMetadata(store), connectHost: native, intervalMs: 60_000,
    currentProfile: async () => "", invalidateConnection: () => {}, drain: async () => {} });
  cleanup.push(() => sync.close());
  return { store, sync, requests, remote, native, setConnection: (key: string) => { connectionKey = key; } };
}
const issueRequests = (f: Awaited<ReturnType<typeof fixture>>) => f.requests.filter(request => request.url.pathname === "/api/issues");

it("matches the paged preview across server filters, batches IDs by 100 and remembers support per connection", async () => {
  const f = await fixture();
  const file = join(f.store.directory, "state.json"), before = await readFile(file, "utf8");
  const rules: TaskRule[] = [all, taskRuleSchema.parse({}), taskRuleSchema.parse({ statuses: ["open"], assignees: [{ type: "member", id: "me" }], projectIds: ["project"], labelIds: ["blue"] })];
  for (const rule of rules) {
    const fast = await f.sync.preview("workspace", rule, "connection");
    f.remote.mode = "ignored"; f.setConnection("fallback");
    // Give the fallback connection the identical imported snapshot.
    await f.store.update(state => { state.connections.fallback = structuredClone(state.connections.connection); });
    expect(await f.sync.preview("workspace", rule, "fallback")).toEqual(fast);
    f.remote.mode = "supported"; f.setConnection("connection");
  }
  const fastRequests = issueRequests(f).filter(request => request.url.searchParams.has("ids"));
  expect(fastRequests.filter(request => request.url.searchParams.get("ids") === "")).toHaveLength(2); // One probe for each connection.
  expect(fastRequests.filter(request => request.url.searchParams.get("ids")).map(request => request.url.searchParams.get("ids")!.split(",").length)).toEqual([100, 100, 5, 100, 100, 5, 100, 100, 5]);
  expect(fastRequests.filter(request => request.url.searchParams.get("ids")).every(request => !request.url.searchParams.get("ids")!.includes("archived"))).toBe(true);
  expect(issueRequests(f).every(request => request.slug === "workspace")).toBe(true);
  expect(f.native).not.toHaveBeenCalled();
  // Preview itself is read-only; only the explicitly copied fallback connection changed state.
  const saved = JSON.parse(await readFile(file, "utf8")); delete saved.connections.fallback;
  expect(saved).toEqual(JSON.parse(before));
});

it("sends the count and all ID batches concurrently", async () => {
  const f = await fixture();
  await f.sync.preview("workspace", all);
  f.requests.length = 0;
  const releases: Array<() => void> = [];
  f.remote.before = async (url, signal) => {
    if (url.pathname === "/api/issues") await new Promise<void>((resolve, reject) => {
      releases.push(resolve); signal.addEventListener("abort", () => reject(signal.reason), { once: true });
    });
  };
  const pending = f.sync.preview("workspace", all);
  try {
    await expect.poll(() => releases.length).toBe(4);
    const requests = issueRequests(f);
    expect(requests.filter(request => !request.url.searchParams.has("ids"))).toHaveLength(1);
    expect(requests.find(request => !request.url.searchParams.has("ids"))?.url.searchParams.get("limit")).toBe("1");
  } finally { for (const release of releases) release(); }
  expect(await pending).toMatchObject({ total: 300, imported: 205, entering: 145, leaving: expect.arrayContaining([{ id: "issue-0", title: "Issue 0" }]) });
});

it.each(["ignored", "rejected"] as const)("falls back to full pagination when ids are %s without probing again", async mode => {
  const f = await fixture(mode);
  expect(await f.sync.preview("workspace", all)).toMatchObject({ total: 300, imported: 205, entering: 145 });
  expect(await f.sync.preview("workspace", all)).toMatchObject({ total: 300, imported: 205, entering: 145 });
  expect(issueRequests(f).filter(request => request.url.searchParams.has("ids"))).toHaveLength(1);
  expect(issueRequests(f).filter(request => !request.url.searchParams.has("ids")).map(request => request.url.searchParams.get("offset"))).toEqual(["0", "100", "200", "0", "100", "200"]);
});

it("aborts every superseded request only in the same workspace and lets the latest preview finish", async () => {
  const f = await fixture();
  await f.sync.preview("workspace", all);
  f.remote.before = async (url, signal) => {
    if (url.pathname === "/api/issues") await new Promise<void>((_resolve, reject) => signal.addEventListener("abort", () => reject(signal.reason), { once: true }));
  };
  const old = f.sync.preview("workspace", all).catch(error => error);
  await expect.poll(() => issueRequests(f).filter(request => !request.signal.aborted).length).toBe(4);
  const held = issueRequests(f).filter(request => !request.signal.aborted);
  f.remote.before = undefined;
  expect(await f.sync.preview("other", all)).toMatchObject({ total: 0 });
  expect(held.every(request => !request.signal.aborted)).toBe(true);
  expect(await f.sync.preview("workspace", taskRuleSchema.parse({ statuses: ["open"] }))).toMatchObject({ total: 150 });
  expect((await old).name).toBe("AbortError");
  expect(held.every(request => request.signal.aborted)).toBe(true);
});

it("retries an aborted first capability probe for the latest preview", async () => {
  const f = await fixture();
  let probeSignal: AbortSignal | undefined;
  f.remote.before = async (url, signal) => {
    if (url.searchParams.get("ids") === "") {
      probeSignal = signal;
      await new Promise<void>((_resolve, reject) => signal.addEventListener("abort", () => reject(signal.reason), { once: true }));
    }
  };
  const old = f.sync.preview("workspace", all).catch(error => error);
  await expect.poll(() => !!probeSignal).toBe(true);
  f.remote.before = undefined;
  expect(await f.sync.preview("workspace", all)).toMatchObject({ total: 300 });
  expect((await old).name).toBe("AbortError");
  expect(probeSignal?.aborted).toBe(true);
});

it("shares a failed capability probe and retries only on a later preview", async () => {
  const f = await fixture();
  let release!: () => void;
  let readings = 0;
  const response = new Promise<void>(resolve => { release = resolve; });
  f.remote.before = async url => {
    if (url.searchParams.get("ids") === "") {
      readings++;
      await response;
      throw new Error("Probe unavailable");
    }
  };
  const first = f.sync.preview("workspace", all).catch(error => error);
  await expect.poll(() => readings).toBe(1);
  const concurrent = f.sync.preview("other", all).catch(error => error);
  try {
    await expect.poll(() => f.requests.filter(request => request.url.pathname === "/api/workspaces").length).toBe(2);
    // Both cached state reads settle before the next event-loop turn.
    await new Promise<void>(resolve => setImmediate(resolve));
  } finally { release(); }
  expect((await first).message).toBe("Probe unavailable");
  expect((await concurrent).message).toBe("Probe unavailable");
  expect(readings).toBe(1);
  f.remote.before = undefined;
  expect(await f.sync.preview("workspace", all)).toMatchObject({ total: 300 });
  expect(issueRequests(f).filter(request => request.url.searchParams.get("ids") === "")).toHaveLength(2);
});

it("retains workspace, ID-page completeness and identity guards on the fast path without treating auth failure as incompatibility", async () => {
  const f = await fixture();
  await expect(f.sync.preview("workspace", all, "old")).rejects.toThrow("Connection identity changed");
  await expect(f.sync.preview("missing", all)).rejects.toThrow("Multica workspace unavailable");
  f.remote.authFailure = true;
  await expect(f.sync.preview("workspace", all)).rejects.toThrow("HTTP 401");
  f.remote.authFailure = false;
  await f.sync.preview("workspace", all);
  f.remote.mismatch = true;
  await expect(f.sync.preview("workspace", all)).rejects.toThrow("Issue belongs to a different workspace");
  f.remote.mismatch = false; f.remote.partial = true;
  await expect(f.sync.preview("workspace", all)).rejects.toThrow("Incomplete issue pagination");
  f.remote.partial = false;
  f.remote.before = async url => { if (url.pathname === "/api/issues") f.remote.changedIdentity = true; };
  await expect(f.sync.preview("workspace", all)).rejects.toThrow("Connection identity changed");
});
