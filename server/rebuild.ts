import { join, resolve, sep } from "node:path";
import type { PaseoApi } from "@getpaseo/client";
import { discussionKeys } from "../shared/discussion.js";
import { isActiveRun } from "../shared/runs.js";
import type { RebuildBlocker, RebuildProgress } from "../shared/rebuild.js";
import type { AuthenticatedConnection } from "./connection.js";
import { providerId } from "./discussion-identity.js";
import type { DiscussionLifecycle } from "./discussion-lifecycle.js";
import type { NativeHost } from "./native-host.js";
import type { RunDetails } from "./run-details.js";
import type { RunSynchronizer } from "./runs.js";
import { StateStore, connectionState } from "./state.js";
import type { SidebarSynchronizer } from "./sync.js";
import { workspaces as readWorkspaces, type RemoteWorkspace } from "./multica-api.js";

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
    private readonly sync: SidebarSynchronizer, private readonly lifecycle: DiscussionLifecycle, private readonly details: RunDetails,
    private readonly runs: RunSynchronizer) {}
  status(connectionKey: string) { return { ...this.progress.get(connectionKey) ?? idle() }; }
  private async current(connectionKey: string) {
    await this.sync.assertNoPurge();
    const connection = await this.connection();
    if (connection.connectionKey !== connectionKey) throw new Error("连接已变化，请刷新设置页。");
    return connection;
  }
  private async blockers(connection: AuthenticatedConnection): Promise<RebuildBlocker[]> {
    const { connectionKey } = connection;
    const local = (await this.store.read()).connections[connectionKey];
    let workspaces: Promise<RemoteWorkspace[]> | undefined;
    const blockers: RebuildBlocker[] = [];
    for (const [issueId, issue] of Object.entries(local?.issues ?? {})) {
      const candidates = Object.entries(issue.runs).filter(([, run]) => isActiveRun(run.status)).map(([runId]) => runId);
      if (!candidates.length) continue;
      let result: Awaited<ReturnType<RunSynchronizer["recheck"]>> | undefined;
      let failure: Pick<RebuildBlocker["runs"][number], "verification" | "reason"> | undefined;
      try {
        const project = local.projects[issue.remoteWorkspaceId];
        const workspace = project?.slug ? { id: issue.remoteWorkspaceId, name: project.name, slug: project.slug }
          : (await (workspaces ??= readWorkspaces(connection))).find(workspace => workspace.id === issue.remoteWorkspaceId);
        if (!workspace) failure = { verification: "unconfirmable", reason: "Multica 工作区不可访问或已不在工作区列表中。" };
        else {
          result = await this.runs.recheck(connection, workspace, issueId, candidates);
          if (result.unavailable) failure = { verification: "unconfirmable", reason: result.unavailable === 404 ? "Multica 任务不存在或已不可访问（HTTP 404）。" : "无权访问 Multica 工作区（HTTP 403）。" };
        }
      } catch (error) {
        // Identity revocation must fail the whole request, never become an acknowledgement.
        await connection.assertCurrent?.();
        failure = { verification: "failed", reason: `远端复核暂时失败：${error instanceof Error ? error.message : String(error)}` };
      }
      const latest = (await this.store.read()).connections[connectionKey]?.issues[issueId];
      const groups = new Map<string, RebuildBlocker>();
      for (const runId of candidates) {
        const run = latest?.runs[runId];
        if (!run || !isActiveRun(run.status)) continue;
        const remote = result?.runs?.find(run => run.id === runId);
        const verification = failure ?? (remote ? { verification: "active" as const } : { verification: "unconfirmable" as const, reason: "远端快照中没有此 Run。" });
        const rootId = run.ownerRootId ?? "unresolved";
        const group = groups.get(rootId) ?? { issueId, title: issue.title, rootId, discussion: rootId === "main" ? "主讨论" : issue.threads[rootId]?.title ?? "归属待确定", runs: [] };
        group.runs.push({ runId, agentName: run.agentName, status: remote?.status ?? run.status, ...verification }); groups.set(rootId, group);
      }
      blockers.push(...groups.values());
    }
    return blockers;
  }
  private async discover(host: NativeHost, connectionKey: string) {
    const local = (await this.store.read()).connections[connectionKey];
    const listed = (await directory(cursor => host.fetchAgents({ filter: { includeArchived: true, includeBackground: true, includeInternal: true, labels: { [discussionKeys.connection]: connectionKey } }, page: { limit: 100, cursor } })))
      .map(entry => entry.agent).filter(agent => agent.provider === providerId && agent.labels[discussionKeys.connection] === connectionKey && agent.labels[discussionKeys.issue] && agent.labels[discussionKeys.discussion]);
    const discussions = new Map(listed.map(agent => [agent.id, { agent,
      address: { connectionKey, issueId: agent.labels[discussionKeys.issue], rootId: agent.labels[discussionKeys.discussion] } }]));
    for (const [issueId, issue] of Object.entries(local?.issues ?? {})) {
      const mapped = [{ rootId: "main", agentId: issue.mainAgentId },
        ...Object.entries(issue.threads).map(([rootId, thread]) => ({ rootId, agentId: thread.agentId }))];
      for (const { rootId, agentId } of mapped) {
        if (!agentId || discussions.has(agentId)) continue;
        const agent = (await host.fetchAgent(agentId))?.agent;
        if (agent?.provider === providerId && (agent.labels[discussionKeys.connection] === connectionKey || agent.cwd === issue.cwd)) {
          discussions.set(agentId, { agent, address: { connectionKey, issueId, rootId } });
        }
      }
    }
    const agents = [...discussions.values()].map(({ agent }) => agent);
    const active = await directory(cursor => host.fetchWorkspaces({ filter: { includeBackground: true, includeInternal: true }, page: { limit: 100, cursor } }));
    const knownWorkspaceIds = new Set(agents.flatMap(agent => agent.workspaceId ? [agent.workspaceId] : []));
    for (const issue of Object.values(local?.issues ?? {})) knownWorkspaceIds.add(issue.workspaceId);
    const prefix = join(this.store.directory, "placeholders", connectionKey.slice(0, 20)) + sep;
    const workspaceIds = new Set(active.filter(workspace => knownWorkspaceIds.has(workspace.id) || workspace.workspaceDirectory?.startsWith(prefix)).map(workspace => workspace.id));
    const candidates = new Map<string, string>();
    for (const project of Object.values(local?.projects ?? {})) if (project.projectId) candidates.set(project.projectId, project.cwd);
    for (const issue of Object.values(local?.issues ?? {})) if (issue.projectId && !candidates.has(issue.projectId)) {
      candidates.set(issue.projectId, local?.projects[issue.remoteWorkspaceId]?.cwd ?? resolve(issue.cwd, ".."));
    }
    const projects = (await host.listProjects()).projects.filter(project => project.projectKind === "non_git" &&
      (project.projectRootPath.startsWith(prefix) || candidates.get(project.projectId) === project.projectRootPath))
      .filter(project => !active.some(workspace => workspace.projectId === project.projectId && !workspaceIds.has(workspace.id)));
    return { agents, addresses: [...discussions.values()].map(({ address }) => address), workspaceIds, projects };
  }
  async preflight(connectionKey: string, paseo: PaseoApi) {
    const connection = await this.current(connectionKey);
    let counts = { projects: 0, workspaces: 0, discussions: 0 };
    await this.sync.withNativeHost(paseo, async host => {
      const found = await this.discover(host, connectionKey);
      counts = { projects: found.projects.length, workspaces: found.workspaceIds.size, discussions: found.agents.length };
    });
    return { ...counts, blockers: await this.blockers(connection) };
  }
  async start(connectionKey: string, paseo: PaseoApi, acknowledgedRunIds: string[] = []) {
    const connection = await this.current(connectionKey);
    if (this.operation) throw new Error("数据重建正在进行。");
    const acknowledged = new Set(acknowledgedRunIds);
    const blocked = (groups: RebuildBlocker[]) => groups.some(group => group.runs.some(run => run.verification !== "unconfirmable" || !acknowledged.has(run.runId)));
    const blockers = await this.blockers(connection);
    if (blocked(blockers)) return { started: false, blockers, progress: this.status(connectionKey) };
    if (this.operation) throw new Error("数据重建正在进行。");
    const progress: RebuildProgress = { ...idle(), status: "running", step: "等待后台同步" };
    this.progress.set(connectionKey, progress);
    this.operation = this.sync.exclusive(paseo, async host => {
      let release: (() => void) | undefined;
      try {
        const remaining = await this.blockers(await this.current(connectionKey));
        if (blocked(remaining)) {
          const summary = remaining.map(group => `${group.title} · ${group.discussion}：${group.runs.map(run =>
            `${run.runId}（${run.verification === "active" ? "远端仍活跃" : run.verification === "unconfirmable" ? "无法确认" : "复核失败"}）`).join("、")}`).join("；");
          throw new Error(`Run 复核未通过：${summary}。请重新打开重建以重新复核。`);
        }
        await this.details.pause();
        progress.step = "发现插件记录";
        const found = await this.discover(host, connectionKey);
        release = await this.lifecycle.hold(found.addresses);
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
        await this.store.removeRunDetails(connectionKey);
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
