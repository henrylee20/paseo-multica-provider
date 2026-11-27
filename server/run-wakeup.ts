import { isActiveRun } from "../shared/runs.js";
import { discussionKeys } from "../shared/discussion.js";
import type { AuthenticatedConnection } from "./connection.js";
import { providerId } from "./discussion-identity.js";
import type { DiscussionLifecycle } from "./discussion-lifecycle.js";
import { findActiveWorkspace, type NativeHost } from "./native-host.js";
import type { RunAddress } from "./runs.js";
import type { StateStore } from "./state.js";

/** Reopen unloaded Run owners without interrupting their remote execution. */
export class RunWakeups {
  private readonly pending = new Map<string, Promise<void>>();
  private readonly attemptedAt = new Map<string, number>();
  private readonly settled = new Set<string>();
  constructor(private readonly store: StateStore, private readonly lifecycle: DiscussionLifecycle,
    private readonly now: () => Date = () => new Date()) {}

  async reset() { await Promise.allSettled(this.pending.values()); this.attemptedAt.clear(); this.settled.clear(); }

  async discover(connection: AuthenticatedConnection, issueId: string, host: NativeHost, settledRoots: Iterable<string> = []) {
    const issue = (await this.store.read()).connections[connection.connectionKey]?.issues[issueId];
    const roots = new Set(["main", ...Object.keys(issue?.threads ?? {})]);
    for (const rootId of settledRoots) this.settled.add(JSON.stringify([connection.connectionKey, issueId, rootId]));
    for (const rootId of roots) {
      const address = { connectionKey: connection.connectionKey, issueId, rootId };
      const key = JSON.stringify([address.connectionKey, issueId, rootId]);
      const existing = this.pending.get(key);
      if (existing) { await existing; continue; }
      const operation = this.load(connection, address, host, key).catch(() => {});
      this.pending.set(key, operation);
      try { await operation; } finally { this.pending.delete(key); }
    }
  }

  private async eligible(address: RunAddress, key: string) {
    const local = (await this.store.read()).connections[address.connectionKey], issue = local?.issues[address.issueId];
    if (!issue?.workspaceCreated || !local.rules[issue.remoteWorkspaceId]?.enabled || issue.archiveReason ||
      issue.manualHidden.workspace || issue.manualHidden.discussions.includes(address.rootId) || this.lifecycle.unavailable(address)) return;
    const agentId = address.rootId === "main" ? issue.mainAgentId : issue.threads[address.rootId]?.agentId;
    if (!agentId || !this.settled.has(key) && !Object.values(issue.runs).some(run => run.ownerRootId === address.rootId && isActiveRun(run.status))) return;
    return { issue, agentId };
  }

  private async load(connection: AuthenticatedConnection, address: RunAddress, host: NativeHost, key: string) {
    const candidate = await this.eligible(address, key);
    if (!candidate) return;
    if (this.lifecycle.loaded(address)) { this.settled.delete(key); return; }
    if (this.now().getTime() - (this.attemptedAt.get(key) ?? -Infinity) < 60_000) return;
    const native = (await host.fetchAgent(candidate.agentId))?.agent;
    if (!native || native.archivedAt || native.provider !== providerId || native.workspaceId !== candidate.issue.workspaceId || native.cwd !== candidate.issue.cwd ||
      native.labels[discussionKeys.connection] !== address.connectionKey || native.labels[discussionKeys.issue] !== address.issueId || native.labels[discussionKeys.discussion] !== address.rootId) return;
    if (!await findActiveWorkspace(host, candidate.issue.workspaceId)) return;
    await connection.assertCurrent?.();
    const current = await this.eligible(address, key);
    if (!current || current.agentId !== candidate.agentId || current.issue.workspaceId !== candidate.issue.workspaceId || current.issue.cwd !== candidate.issue.cwd) return;
    this.attemptedAt.set(key, this.now().getTime());
    const result = await host.listCommands(candidate.agentId);
    if (result?.error) throw new Error(result.error);
    this.settled.delete(key);
  }
}
