import type { PaseoApi } from "@getpaseo/client";
import { discussionKeys } from "../shared/discussion.js";
import type { StateStore } from "./state.js";
import { directoryEntries } from "./native-host.js";

/** Backfills existing discussions once and writes metadata for individual imports. */
export class DiscussionMetadata {
  private unsupported = false;
  private closed = false;
  private pending?: Promise<void>;
  private paseo?: PaseoApi;
  constructor(private readonly store: StateStore) {}

  /** Best effort: a client bootstrap neither waits for a copy nor fails because of one. */
  mirror(paseo: PaseoApi): Promise<void> {
    if (this.closed || this.unsupported) return Promise.resolve();
    this.paseo ??= paseo;
    this.pending ??= this.sweep(paseo).catch(() => { this.pending = undefined; });
    return this.pending;
  }
  close(): Promise<void> { this.closed = true; return this.pending ?? Promise.resolve(); }

  async write(agentId: string, connectionKey: string, issueId: string) {
    if (this.closed || this.unsupported || !this.paseo) return;
    const handle = this.paseo.agents.ref(agentId) as unknown as { setMetadata?: (patch: Record<string, string>) => Promise<unknown> };
    if (typeof handle.setMetadata !== "function") { this.unsupported = true; return; }
    await handle.setMetadata({ [discussionKeys.connection]: connectionKey, [discussionKeys.issue]: issueId }).catch(() => {});
  }
  private async sweep(paseo: PaseoApi) {
    for (const connectionKey of Object.keys((await this.store.read()).connections)) {
      for await (const { agent } of directoryEntries(cursor => paseo.agents.list({ filter: { labels: { [discussionKeys.connection]: connectionKey }, includeArchived: true }, page: { limit: 100, cursor } }), "agent")) {
        const issueId = agent.labels[discussionKeys.issue];
        if (!issueId) continue;
        await this.write(agent.id, connectionKey, issueId);
      }
    }
  }
}
