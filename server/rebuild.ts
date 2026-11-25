import { join, sep } from "node:path";
import type { PaseoApi } from "@getpaseo/client";
import { discussionKeys } from "../shared/discussion.js";
import { isActiveRun } from "../shared/runs.js";
import type { RebuildBlocker, RebuildProgress } from "../shared/rebuild.js";
import type { AuthenticatedConnection } from "./connection.js";
import type { DiscussionLifecycle } from "./discussion-lifecycle.js";
import type { NativeHost } from "./native-host.js";
import type { RunDetails } from "./run-details.js";
import { StateStore, connectionState } from "./state.js";
import type { SidebarSynchronizer } from "./sync.js";

async function directory<T>(page: (cursor?: string) => Promise<{ entries: T[]; pageInfo: { hasMore: boolean; nextCursor?: string | null } }>): Promise<T[]> {
  const entries: T[] = [], seen = new Set<string>();
  let cursor: string | undefined;
  for (;;) {
    const result = await page(cursor); entries.push(...result.entries);
    if (!result.pageInfo.hasMore) return entries;
    const next = result.pageInfo.nextCursor;
    if (!next || seen.has(next)) throw new Error("Incomplete native directory pagination");
    seen.add(next); cursor = next;
  }
}
const idle = (): RebuildProgress => ({ status: "idle", stage: "deleting", step: "", completed: 0, total: 0 });

