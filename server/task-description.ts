import type { StateStore } from "./state.js";
import { createHash } from "node:crypto";

export function descriptionRevision(description: string): string {
  return createHash("sha256").update(description).digest("hex");
}

// A UTF-16 unit needs at most six JSON bytes. These bounds leave ample room
// below the host's 64 KiB plugin data limit, including escaped control text.
export function descriptionSlice(description: string, offset: number, length: number): string {
  let end = Math.min(description.length, offset + length);
  if (end < description.length && /[\uD800-\uDBFF]/.test(description[end - 1])) end--;
  return description.slice(offset, end);
}

export function taskDescriptionData(connectionKey: string, issueId: string, description: string) {
  const preview = descriptionSlice(description, 0, 4096);
  return { connectionKey, issueId, revision: descriptionRevision(description), preview, truncated: preview.length < description.length };
}

/** Cached observation is independent of the current CLI connection. */
export class TaskDescriptions {
  private readonly listeners = new Map<string, Set<(data: ReturnType<typeof taskDescriptionData>) => void>>();
  constructor(private readonly store: StateStore) {}
  subscribe(connectionKey: string, issueId: string, listener: (data: ReturnType<typeof taskDescriptionData>) => void) {
    const key = JSON.stringify([connectionKey, issueId]);
    const listeners = this.listeners.get(key) ?? new Set();
    listeners.add(listener); this.listeners.set(key, listeners);
    return () => { listeners.delete(listener); if (!listeners.size) this.listeners.delete(key); };
  }
  async observe({ connectionKey, issueId }: { connectionKey: string; issueId: string }) {
    const issue = (await this.store.read()).connections[connectionKey]?.issues[issueId];
    if (!issue) throw new Error("Task description unavailable");
    const data = taskDescriptionData(connectionKey, issueId, issue.description);
    for (const listener of this.listeners.get(JSON.stringify([connectionKey, issueId])) ?? []) listener(data);
    return data;
  }
  close() { this.listeners.clear(); }
}
