import { join } from "node:path";
import type { PaseoApi } from "@getpaseo/client";
import { isActiveRun } from "../shared/runs.js";
import type { RebuildBlocker, RebuildProgress } from "../shared/rebuild.js";
import type { AuthenticatedConnection } from "./connection.js";
import type { DiscussionLifecycle } from "./discussion-lifecycle.js";
import type { NativeHost } from "./native-host.js";
import type { RunDetails } from "./run-details.js";
import type { RunSynchronizer } from "./runs.js";
import { StateStore, connectionState } from "./state.js";
import type { SidebarSynchronizer } from "./sync.js";
import { workspaces as readWorkspaces, type RemoteWorkspace } from "./multica-api.js";
import { discoverMappedObjects, teardownMappedObjects } from "./mapped-objects.js";

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
    return discoverMappedObjects(host, { [connectionKey]: local ?? { rules: {}, projects: {}, issues: {} } },
      join(this.store.directory, "placeholders", connectionKey.slice(0, 20)));
  }
  async preflight(connectionKey: string, paseo: PaseoApi) {
    const connection = await this.current(connectionKey);
    let counts = { projects: 0, workspaces: 0, discussions: 0 };
    await this.sync.withNativeHost(paseo, async host => {
      const found = await this.discover(host, connectionKey);
      counts = { projects: found.removableProjects, workspaces: found.workspaceIds.size, discussions: found.discussions.length };
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
        await teardownMappedObjects(host, this.lifecycle, found, {
          onStage: stage => { progress.step = { delete: "删除插件讨论", archive: "归档 Paseo 工作区", remove: "删除 Paseo 项目", clean: "清理本地占位目录", reset: "清空本地状态" }[stage]; },
          reset: async () => {
            await this.store.removeRunDetails(connectionKey);
            await this.store.update(state => {
              const local = connectionState(state, connectionKey);
              state.connections[connectionKey] = { rules: local.rules, rebuildGeneration: (local.rebuildGeneration ?? 0) + 1, projects: {}, issues: {} };
            });
          },
        });
        this.details.resume(connectionKey);
        progress.stage = "importing"; progress.step = "按筛选规则导入";
        await this.sync.reimport(connectionKey, (completed, total) => { progress.completed = completed; progress.total = total; });
        progress.status = "completed"; progress.message = `重建完成，已导入 ${progress.completed} 个任务。`;
      } finally { this.details.resume(); }
    }).catch(error => { progress.status = "failed"; progress.message = `${progress.step}失败：${error instanceof Error ? error.message : String(error)}`; })
      .finally(() => { this.operation = undefined; });
    return { started: true, blockers: [], progress: this.status(connectionKey) };
  }
  async close() { await this.operation; }
}
