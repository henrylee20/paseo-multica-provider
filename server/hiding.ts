import type { PluginHookAgent } from "@getpaseo/plugin/server";
import { StateStore, type IssueMapping } from "./state.js";
import { archiveClosedDiscussion, ensureWorkspaceActive, type NativeHost } from "./native-host.js";
import { assertWritableIssue } from "./access.js";
import type { DiscussionLifecycle } from "./discussion-lifecycle.js";

export function discussionAgent(issue: IssueMapping, rootId: string) {
  return rootId === "main" ? issue.mainAgentId : issue.threads[rootId]?.agentId;
}
export function hiddenAgent(issue: IssueMapping, agentId: string) {
  return issue.manualHidden.discussions.some(rootId => discussionAgent(issue, rootId) === agentId);
}

/** Host workspace restore may also revive archived children, including legacy
 * timestamp matches. Only an explicitly selected discussion may leave hiding. */
export async function restoreWorkspacePreservingHidden(host: NativeHost, lifecycle: DiscussionLifecycle, issue: IssueMapping,
  address: { connectionKey: string; issueId: string }, selectedRootId?: string) {
  const roots = issue.manualHidden.discussions.filter(rootId => rootId !== selectedRootId);
  const release = await lifecycle.hold(roots.map(rootId => ({ ...address, rootId })));
  try {
    await ensureWorkspaceActive(host, issue.workspaceId);
  } finally {
    // Restoration may have succeeded despite a lost acknowledgement. Repair
    // hidden children before releasing the guard even when the request failed.
    try {
      for (const rootId of roots) {
        const agentId = discussionAgent(issue, rootId);
        if (agentId) await archiveClosedDiscussion(host, agentId, issue);
      }
    } finally { release(); }
  }
}

/** Native hooks carry no bulk-archive cause. Preserve every explicit tab hide;
 * a workspace restore therefore leaves its discussions available for separate restore. */
export class ManualHiding {
  constructor(private readonly store: StateStore, private readonly lifecycle: DiscussionLifecycle) {}
  async archivedAgent(agent: PluginHookAgent) {
    if (agent.provider !== "multica") return;
    await this.store.update(state => {
      for (const connection of Object.values(state.connections)) for (const issue of Object.values(connection.issues)) {
        if (issue.workspaceId !== agent.workspaceId || issue.archiveReason) continue;
        const rootId = issue.mainAgentId === agent.id ? "main" : Object.entries(issue.threads).find(([, thread]) => thread.agentId === agent.id)?.[0];
        if (rootId && !issue.manualHidden.discussions.includes(rootId)) issue.manualHidden.discussions.push(rootId);
      }
    });
  }
  async archivedWorkspace(workspaceId: string) {
    await this.store.update(state => {
      for (const connection of Object.values(state.connections)) for (const issue of Object.values(connection.issues)) {
        if (issue.workspaceId === workspaceId && !issue.archiveReason) issue.manualHidden.workspace = true;
      }
    });
  }
  async list() {
    const state = await this.store.read();
    return { objects: Object.entries(state.connections).flatMap(([connectionKey, connection]) => Object.entries(connection.issues).flatMap(([issueId, issue]) => {
      const address = { connectionKey, issueId, workspaceId: issue.workspaceId, cwd: issue.cwd };
      return [
        ...(issue.manualHidden.workspace ? [{ ...address, kind: "workspace" as const, title: issue.title }] : []),
        ...issue.manualHidden.discussions.map(rootId => ({ ...address, kind: rootId === "main" ? "main" as const : "thread" as const,
          rootId, agentId: discussionAgent(issue, rootId), title: `${issue.title} · ${rootId === "main" ? "主讨论" : issue.threads[rootId]?.title ?? "Thread"}` })),
      ];
    })) };
  }
  async restore(input: { connectionKey: string; issueId: string; rootId?: string }, host: NativeHost) {
    const issue = (await this.store.read()).connections[input.connectionKey]?.issues[input.issueId];
    if (!issue?.workspaceCreated) throw new Error("Mapped workspace unavailable");
    assertWritableIssue(issue);
    if (issue.archiveReason) throw new Error("任务目前已退出筛选范围；请先启用并调整 Multica 工作区规则，再恢复隐藏对象。");
    const agentId = input.rootId === undefined ? undefined : discussionAgent(issue, input.rootId);
    if (input.rootId !== undefined && !agentId) throw new Error("Mapped discussion unavailable");
    await restoreWorkspacePreservingHidden(host, this.lifecycle, issue, input, input.rootId);
    if (agentId) {
      const existing = await host.fetchAgent(agentId);
      if (!existing?.agent || existing.agent.workspaceId !== issue.workspaceId || existing.agent.cwd !== issue.cwd) throw new Error("Mapped native discussion unavailable");
      if (existing.agent.archivedAt) await host.refreshAgent(agentId);
    }
    await this.store.update(state => {
      const saved = state.connections[input.connectionKey].issues[input.issueId];
      saved.manualHidden.workspace = false;
      if (input.rootId !== undefined) saved.manualHidden.discussions = saved.manualHidden.discussions.filter(rootId => rootId !== input.rootId);
    });
  }
}