/** In-memory daemon job. A failed attempt is retried by rediscovering everything. */
export class DataRebuild {
  private readonly progress = new Map<string, RebuildProgress>();
  private operation?: Promise<void>;
  constructor(private readonly store: StateStore, private readonly connection: () => Promise<AuthenticatedConnection>,
    private readonly sync: SidebarSynchronizer, private readonly lifecycle: DiscussionLifecycle, private readonly details: RunDetails) {}
  status(connectionKey: string) { return { ...this.progress.get(connectionKey) ?? idle() }; }
  private async current(connectionKey: string) {
    await this.sync.assertNoPurge();
    const connection = await this.connection();
    if (connection.connectionKey !== connectionKey) throw new Error("连接已变化，请刷新设置页。");
    return connection;
  }
  async blockers(connectionKey: string): Promise<RebuildBlocker[]> {
    const local = (await this.store.read()).connections[connectionKey];
    return Object.entries(local?.issues ?? {}).flatMap(([issueId, issue]) => {
      const groups = new Map<string, RebuildBlocker>();
      for (const [runId, run] of Object.entries(issue.runs)) {
        if (!isActiveRun(run.status)) continue;
        const rootId = run.ownerRootId ?? "unresolved";
        const group = groups.get(rootId) ?? { issueId, title: issue.title, rootId, discussion: rootId === "main" ? "主讨论" : issue.threads[rootId]?.title ?? "归属待确定", runs: [] };
        group.runs.push({ runId, agentName: run.agentName, status: run.status }); groups.set(rootId, group);
      }
      return [...groups.values()];
    });
  }
  private async discover(host: NativeHost, connectionKey: string) {
    const local = (await this.store.read()).connections[connectionKey];
    const agents = (await directory(cursor => host.fetchAgents({ filter: { includeArchived: true, includeBackground: true, includeInternal: true, labels: { [discussionKeys.connection]: connectionKey } }, page: { limit: 100, cursor } })))
      .map(entry => entry.agent).filter(agent => agent.provider === "multica" && agent.labels[discussionKeys.connection] === connectionKey && agent.labels[discussionKeys.issue] && agent.labels[discussionKeys.discussion]);
    const active = await directory(cursor => host.fetchWorkspaces({ filter: { includeBackground: true, includeInternal: true }, page: { limit: 100, cursor } }));
    const knownWorkspaceIds = new Set(agents.flatMap(agent => agent.workspaceId ? [agent.workspaceId] : []));
    for (const issue of Object.values(local?.issues ?? {})) knownWorkspaceIds.add(issue.workspaceId);
    const prefix = join(this.store.directory, "placeholders", connectionKey.slice(0, 20)) + sep;
    const workspaceIds = new Set(active.filter(workspace => knownWorkspaceIds.has(workspace.id) || workspace.workspaceDirectory?.startsWith(prefix)).map(workspace => workspace.id));
    const projects = (await host.listProjects()).projects.filter(project => project.projectKind === "non_git" &&
      (project.projectRootPath.startsWith(prefix) || Object.values(local?.projects ?? {}).some(cached => cached.projectId === project.projectId && cached.cwd === project.projectRootPath)))
      .filter(project => !active.some(workspace => workspace.projectId === project.projectId && !workspaceIds.has(workspace.id)));
    return { agents, workspaceIds, projects };
  }
  async preflight(connectionKey: string, paseo: PaseoApi) {
    await this.current(connectionKey);
    let counts = { projects: 0, workspaces: 0, discussions: 0 };
    await this.sync.withNativeHost(paseo, async host => {
      const found = await this.discover(host, connectionKey);
      counts = { projects: found.projects.length, workspaces: found.workspaceIds.size, discussions: found.agents.length };
    });
    return { ...counts, blockers: await this.blockers(connectionKey) };
  }
  async start(connectionKey: string, paseo: PaseoApi) {
    await this.current(connectionKey);
    if (this.operation) throw new Error("数据重建正在进行。");
    const blockers = await this.blockers(connectionKey);
    if (blockers.length) return { started: false, blockers, progress: this.status(connectionKey) };
    if (this.operation) throw new Error("数据重建正在进行。");
    const progress: RebuildProgress = { ...idle(), status: "running", step: "等待后台同步" };
    this.progress.set(connectionKey, progress);
    this.operation = this.sync.exclusive(paseo, async host => {
      let release: (() => void) | undefined;
      try {
        await this.current(connectionKey);
        const blocking = await this.blockers(connectionKey);
        if (blocking.length) throw new Error(`存在活跃 Run，请等待结束或先手动 Stop：${blocking.map(group => `${group.title} · ${group.discussion}: ${group.runs.map(run => run.runId).join(", ")}`).join("；")}`);
        await this.details.pause();
        progress.step = "发现插件记录";
        const found = await this.discover(host, connectionKey);
        release = await this.lifecycle.hold(found.agents.map(agent => ({ connectionKey, issueId: agent.labels[discussionKeys.issue], rootId: agent.labels[discussionKeys.discussion] })));
        progress.step = "删除插件讨论";
        for (const agent of found.agents) await host.deleteAgent(agent.id);
        progress.step = "归档 Paseo 工作区";
        for (const workspaceId of found.workspaceIds) {
          const result = await host.archiveWorkspace(workspaceId);
          if (result.error) throw new Error(result.error);
        }
        progress.step = "删除 Paseo 项目";
        for (const project of found.projects) {
          // Recheck after archive: a user may have created a workspace meanwhile.
          const active = await directory(cursor => host.fetchWorkspaces({ filter: { includeBackground: true, includeInternal: true }, page: { limit: 100, cursor } }));
          if (!active.some(workspace => workspace.projectId === project.projectId)) await host.removeProject(project.projectId);
        }
        progress.step = "清空本地状态";
        await this.store.update(state => {
          const local = connectionState(state, connectionKey);
          state.connections[connectionKey] = { rules: local.rules, rebuildGeneration: (local.rebuildGeneration ?? 0) + 1, projects: {}, issues: {} };
        });
        release(); release = undefined;
        this.details.resume(connectionKey);
        progress.stage = "importing"; progress.step = "按筛选规则导入";
        await this.sync.reimport(connectionKey, (completed, total) => { progress.completed = completed; progress.total = total; });
        progress.status = "completed"; progress.message = `重建完成，已导入 ${progress.completed} 个任务。`;
      } finally { release?.(); this.details.resume(); }
    }).catch(error => { progress.status = "failed"; progress.message = `${progress.step}失败：${error instanceof Error ? error.message : String(error)}`; })
      .finally(() => { this.operation = undefined; });
    return { started: true, blockers: [], progress: this.status(connectionKey) };
  }
  async close() { await this.operation; }
}
