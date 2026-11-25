import type { AskUsers } from "./askuser.js";
import type { AuthenticatedConnection } from "./connection.js";
import type { DiscussionLifecycle } from "./discussion-lifecycle.js";
import { discussionKeys } from "../shared/discussion.js";
import { findActiveWorkspace, type NativeHost } from "./native-host.js";
import type { RunAddress } from "./runs.js";
import { StateStore } from "./state.js";

/** Load pending questions through the host's non-interrupting interactive path.
 * The host restores opening permissions before ready; it owns attention policy. */
export class AskuserWakeups {
  private readonly pending = new Map<string, Promise<void>>();
  private readonly attemptedAt = new Map<string, number>();
  constructor(private readonly store: StateStore, private readonly askusers: AskUsers,
    private readonly lifecycle: DiscussionLifecycle, private readonly now: () => Date = () => new Date()) {}

  async discover(connection: AuthenticatedConnection, issueId: string, host: NativeHost) {
    const issue = (await this.store.read()).connections[connection.connectionKey]?.issues[issueId];
    for (const rootId of Object.keys(issue?.threads ?? {})) {
      // Each native request is independent: a failed discussion cannot prevent
      // another discussion or the next Issue from synchronizing.
      await this.wake(connection, { connectionKey: connection.connectionKey, issueId, rootId }, host).catch(() => {});
    }
  }

  reopen(connection: AuthenticatedConnection, address: RunAddress, host: NativeHost) {
    return this.wake(connection, address, host, true);
  }

  private wake(connection: AuthenticatedConnection, address: RunAddress, host: NativeHost, explicit = false) {
    const key = JSON.stringify([address.connectionKey, address.issueId, address.rootId]);
    const existing = this.pending.get(key);
    if (existing) return existing;
    const operation = this.load(connection, address, host, key, explicit);
    this.pending.set(key, operation);
    void operation.finally(() => { if (this.pending.get(key) === operation) this.pending.delete(key); }).catch(() => {});
    return operation;
  }

  private async eligible(address: RunAddress) {
    if (this.lifecycle.unavailable(address) || this.lifecycle.loaded(address)) return;
    const local = (await this.store.read()).connections[address.connectionKey];
    const issue = local?.issues[address.issueId];
    if (!issue?.workspaceCreated || !local.rules[issue.remoteWorkspaceId]?.enabled || issue.access?.status === "inaccessible" ||
      issue.archiveReason || issue.archivePending || issue.manualHidden.workspace || issue.manualHidden.discussions.includes(address.rootId)) return;
    const agentId = issue.threads[address.rootId]?.agentId;
    if (!agentId || !(await this.askusers.cards(address)).some(card => card.status === "pending" && !card.readOnly && !card.collapsed && !card.statusError)) return;
    return { issue, agentId };
  }

  private async load(connection: AuthenticatedConnection, address: RunAddress, host: NativeHost, key: string, explicit: boolean) {
    const candidate = await this.eligible(address);
    if (!candidate) return;
    const now = this.now().getTime();
    if (!explicit && now - (this.attemptedAt.get(key) ?? -Infinity) < 60_000) return;
    const native = (await host.fetchAgent(candidate.agentId))?.agent;
    if (!native || native.archivedAt || native.provider !== "multica" || native.workspaceId !== candidate.issue.workspaceId || native.cwd !== candidate.issue.cwd ||
      native.labels[discussionKeys.connection] !== address.connectionKey || native.labels[discussionKeys.issue] !== address.issueId || native.labels[discussionKeys.discussion] !== address.rootId) return;
    if (!await findActiveWorkspace(host, candidate.issue.workspaceId)) return;
    await connection.assertCurrent?.();
    if (!await this.eligible(address)) return;
    this.attemptedAt.set(key, this.now().getTime());
    // Unlike refreshAgent, listCommands reuses an existing runtime, including
    // an active Run, and opens an unloaded session with no history-only purpose.
    await host.listCommands(candidate.agentId);
  }
}
