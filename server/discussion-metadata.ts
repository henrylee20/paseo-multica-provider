import type { PaseoApi } from "@getpaseo/client";
import { discussionKeys } from "../shared/discussion.js";
import type { StateStore } from "./state.js";

/** The agent directory entry and handle members Paseo 0.16 added. Development types stop at SDK 0.15.4. */
interface MetadataAgent {
  id: string;
  labels: Record<string, string>;
  metadata?: Record<string, unknown>;
}
interface MetadataHandle {
  setMetadata(patch: Record<string, string>): Promise<unknown>;
}

/**
 * Copies each discussion's Multica task from its labels into agent metadata. A composer exposes
 * metadata but neither labels nor the agent ID, so the composer's agent picker reads the task there.
 */
export class DiscussionMetadata {
  private unsupported = false;
  private closed = false;
  private pending?: Promise<void>;
  constructor(private readonly store: StateStore) {}

  /** Best effort: a client bootstrap neither waits for a copy nor fails because of one. */
  mirror(paseo: PaseoApi): Promise<void> {
    if (this.closed || this.unsupported) return Promise.resolve();
    this.pending ??= this.sweep(paseo).catch(() => {}).finally(() => { this.pending = undefined; });
    return this.pending;
  }
  close(): Promise<void> { this.closed = true; return this.pending ?? Promise.resolve(); }

  private async sweep(paseo: PaseoApi) {
    for (const connectionKey of Object.keys((await this.store.read()).connections)) {
      let cursor: string | undefined;
      const cursors = new Set<string>();
      for (;;) {
        const page = await paseo.agents.list({ filter: { labels: { [discussionKeys.connection]: connectionKey }, includeArchived: true }, page: { limit: 100, cursor } });
        for (const { agent } of page.entries as { agent: MetadataAgent }[]) {
          const issueId = agent.labels[discussionKeys.issue];
          if (!issueId) continue;
          const metadata = agent.metadata ?? {};
          if (metadata[discussionKeys.connection] === connectionKey && metadata[discussionKeys.issue] === issueId) continue;
          const handle = paseo.agents.ref(agent.id) as unknown as Partial<MetadataHandle>;
          if (typeof handle.setMetadata !== "function") { this.unsupported = true; return; }
          await handle.setMetadata({ [discussionKeys.connection]: connectionKey, [discussionKeys.issue]: issueId });
        }
        if (!page.pageInfo.hasMore) break;
        const next = page.pageInfo.nextCursor;
        if (!next || cursors.has(next)) throw new Error("Incomplete native agent pagination");
        cursors.add(next); cursor = next;
      }
    }
  }
}
