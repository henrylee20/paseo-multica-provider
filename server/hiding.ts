import type { PluginHookAgent } from "@getpaseo/plugin/server";
import { StateStore, type IssueMapping } from "./state.js";
import { ensureWorkspaceActive, type NativeHost } from "./native-host.js";
import { assertWritableIssue } from "./access.js";

export function discussionAgent(issue: IssueMapping, rootId: string) {
  return rootId === "main" ? issue.mainAgentId : issue.threads[rootId]?.agentId;
}
export function hiddenAgent(issue: IssueMapping, agentId: string) {
  return issue.manualHidden.discussions.some(rootId => discussionAgent(issue, rootId) === agentId);
}

/** Native hooks carry no bulk-archive cause. Preserve every explicit tab hide;
 * a workspace restore therefore leaves its discussions available for separate restore. */
export class ManualHiding {
  constructor(private readonly store: StateStore) {}
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
    if (issue.archiveReason) throw new Error("任务目前已退出筛选范围；请先启用并调整工作区规则，再恢复隐藏对象。");
    const agentId = input.rootId === undefined ? undefined : discussionAgent(issue, input.rootId);
    if (input.rootId !== undefined && !agentId) throw new Error("Mapped discussion unavailable");
    // Native workspace restoration does not restore its agents. Keep the original
    // identities, cwd and history; refresh only a confirmed archived selected agent.
    await ensureWorkspaceActive(host, issue.workspaceId);
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
