import type { RunAddress } from "./runs.js";

const key = (address: RunAddress) => JSON.stringify([address.connectionKey, address.issueId, address.rootId]);

/** A local resource boundary, independent of remote execution and Stop. */
export class DiscussionLifecycle {
  private readonly held = new Map<string, number>();
  private readonly sessions = new Map<string, Set<() => void | Promise<void>>>();
  unavailable(address: RunAddress) { return this.held.has(key(address)); }
  subscribe(address: RunAddress, close: () => void | Promise<void>) {
    const id = key(address);
    const sessions = this.sessions.get(id) ?? new Set();
    sessions.add(close); this.sessions.set(id, sessions);
    return () => { sessions.delete(close); if (!sessions.size) this.sessions.delete(id); };
  }
  async hold(addresses: RunAddress[]) {
    const ids = [...new Set(addresses.map(key))];
    for (const id of ids) this.held.set(id, (this.held.get(id) ?? 0) + 1);
    const release = () => {
      for (const id of ids) {
        const remaining = (this.held.get(id) ?? 1) - 1;
        if (remaining) this.held.set(id, remaining); else this.held.delete(id);
      }
    };
    try {
      for (const id of ids) await Promise.all([...(this.sessions.get(id) ?? [])].map(close => close()));
    } catch (error) { release(); throw error; }
    return release;
  }
}
