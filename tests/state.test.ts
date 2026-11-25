import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { StateStore, connectionState, type LocalState } from "../server/state.js";

it("shares the first validated state in memory and persists queued updates across restart", async () => {
  const directory = await mkdtemp(join(tmpdir(), "multica-state-"));
  try {
    await writeFile(join(directory, "state.json"), JSON.stringify({ version: 1, connections: {}, token: "excluded" }));
    const store = new StateStore(directory);
    const [first, second] = await Promise.all([store.read(), store.read()]);
    expect(first).toBe(second);
    expect(first).toEqual({ version: 1, connections: {} });
    await writeFile(join(directory, "state.json"), "invalid external state");
    expect(await store.read()).toBe(first);
    await Promise.all(["one", "two"].map(key => store.update(state => { connectionState(state, key); })));
    const saved = await store.read();
    expect(Object.keys(saved.connections)).toEqual(["one", "two"]);
    expect(first.connections).toEqual({});
    expect(await new StateStore(directory).read()).toEqual(saved);
    expect(await readFile(join(directory, "state.json"), "utf8")).not.toContain("excluded");
  } finally { await rm(directory, { recursive: true, force: true }); }
});

it.each(["change", "write"])("a failed %s leaves the cached and durable state intact and allows a later update", async failure => {
  const directory = await mkdtemp(join(tmpdir(), "multica-state-"));
  try {
    const store = new StateStore(directory);
    await store.update(state => { connectionState(state, "original"); });
    const before = await store.read();
    const notifications: LocalState[] = [];
    const unsubscribe = store.subscribe(state => { notifications.push(state); });
    if (failure === "write") await mkdir(join(directory, "state.json.next"));
    await expect(store.update(state => {
      connectionState(state, "rejected");
      if (failure === "change") throw new Error("rejected change");
    })).rejects.toThrow();
    expect(await store.read()).toBe(before);
    expect(notifications).toEqual([]);
    expect(await new StateStore(directory).read()).toEqual(before);
    if (failure === "write") await rm(join(directory, "state.json.next"), { recursive: true });
    await store.update(state => { connectionState(state, "accepted"); });
    expect(Object.keys((await store.read()).connections)).toEqual(["original", "accepted"]);
    expect(notifications).toEqual([await store.read()]);
    expect(notifications[0]).toBe(await store.read());
    unsubscribe();
  } finally { await rm(directory, { recursive: true, force: true }); }
});

it("retries a failed initial load after the underlying file is repaired", async () => {
  const directory = await mkdtemp(join(tmpdir(), "multica-state-"));
  try {
    await writeFile(join(directory, "state.json"), "invalid state");
    const store = new StateStore(directory);
    await expect(store.read()).rejects.toThrow();
    await expect(store.update(() => {})).rejects.toThrow();
    await writeFile(join(directory, "state.json"), JSON.stringify({ version: 1, connections: {} }));
    await store.update(state => { connectionState(state, "recovered"); });
    expect(Object.keys((await store.read()).connections)).toEqual(["recovered"]);
  } finally { await rm(directory, { recursive: true, force: true }); }
});
