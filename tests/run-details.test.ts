import { mkdtemp, mkdir, readFile, readdir, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { expect, it, vi } from "vitest";
import { StateStore, connectionState, issueSchema } from "../server/state.js";
import { RunDetails } from "../server/run-details.js";
import type { RunMessage } from "../shared/runs.js";

it("writes only the changed Run atomically, loads only owned details and replays them offline after restart", async () => {
  const directory = await mkdtemp(join(tmpdir(), "multica-details-"));
  const store = new StateStore(directory);
  const address = { connectionKey: "connection/../one", issueId: "issue", rootId: "main" };
  const messages: RunMessage[] = [{ task_id: "run", issue_id: "issue", seq: 1, type: "text", content: "First" }];
  const fetch = vi.fn(async () => new Response(JSON.stringify(messages)));
  vi.stubGlobal("fetch", fetch);
  const connection = vi.fn(async () => ({ apiUrl: "https://multica.test", token: "secret", userId: "user", connectionKey: address.connectionKey }));
  let details = new RunDetails(store, connection);
  try {
    await store.update(state => {
      const local = connectionState(state, address.connectionKey);
      local.projects.workspace = { cwd: directory, name: "Workspace", slug: "workspace" };
      local.issues.issue = issueSchema.parse({ remoteWorkspaceId: "workspace", workspaceId: "native", cwd: directory, title: "Issue", description: "",
        runs: { run: { agentId: "agent", agentName: "Agent", status: "running", ownerRootId: "main", coalescedCommentIds: [], supplementCommentIds: [] } } });
    });
    const stateBefore = await readFile(join(directory, "state.json"), "utf8");
    const subscriber = vi.fn(); store.subscribe(subscriber);
    await details.openDiscussion(address); await details.refreshOpened();
    const files = await readdir(store.runDetailsDirectory(address.connectionKey));
    expect(files).toHaveLength(1);
    expect(files[0]).toMatch(/^[a-f0-9]{64}\.json$/);
    const file = join(store.runDetailsDirectory(address.connectionKey), files[0]);
    expect(JSON.parse(await readFile(file, "utf8"))).toEqual({ messages });
    const first = await stat(file);
    await details.refreshOpened();
    expect((await stat(file)).mtimeMs).toBe(first.mtimeMs);
    // A failed atomic write retains the last durable and in-memory snapshot.
    await mkdir(file + ".next");
    messages.push({ ...messages[0], seq: 2, content: "Second" });
    await details.refreshOpened();
    expect(details.get(address, "run")?.messages).toHaveLength(1);
    expect(JSON.parse(await readFile(file, "utf8")).messages).toHaveLength(1);
    await rm(file + ".next", { recursive: true });
    await details.refreshOpened();
    expect(details.get(address, "run")?.messages).toHaveLength(2);
    expect(await readFile(join(directory, "state.json"), "utf8")).toBe(stateBefore);
    expect(subscriber).not.toHaveBeenCalled();
    expect(stateBefore).not.toContain("runDetails");
    await details.close();
    connection.mockRejectedValue(new Error("offline"));
    details = new RunDetails(new StateStore(directory), connection);
    expect(details.get(address, "run")).toBeUndefined();
    await details.openDiscussion({ ...address, rootId: "unopened" });
    await details.refreshOpened();
    expect(details.get(address, "run")).toBeUndefined();
    const before = fetch.mock.calls.length;
    await details.openDiscussion(address); await details.refreshOpened();
    expect(details.get(address, "run")?.messages).toEqual(messages);
    expect(details.get({ ...address, connectionKey: "other" }, "run")).toBeUndefined();
    expect(fetch).toHaveBeenCalledTimes(before);
    details.resume(address.connectionKey);
    expect(details.get(address, "run")).toBeUndefined();
  } finally { await details.close(); vi.unstubAllGlobals(); await rm(directory, { recursive: true, force: true }); }
});

it.each(["cleared", "paused"])("does not write in-flight Run details after local state is %s", async change => {
  const directory = await mkdtemp(join(tmpdir(), "multica-details-race-"));
  const store = new StateStore(directory);
  const address = { connectionKey: "connection", issueId: "issue", rootId: "main" };
  let release!: () => void, started!: () => void;
  const response = new Promise<void>(resolve => { release = resolve; });
  const requested = new Promise<void>(resolve => { started = resolve; });
  vi.stubGlobal("fetch", vi.fn(async () => {
    started(); await response;
    return Response.json([{ task_id: "run", issue_id: "issue", seq: 1, type: "text", content: "Late output" }]);
  }));
  const details = new RunDetails(store, async () => ({ apiUrl: "https://multica.test", token: "secret", userId: "user", connectionKey: address.connectionKey }));
  try {
    await store.update(state => {
      const local = connectionState(state, address.connectionKey);
      local.projects.workspace = { cwd: directory, name: "Workspace", slug: "workspace" };
      local.issues.issue = issueSchema.parse({ remoteWorkspaceId: "workspace", workspaceId: "native", cwd: directory, title: "Issue", description: "",
        runs: { run: { agentId: "agent", agentName: "Agent", status: "running", ownerRootId: "main", coalescedCommentIds: [], supplementCommentIds: [] } } });
    });
    await details.openDiscussion(address);
    await requested;
    const refreshing = details.refreshOpened();
    let paused: Promise<void> | undefined;
    if (change === "cleared") {
      await store.update(state => { state.connections = {}; });
      await store.removeRunDetails(address.connectionKey);
    } else paused = details.pause();
    release();
    await refreshing; await paused;
    await expect(stat(store.runDetailsDirectory(address.connectionKey))).rejects.toMatchObject({ code: "ENOENT" });
    expect(details.get(address, "run")).toBeUndefined();
  } finally { release(); await details.close(); vi.unstubAllGlobals(); await rm(directory, { recursive: true, force: true }); }
});
