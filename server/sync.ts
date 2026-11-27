import { createHash } from "node:crypto";
import { mkdir, readdir, rm, rmdir } from "node:fs/promises";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import type { PaseoApi } from "@getpaseo/client";
import { z } from "zod";
import { taskRuleSchema, type TaskRule, type SyncStatus } from "../shared/contracts.js";
import { issueQuery } from "./filters.js";
import { WorkspaceEvents, type WorkspaceEvent } from "./workspace-events.js";
import { remoteFetch, type AuthenticatedConnection } from "./connection.js";
import { archiveClosedDiscussion, ensureWorkspaceActive, fetchActiveWorkspaceIds, findActiveWorkspace, findNativeDiscussion, projectHasActiveWorkspaces, restoreMappedDiscussion, type NativeHost } from "./native-host.js";
import { StateStore, connectionState, issueSchema, type ConnectionState, type IssueMapping } from "./state.js";
import { discussionAgent, hiddenAgent, restoreWorkspacePreservingHidden } from "./hiding.js";
import { discussionKeys } from "../shared/discussion.js";
import type { DiscussionMetadata } from "./discussion-metadata.js";
import type { DiscussionLifecycle } from "./discussion-lifecycle.js";

export const workspaceSchema = z.object({ id: z.string().min(1), name: z.string(), slug: z.string().min(1) });
const overviewText = z.string().trim().min(1).optional().catch(undefined);
const remoteIssueSchema = z.object({ id: z.string().min(1), workspace_id: z.string(), title: z.string(),
  description: z.string().nullish(), updated_at: z.string().optional(),
  identifier: overviewText, status: overviewText, status_name: overviewText, status_category: overviewText,
  priority: z.enum(["urgent", "high", "medium", "low", "none"]).optional().catch(undefined),
  assignee_type: z.enum(["member", "agent", "squad"]).optional().catch(undefined), assignee_id: overviewText, project_id: overviewText,
  due_date: z.iso.date().optional().catch(undefined),
  labels: z.array(z.object({ name: z.string().trim().min(1) })).optional().catch(undefined),
});
const pageSchema = z.object({ issues: z.array(remoteIssueSchema), total: z.number().int().nonnegative() });
// These requests live only for this snapshot (or an explicit Thread open).
export type RemoteWorkspace = z.infer<typeof workspaceSchema> & {
  agents?: Promise<Array<{ id: string; name: string; archived_at?: string | null }>>;
  members?: Promise<Array<{ user_id: string; name: string }>>;
  squads?: Promise<Array<{ id: string; name: string }>>;
  projects?: Promise<{ projects: Array<{ id: string; title: string }> }>;
  statuses?: Promise<{ statuses: Array<{ key: string; name: string; category: string }> }>;
};
export const providerId = "multica";
export function mainPersistence(connectionKey: string, issueId: string) {
  return { version: 1, data: { connectionKey, issueId, discussion: "main" } } as const;
}
export function issueLabels(connectionKey: string, issueId: string) {
  return { [discussionKeys.connection]: connectionKey, [discussionKeys.issue]: issueId, [discussionKeys.discussion]: "main" };
}
function stableId(...parts: string[]) { return createHash("sha256").update(JSON.stringify(parts)).digest("hex"); }

export function importedIssues(local: ConnectionState | undefined, workspaceId: string) {
  return Object.entries(local?.issues ?? {}).filter(([, issue]) => issue.remoteWorkspaceId === workspaceId && !issue.archiveReason);
}

export async function remoteJson(connection: AuthenticatedConnection, path: string, schema: z.ZodType, workspace?: RemoteWorkspace, signal?: AbortSignal) {
  const response = await remoteFetch(connection, path, { headers: workspace ? { "X-Workspace-Slug": workspace.slug } : {}, signal });
  if (!response.ok) { await response.body?.cancel(); throw new Error(`Multica read failed (HTTP ${response.status})`); }
  return schema.parse(await response.json());
}

export function workspaceAgents(connection: AuthenticatedConnection, workspace: RemoteWorkspace) {
  return workspace.agents ??= remoteJson(connection, `/api/agents?workspace_id=${encodeURIComponent(workspace.id)}&include_archived=true`,
    z.array(z.object({ id: z.string(), name: z.string(), archived_at: z.string().nullish() })), workspace) as NonNullable<RemoteWorkspace["agents"]>;
}
export function workspaceMembers(connection: AuthenticatedConnection, workspace: RemoteWorkspace) {
  return workspace.members ??= remoteJson(connection, `/api/workspaces/${encodeURIComponent(workspace.id)}/members`,
    z.array(z.object({ user_id: z.string(), name: z.string() })), workspace) as NonNullable<RemoteWorkspace["members"]>;
}

async function issueOverview(connection: AuthenticatedConnection, workspace: RemoteWorkspace, issue: z.infer<typeof remoteIssueSchema>, previous?: IssueMapping["overview"]): Promise<NonNullable<IssueMapping["overview"]>> {
  const overview: NonNullable<IssueMapping["overview"]> = {
    identifier: issue.identifier, statusKey: issue.status, statusCategory: issue.status_category, priority: issue.priority,
    assigneeType: issue.assignee_type, assigneeId: issue.assignee_id, projectId: issue.project_id,
    labels: issue.labels?.map(label => label.name), dueDate: issue.due_date,
    url: connection.appUrl && workspace.slug ? `${connection.appUrl.replace(/\/$/, "")}/${encodeURIComponent(workspace.slug)}/issues/${encodeURIComponent(issue.identifier ?? issue.id)}` : undefined,
  };
  if (issue.assignee_type && issue.assignee_id) {
    try {
      if (issue.assignee_type === "member") overview.assigneeName = (await workspaceMembers(connection, workspace)).find(item => item.user_id === issue.assignee_id)?.name;
      else if (issue.assignee_type === "agent") overview.assigneeName = (await workspaceAgents(connection, workspace)).find(item => item.id === issue.assignee_id)?.name;
      else {
        const squads = await (workspace.squads ??= remoteJson(connection, "/api/squads", z.array(z.object({ id: z.string(), name: z.string() })), workspace) as NonNullable<RemoteWorkspace["squads"]>);
        overview.assigneeName = squads.find(item => item.id === issue.assignee_id)?.name;
      }
    } catch {
      if (previous?.assigneeType === issue.assignee_type && previous.assigneeId === issue.assignee_id) overview.assigneeName = previous.assigneeName;
    }
  }
  if (issue.project_id) {
    try {
      const projects = await (workspace.projects ??= remoteJson(connection, "/api/projects?include_archived=true",
        z.object({ projects: z.array(z.object({ id: z.string(), title: z.string() })) }), workspace) as NonNullable<RemoteWorkspace["projects"]>);
      overview.projectName = projects.projects.find(item => item.id === issue.project_id)?.title;
    } catch { if (previous?.projectId === issue.project_id) overview.projectName = previous.projectName; }
  }
  overview.statusName = issue.status_name;
  if (!overview.statusName && issue.status) {
    try {
      const statuses = await (workspace.statuses ??= remoteJson(connection, "/api/issue-statuses?include_archived=true",
        z.object({ statuses: z.array(z.object({ key: z.string(), name: z.string(), category: z.string() })) }), workspace) as NonNullable<RemoteWorkspace["statuses"]>);
      overview.statusName = statuses.statuses.find(item => item.key === issue.status)?.name;
    } catch { if (previous?.statusKey === issue.status) overview.statusName = previous.statusName; }
  }
  const categories: Record<string, string> = { unstarted: "未开始", started: "进行中", done: "已完成", closed: "已关闭" };
  overview.statusName ||= (issue.status_category ? categories[issue.status_category] : undefined) ?? issue.status;
  // Match the JSON representation so a restart does not turn absent fields into a state change.
  for (const key of Object.keys(overview) as Array<keyof typeof overview>) if (overview[key] === undefined) delete overview[key];
  return overview;
}

export class SidebarSynchronizer {
  private pending: Promise<unknown> = Promise.resolve();
  private mutationPending: Promise<unknown> = Promise.resolve();
  private ruleVersion = 0;
  private syncDirty = false;
  private host?: NativeHost;
  private syncPending?: Promise<void>;
  private syncState: SyncStatus = { status: "idle", stage: "idle", completedWorkspaces: 0, enabledWorkspaces: 0 };
  status(): SyncStatus { return { ...this.syncState }; }
  private expectedServerId?: string;
  private timer?: ReturnType<typeof setInterval>;
  private intervalMs: number;
  private closed = false;
  private paused = false;
  private eventTimer?: ReturnType<typeof setTimeout>;
  private readonly dirtyWorkspaces = new Set<string>();
  private eventFullSync = false;
  private readonly events = new WorkspaceEvents(event => {
    this.options.onRemoteEvent?.(event);
    if (this.syncState.connectionKey && event.connectionKey === this.syncState.connectionKey) this.dirtyWorkspaces.add(event.workspaceId);
    else this.eventFullSync = true;
    this.scheduleInvalidation();
  });
  private scheduleInvalidation() {
    if (this.closed || this.paused || this.eventTimer || this.syncPending || (!this.eventFullSync && !this.dirtyWorkspaces.size)) return;
    this.eventTimer = setTimeout(() => {
      this.eventTimer = undefined;
      const workspaces = this.eventFullSync ? undefined : new Set(this.dirtyWorkspaces);
      this.eventFullSync = false;
      this.dirtyWorkspaces.clear();
      void this.triggerSync(workspaces).catch(() => {});
    }, this.options.eventDebounceMs ?? 500);
    this.eventTimer.unref?.();
  }
  constructor(private readonly options: {
    store: StateStore; connection: (notifyIdentity?: boolean) => Promise<AuthenticatedConnection>; lifecycle: DiscussionLifecycle; metadata: DiscussionMetadata;
    connectHost: () => Promise<NativeHost>; intervalMs: number; eventDebounceMs?: number; onRemoteEvent?: (event: WorkspaceEvent) => void;
    currentProfile: () => Promise<string | undefined>; invalidateConnection: () => void; drain: () => Promise<void>;
    onCached?: (host: NativeHost) => Promise<void>;
    onIssue?: (connection: AuthenticatedConnection, workspace: RemoteWorkspace, issueId: string, host: NativeHost) => Promise<void>;
  }) { this.intervalMs = options.intervalMs; }

  private readonly previews = new Map<string, AbortController>();
  private readonly idsSupport = new Map<string, Promise<boolean>>();
  async workspaces(connection: AuthenticatedConnection, signal?: AbortSignal): Promise<RemoteWorkspace[]> {
    return await remoteJson(connection, "/api/workspaces", z.array(workspaceSchema), undefined, signal) as RemoteWorkspace[];
  }
  private async issuePage(connection: AuthenticatedConnection, workspace: RemoteWorkspace, query: URLSearchParams, signal?: AbortSignal) {
    const page = await remoteJson(connection, `/api/issues?${query}`, pageSchema, workspace, signal) as z.infer<typeof pageSchema>;
    if (page.issues.some(issue => issue.workspace_id !== workspace.id)) throw new Error("Issue belongs to a different workspace");
    return page;
  }
  private async supportsIds(connection: AuthenticatedConnection, workspace: RemoteWorkspace, signal: AbortSignal): Promise<boolean> {
    const existing = this.idsSupport.get(connection.connectionKey);
    if (existing) return existing;
    const probe = (async () => {
      const response = await remoteFetch(connection, "/api/issues?limit=1&offset=0&ids=", { headers: { "X-Workspace-Slug": workspace.slug }, signal });
      if (!response.ok) {
        await response.body?.cancel();
        if (response.status === 400 || response.status === 422) return false;
        throw new Error(`Multica read failed (HTTP ${response.status})`);
      }
      const page = pageSchema.parse(await response.json());
      if (page.issues.some(issue => issue.workspace_id !== workspace.id)) throw new Error("Issue belongs to a different workspace");
      return page.total === 0 && page.issues.length === 0;
    })();
    this.idsSupport.set(connection.connectionKey, probe);
    try { return await probe; }
    catch (error) {
      if (this.idsSupport.get(connection.connectionKey) === probe) this.idsSupport.delete(connection.connectionKey);
      throw error;
    }
  }
  private async matchingIssues(connection: AuthenticatedConnection, workspace: RemoteWorkspace, rule: TaskRule, version?: number, signal?: AbortSignal, shouldStop?: () => boolean) {
    const issues: z.infer<typeof remoteIssueSchema>[] = [];
    let offset = 0;
    for (;;) {
      if (shouldStop?.() || (version !== undefined && version !== this.ruleVersion)) return issues;
      const query = issueQuery(rule, offset);
      const page = await this.issuePage(connection, workspace, query, signal);
      issues.push(...page.issues);
      offset += page.issues.length;
      if (offset >= page.total) break;
      if (!page.issues.length) throw new Error("Incomplete issue pagination");
    }
    return issues;
  }
  async preview(workspaceId: string, rule: TaskRule, expectedConnectionKey?: string) {
    // Preview bypasses the sync queue and identity-change projection notifications.
    this.previews.get(workspaceId)?.abort();
    const controller = new AbortController(), { signal } = controller;
    this.previews.set(workspaceId, controller);
    try {
      const connection = await this.options.connection(false);
      signal.throwIfAborted();
      if (expectedConnectionKey && connection.connectionKey !== expectedConnectionKey) throw new Error("Connection identity changed");
      const workspace = (await this.workspaces(connection, signal)).find(item => item.id === workspaceId);
      if (!workspace) throw new Error("Multica workspace unavailable");
      const imported = importedIssues((await this.options.store.read()).connections[connection.connectionKey], workspaceId);
      let total: number, matchingIds: Set<string>;
      if (await this.supportsIds(connection, workspace, signal)) {
        const query = issueQuery(rule, 0); query.set("limit", "1");
        const batches: string[][] = [];
        for (let offset = 0; offset < imported.length; offset += 100) batches.push(imported.slice(offset, offset + 100).map(([id]) => id));
        const [count, ...intersections] = await Promise.all([
          this.issuePage(connection, workspace, query, signal),
          ...batches.map(async ids => {
            const query = issueQuery(rule, 0); query.set("ids", ids.join(","));
            const page = await this.issuePage(connection, workspace, query, signal);
            if (page.issues.some(issue => !ids.includes(issue.id))) throw new Error("Issue outside requested IDs");
            if (new Set(page.issues.map(issue => issue.id)).size !== page.total) throw new Error("Incomplete issue pagination");
            return page;
          }),
        ]);
        total = count.total;
        matchingIds = new Set(intersections.flatMap(page => page.issues.map(issue => issue.id)));
      } else {
        const issues = await this.matchingIssues(connection, workspace, rule, undefined, signal);
        matchingIds = new Set(issues.map(issue => issue.id)); total = matchingIds.size;
      }
      signal.throwIfAborted();
      await connection.assertCurrent?.();
      signal.throwIfAborted();
      const intersection = imported.filter(([id]) => matchingIds.has(id));
      return { total, imported: imported.length, entering: total - intersection.length,
        leaving: imported.filter(([id]) => !matchingIds.has(id)).map(([id, issue]) => ({ id, title: issue.title })) };
    } finally {
      controller.abort();
      if (this.previews.get(workspaceId) === controller) this.previews.delete(workspaceId);
    }
  }
  private async assertOwningDaemon(paseo?: PaseoApi) {
    const serverId = (await (paseo ? paseo.hosts.list() : this.host!.listHosts())).self.serverId;
    if (this.expectedServerId && this.expectedServerId !== serverId) throw new Error("Native host is not the owning daemon");
    this.expectedServerId = serverId;
  }
  private startTimer() {
    if (!this.closed && !this.timer) {
      this.timer = setInterval(() => { void this.requestSync().catch(() => {}); }, this.intervalMs);
      this.timer.unref?.();
    }
  }
  setIntervalMs(ms: number) {
    if (ms === this.intervalMs) return;
    this.intervalMs = ms;
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = undefined;
      this.startTimer();
    }
  }
  async bootstrap(paseo: PaseoApi, force = false): Promise<void> {
    await this.assertOwningDaemon(paseo);
    this.startTimer();
    if (force || await this.purgePending() || this.syncState.status === "idle") void this.requestSync().catch(() => {});
  }
  settingsChanged() {
    this.ruleVersion++;
    this.events.disconnect();
    if (this.expectedServerId) void this.triggerSync().catch(() => {});
  }
  async purgePending() {
    const profile = await this.options.currentProfile();
    const state = await this.options.store.read();
    return profile !== undefined && !!state.owner && state.owner.profile !== profile;
  }
  async assertNoPurge() { if (await this.purgePending()) throw new Error("正在清理旧 profile 本地数据，请稍后重试。"); }
  private requestSync(): Promise<void> { return this.syncPending ?? this.triggerSync(); }
  private triggerSync(workspaces?: Set<string>): Promise<void> {
    if (this.closed || this.paused) return Promise.resolve();
    if (!workspaces) {
      if (this.eventTimer) clearTimeout(this.eventTimer);
      this.eventTimer = undefined;
      this.eventFullSync = false;
      this.dirtyWorkspaces.clear();
    }
    this.syncDirty = true;
    this.syncState = { ...this.syncState, status: "syncing", message: undefined };
    if (!this.syncPending) {
      this.syncState = { ...this.syncState, stage: "connection", completedWorkspaces: 0, completedArchives: 0, pendingArchives: 0 };
      this.syncPending = this.serialize(async () => {
        try {
          while (!this.closed && !this.paused && this.syncDirty) {
            this.syncDirty = false;
            const version = this.ruleVersion;
            this.syncState = { ...this.syncState, stage: "connection", completedWorkspaces: 0, completedArchives: 0, pendingArchives: 0 };
            let failed = false;
            try { await this.sync(version, undefined, workspaces); }
            catch { failed = true; }
            // Check and finish in the same turn: a mutation must never get lost
            // between the last pass and clearing syncPending.
            if (this.syncDirty || this.ruleVersion !== version) { workspaces = undefined; this.syncDirty = true; continue; }
            this.syncState = failed
              ? { ...this.syncState, status: "unavailable", message: this.syncState.stage === "purging" ? "清理旧 profile 本地数据失败；同步和规则写入已暂停，请重新引导以重试。" : "同步失败；已保存的规则与开关不受影响，daemon 将继续重试。" }
              : this.syncState.failedWorkspaces?.length
              ? { ...this.syncState, status: "unavailable", stage: "idle", message: `${this.syncState.failedWorkspaces.length} 个 Multica 工作区同步失败：${this.syncState.failedWorkspaces.map(failure => failure.name).join("、")}` }
              : { ...this.syncState, status: "ready", stage: "idle", pendingArchives: 0, lastSuccessAt: new Date().toISOString() };
          }
        } finally { this.syncPending = undefined; this.scheduleInvalidation(); }
      });
    }
    return this.syncPending;
  }
  withNativeHost(paseo: PaseoApi, operation: (host: NativeHost) => Promise<void>): Promise<void> {
    return this.serialize(async () => {
      await this.assertOwningDaemon(paseo);
      if (!this.host) this.host = await this.options.connectHost();
      await this.assertOwningDaemon();
      await this.assertNoPurge();
      await operation(this.host);
    });
  }
  /** Let the current sync yield at its next rule-version boundary, then run alone. */
  async exclusive(paseo: PaseoApi, operation: (host: NativeHost) => Promise<void>) {
    await this.assertNoPurge();
    if (this.paused) throw new Error("数据重建正在进行。");
    this.paused = true;
    this.ruleVersion++;
    try {
      await this.mutationPending;
      await this.withNativeHost(paseo, operation);
    } finally {
      this.paused = false;
      if (!this.closed) void this.triggerSync().catch(() => {});
    }
  }
  async reimport(connectionKey: string, progress: (completed: number, total: number) => void) {
    await this.assertNoPurge();
    const version = this.ruleVersion;
    await this.sync(version, { connectionKey, progress });
    await this.assertNoPurge();
    if (version !== this.ruleVersion) throw new Error("重建期间 profile 已变化，请重新重建。");
    if (this.syncState.failedWorkspaces?.length) throw new Error(`${this.syncState.failedWorkspaces.length} 个 Multica 工作区同步失败：${this.syncState.failedWorkspaces.map(failure => `${failure.name}（${failure.message}）`).join("；")}`);
  }
  /** Reconcile a saved comment without changing the client's selected discussion. */
  reconcile(): Promise<void> { return this.expectedServerId ? this.triggerSync() : Promise.resolve(); }
  enable(paseo: PaseoApi, workspaceId: string, enabled: boolean, expectedConnectionKey?: string): Promise<void> {
    return this.mutate(async () => {
      await this.assertOwningDaemon(paseo);
      if (await this.purgePending()) await this.serialize(() => this.purge());
      const connection = await this.options.connection();
      if (expectedConnectionKey && connection.connectionKey !== expectedConnectionKey) throw new Error("Connection identity changed");
      const local = (await this.options.store.read()).connections[connection.connectionKey];
      const known = local && (local.rules[workspaceId] || local.projects[workspaceId]
        || Object.values(local.issues).some(issue => issue.remoteWorkspaceId === workspaceId));
      if ((enabled || !known) && !(await this.workspaces(connection)).some(item => item.id === workspaceId)) throw new Error("Multica workspace unavailable");
      await connection.assertCurrent?.();
      await this.options.store.update(state => {
        const rules = connectionState(state, connection.connectionKey).rules;
        rules[workspaceId] = { ...taskRuleSchema.parse(rules[workspaceId] ?? {}), enabled };
      });
    });
  }
  rule(paseo: PaseoApi, workspaceId: string, rule: TaskRule, expectedConnectionKey?: string): Promise<void> {
    return this.mutate(async () => {
      await this.assertOwningDaemon(paseo);
      if (await this.purgePending()) await this.serialize(() => this.purge());
      const connection = await this.options.connection();
      if (expectedConnectionKey && connection.connectionKey !== expectedConnectionKey) throw new Error("Connection identity changed");
      if (!(await this.workspaces(connection)).some(item => item.id === workspaceId)) throw new Error("Multica workspace unavailable");
      await connection.assertCurrent?.();
      await this.options.store.update(state => {
        const rules = connectionState(state, connection.connectionKey).rules;
        rules[workspaceId] = { ...rule, enabled: rules[workspaceId]?.enabled ?? false };
      });
    });
  }
  private mutate(operation: () => Promise<void>) {
    const result = this.mutationPending.then(async () => {
      if (this.closed) return;
      if (this.paused) throw new Error("数据重建期间暂不能修改筛选规则。");
      await operation();
      this.ruleVersion++;
      this.startTimer();
      void this.triggerSync().catch(() => {});
    });
    this.mutationPending = result.catch(() => {});
    return result;
  }
  private async archive(connectionKey: string, issueId: string, reason: "rule_disabled" | "filter_exit") {
    const issue = (await this.options.store.read()).connections[connectionKey].issues[issueId];
    if (!issue.workspaceCreated || issue.manualHidden.workspace) return;
    const activeAgents: string[] = [];
    let cursor: string | undefined;
    const cursors = new Set<string>();
    for (;;) {
      const page = await this.host!.fetchAgents({ filter: { labels: { [discussionKeys.connection]: connectionKey, [discussionKeys.issue]: issueId }, includeArchived: true }, page: { limit: 100, cursor } });
      activeAgents.push(...page.entries.filter(item => item.agent.workspaceId === issue.workspaceId && !item.agent.archivedAt).map(item => item.agent.id));
      if (!page.pageInfo.hasMore) break;
      const next = page.pageInfo.nextCursor;
      if (!next || cursors.has(next)) throw new Error("Incomplete native agent pagination");
      cursors.add(next);
      cursor = next;
    }
    const workspaceActive = await findActiveWorkspace(this.host!, issue.workspaceId);
    if (issue.archiveReason && !workspaceActive && !activeAgents.length) return;
    // Native prompt admission can reopen an agent inside an archived workspace.
    // Preserve the original restore set while repairing that later native drift.
    await this.options.store.update(state => {
      const mapping = state.connections[connectionKey].issues[issueId];
      if (!mapping.archiveReason) {
        mapping.archiveReason = reason;
        mapping.ruleArchivedAgentIds = activeAgents;
      }
    });
    // An already archived workspace ignores bulk archive. Restore its record
    // before bulk teardown, whose close path does not interrupt remote Runs.
    const project = (await this.options.store.read()).connections[connectionKey].projects[issue.remoteWorkspaceId];
    if (!workspaceActive && (project?.removed || (issue.projectId && issue.projectId !== project?.projectId))) {
      // The old parent may already be gone. Close reopened projections locally;
      // restoring that retired workspace would fail with Unknown project.
      const roots = ["main", ...Object.keys(issue.threads)];
      const release = await this.options.lifecycle.hold(roots.map(rootId => ({ connectionKey, issueId, rootId })));
      try { for (const agentId of activeAgents) await archiveClosedDiscussion(this.host!, agentId, issue); }
      finally { release(); }
    } else {
      if (!workspaceActive) await ensureWorkspaceActive(this.host!, issue.workspaceId);
      const result = await this.host!.archiveWorkspace(issue.workspaceId);
      if (result.error) throw new Error("Native workspace archive failed");
    }
  }

  private async removeDisabledProjects(connectionKey: string, version: number) {
    const local = (await this.options.store.read()).connections[connectionKey];
    for (const [workspaceId, cached] of Object.entries(local?.projects ?? {})) {
      if (version !== this.ruleVersion) return;
      if (local.rules[workspaceId]?.enabled !== false || !cached.projectId) continue;
      const project = (await this.host!.listProjects()).projects.find(project => project.projectId === cached.projectId);
      if (project && (project.projectRootPath !== cached.cwd || project.projectKind !== "non_git")) continue;
      if (project && await projectHasActiveWorkspaces(this.host!, cached.projectId)) continue;
      if (version !== this.ruleVersion) return;
      // Preserve the old parent on each task before replacing the Project cache.
      // Intent survives a lost remove acknowledgement and plugin restarts.
      await this.options.store.update(state => {
        const saved = state.connections[connectionKey];
        saved.projects[workspaceId].removed = true;
        for (const issue of Object.values(saved.issues)) if (issue.remoteWorkspaceId === workspaceId) issue.projectId ??= cached.projectId;
      });
      if (project) await this.host!.removeProject(cached.projectId);
    }
  }

  private serialize(operation: () => Promise<void>) {
    const result = this.pending.then(async () => { if (this.closed) return; await operation(); });
    this.pending = result.catch(() => {});
    return result;
  }
  /** Runs only inside serialize: retain the durable owner until every local step succeeds. */
  private async purge() {
    const targetProfile = await this.options.currentProfile();
    let state = await this.options.store.read();
    if (targetProfile === undefined || !state.owner || state.owner.profile === targetProfile) return;
    this.syncState = { status: "syncing", stage: "purging", completedWorkspaces: 0, enabledWorkspaces: 0 };
    this.options.invalidateConnection();
    this.events.disconnect();
    const releases: Array<() => void> = [];
    try {
      // Close mapped sessions first and reject competing opens while draining writers.
      releases.push(await this.options.lifecycle.hold(Object.entries(state.connections).flatMap(([connectionKey, conn]) =>
        Object.entries(conn.issues).flatMap(([issueId, issue]) => ["main", ...Object.keys(issue.threads)].map(rootId => ({ connectionKey, issueId, rootId }))))));
      await this.options.drain();
      state = await this.options.store.read();
      if (!this.host) this.host = await this.options.connectHost();
      await this.assertOwningDaemon();
      const host = this.host;
      const discussions = new Set<string>();
      const addresses: Array<{ connectionKey: string; issueId: string; rootId: string }> = [];
      for (const [connectionKey, conn] of Object.entries(state.connections)) {
        let cursor: string | undefined;
        const cursors = new Set<string>();
        for (;;) {
          const page = await host.fetchAgents({ filter: { labels: { [discussionKeys.connection]: connectionKey }, includeArchived: true }, page: { limit: 100, cursor } });
          for (const { agent } of page.entries) {
            if (agent.provider !== "multica" || agent.labels[discussionKeys.connection] !== connectionKey) continue;
            discussions.add(agent.id);
            const issueId = agent.labels[discussionKeys.issue], rootId = agent.labels[discussionKeys.discussion];
            if (issueId && rootId) addresses.push({ connectionKey, issueId, rootId });
          }
          if (!page.pageInfo.hasMore) break;
          const next = page.pageInfo.nextCursor;
          if (!next || cursors.has(next)) throw new Error("Incomplete native discussion pagination");
          cursors.add(next); cursor = next;
        }
        for (const issue of Object.values(conn.issues)) {
          for (const agentId of [issue.mainAgentId, ...Object.values(issue.threads).map(thread => thread.agentId)]) {
            if (!agentId || discussions.has(agentId)) continue;
            const agent = (await host.fetchAgent(agentId))?.agent;
            if (agent?.provider === "multica" && (agent.labels[discussionKeys.connection] === connectionKey || agent.cwd === issue.cwd)) {
              discussions.add(agentId);
              const issueId = agent.labels[discussionKeys.issue], rootId = agent.labels[discussionKeys.discussion];
              if (issueId && rootId) addresses.push({ connectionKey, issueId, rootId });
            }
          }
        }
      }
      releases.push(await this.options.lifecycle.hold(addresses));
      for (const agentId of discussions) await host.deleteAgent(agentId);

      const projects = (await host.listProjects()).projects;
      const active: Awaited<ReturnType<NativeHost["fetchWorkspaces"]>>["entries"] = [];
      let cursor: string | undefined;
      const cursors = new Set<string>();
      for (;;) {
        const page = await host.fetchWorkspaces({ page: { limit: 100, cursor } });
        active.push(...page.entries);
        if (!page.pageInfo.hasMore) break;
        const next = page.pageInfo.nextCursor;
        if (!next || cursors.has(next)) throw new Error("Incomplete native workspace pagination");
        cursors.add(next); cursor = next;
      }
      const knownWorkspaces = new Set(Object.values(state.connections).flatMap(conn => Object.values(conn.issues).map(issue => issue.workspaceId)));
      const candidates = new Map<string, { cwd: string; name: string }>();
      for (const conn of Object.values(state.connections)) {
        for (const project of Object.values(conn.projects)) if (project.projectId) candidates.set(project.projectId, project);
        for (const issue of Object.values(conn.issues)) if (issue.projectId && !candidates.has(issue.projectId)) {
          const project = conn.projects[issue.remoteWorkspaceId];
          candidates.set(issue.projectId, { cwd: project?.cwd ?? resolve(issue.cwd, ".."), name: project?.name ?? issue.title });
        }
      }
      const retainedProjects: Array<{ name: string; cwd: string }> = [];
      const removedProjects = new Set<string>();
      const archivedWorkspaces = new Set<string>();
      const archive = async (id: string) => {
        if ((await host.archiveWorkspace(id)).error) throw new Error("Native workspace archive failed");
        archivedWorkspaces.add(id);
      };
      for (const [projectId, cached] of candidates) {
        const project = projects.find(project => project.projectId === projectId);
        if (!project || project.projectRootPath !== cached.cwd || project.projectKind !== "non_git") continue;
        const workspaces = active.filter(workspace => workspace.projectId === projectId);
        if (workspaces.some(workspace => !knownWorkspaces.has(workspace.id))) {
          retainedProjects.push({ name: cached.name, cwd: cached.cwd });
          for (const workspace of workspaces) if (knownWorkspaces.has(workspace.id)) await archive(workspace.id);
        } else {
          await host.removeProject(projectId);
          removedProjects.add(projectId);
        }
      }
      for (const workspace of active) if (knownWorkspaces.has(workspace.id) && !removedProjects.has(workspace.projectId) && !archivedWorkspaces.has(workspace.id)) await archive(workspace.id);

      const root = resolve(this.options.store.directory, "placeholders");
      const inside = (target: string) => { const path = relative(root, resolve(target)); return !!path && !path.startsWith("..") && !isAbsolute(path); };
      const preserved = retainedProjects.map(project => resolve(project.cwd));
      const clean = async (directory: string) => {
        if (preserved.includes(directory)) return;
        for (const entry of await readdir(directory, { withFileTypes: true }).catch((error: NodeJS.ErrnoException) => { if (error.code === "ENOENT") return []; throw error; })) {
          const target = resolve(directory, entry.name);
          if (!inside(target)) throw new Error("Unsafe placeholder removal target");
          if (preserved.includes(target)) continue;
          if (entry.isDirectory() && preserved.some(path => path.startsWith(target + sep))) {
            await clean(target);
          } else await rm(target, { recursive: true, force: true });
        }
        await rmdir(directory).catch((error: NodeJS.ErrnoException) => { if (error.code !== "ENOENT" && error.code !== "ENOTEMPTY") throw error; });
      };
      await clean(root);
      await this.options.store.update(state => { state.connections = {}; state.owner = { profile: targetProfile }; });
      for (const connectionKey of Object.keys(state.connections)) await this.options.store.removeRunDetails(connectionKey);
      this.syncState.retainedProjects = retainedProjects.length ? retainedProjects : undefined;
    } catch (error) {
      this.syncState = { ...this.syncState, status: "unavailable", stage: "purging", message: "清理旧 profile 本地数据失败；同步和规则写入已暂停，请重新引导以重试。" };
      throw error;
    } finally { for (const release of releases.reverse()) release(); }
  }
  private async sync(version: number, rebuild?: { connectionKey: string; progress: (completed: number, total: number) => void }, dirtyWorkspaces?: Set<string>) {
    let fatalError: unknown;
    const stopped = () => version !== this.ruleVersion || this.closed || fatalError !== undefined;
    if (!dirtyWorkspaces) this.syncState.failedWorkspaces = undefined;
    if (rebuild) await this.assertNoPurge();
    else await this.purge();
    if (!this.host) this.host = await this.options.connectHost();
    await this.assertOwningDaemon();
    if (stopped()) return;
    this.syncState.stage = "history";
    await this.options.onCached?.(this.host);
    this.syncState.stage = "connection";
    const connection = await this.options.connection();
    if (rebuild && rebuild.connectionKey !== connection.connectionKey) throw new Error("Connection identity changed");
    if (this.syncState.connectionKey !== connection.connectionKey) dirtyWorkspaces = undefined;
    this.syncState.connectionKey = connection.connectionKey;
    const state = await this.options.store.read();
    const local = state.connections[connection.connectionKey];
    if (stopped()) return;
    const allEnabled = Object.entries(local?.rules ?? {}).filter(([, rule]) => rule.enabled);
    this.syncState.stage = "workspaces";
    const disabledIssues = Object.entries(local?.issues ?? {}).filter(([, issue]) =>
      local?.rules[issue.remoteWorkspaceId]?.enabled === false);
    const disabledProjects = Object.entries(local?.projects ?? {}).filter(([id, project]) => local?.rules[id]?.enabled === false && project.projectId && !project.removed);
    const pendingIssues = disabledIssues.filter(([, issue]) => !issue.archiveReason && issue.workspaceCreated && !issue.manualHidden.workspace);
    if (pendingIssues.length || disabledProjects.length) dirtyWorkspaces = undefined;
    const enabled = dirtyWorkspaces ? allEnabled.filter(([id]) => dirtyWorkspaces.has(id)) : allEnabled;
    const checked = new Set(enabled.map(([id]) => id));
    const remaining = dirtyWorkspaces ? this.syncState.failedWorkspaces?.filter(failure => !checked.has(failure.workspaceId)) : undefined;
    this.syncState.failedWorkspaces = remaining?.length ? remaining : undefined;
    this.syncState.enabledWorkspaces = enabled.length;
    this.syncState.pendingArchives = pendingIssues.length;
    if (!allEnabled.length && !disabledIssues.length && !disabledProjects.length) { this.events.reconcile(connection, []); rebuild?.progress(0, 0); return; }
    const workspaces = allEnabled.length ? await this.workspaces(connection) : [];
    const prepared = new Map<string, z.infer<typeof remoteIssueSchema>[]>();
    let completed = 0, total = 0;
    if (rebuild) {
      for (const [workspaceId, rule] of enabled) {
        if (stopped()) return;
        const workspace = workspaces.find(item => item.id === workspaceId);
        if (!workspace) throw new Error("Enabled workspace snapshot unavailable");
        const issues = await this.matchingIssues(connection, workspace, rule, version, undefined, stopped);
        prepared.set(workspaceId, issues); total += issues.length;
      }
      rebuild.progress(0, total);
    }
    if (stopped()) return;
    this.events.reconcile(connection, workspaces.filter(workspace => local?.rules[workspace.id]?.enabled));
    await this.assertOwningDaemon();
    if (pendingIssues.length) this.syncState.stage = "archiving";
    for (const [issueId, issue] of dirtyWorkspaces ? [] : disabledIssues) {
      if (stopped()) return;
      await this.archive(connection.connectionKey, issueId, "rule_disabled");
      if (!issue.archiveReason && issue.workspaceCreated && !issue.manualHidden.workspace) {
        this.syncState.completedArchives = (this.syncState.completedArchives ?? 0) + 1;
        this.syncState.pendingArchives = Math.max(0, (this.syncState.pendingArchives ?? 0) - 1);
      }
    }
    if (stopped()) return;
    if (!dirtyWorkspaces) await this.removeDisabledProjects(connection.connectionKey, version);
    let activeWorkspaceIds: Promise<Set<string>> | undefined;
    const host = this.host;
    let nextWorkspace = 0, readingWorkspaces = 0;
    const worker = async () => {
      while (!stopped()) {
        const entry = enabled[nextWorkspace++];
        if (!entry) return;
        const [workspaceId, rule] = entry;
        const workspace = workspaces.find(item => item.id === workspaceId);
        try {
          if (!workspace) throw new Error("Enabled workspace snapshot unavailable");
          readingWorkspaces++;
          this.syncState.stage = "issues";
          let issues: z.infer<typeof remoteIssueSchema>[];
          try { issues = prepared.get(workspaceId) ?? await this.matchingIssues(connection, workspace, rule, version, undefined, stopped); }
          finally { readingWorkspaces--; this.syncState.stage = readingWorkspaces ? "issues" : "history"; }
          if (stopped()) return;
          // Only the complete successful snapshot is authoritative for rule exits.
          const matchingIds = new Set(issues.map(issue => issue.id));
          for (const [issueId, mapping] of Object.entries(local?.issues ?? {})) {
            if (stopped()) return;
            if (mapping.remoteWorkspaceId !== workspaceId || matchingIds.has(issueId)) continue;
            await this.archive(connection.connectionKey, issueId, "filter_exit");
          }
          if (stopped()) return;
          // AgentStorage flattens the entire cwd into one filename component.
          // Keep existing mappings bound to their original directories and history.
          const projectDirectory = local?.projects[workspaceId]?.cwd
            ?? join(this.options.store.directory, "placeholders", connection.connectionKey.slice(0, 20), stableId(workspaceId).slice(0, 20));
          await mkdir(projectDirectory, { recursive: true });
          const added = await host.addProject(projectDirectory);
          if (added.error || !added.project || added.project.projectKind === "git") throw new Error("Could not register non-Git native project");
          const projectId = added.project.projectId;
          const projectName = `Multica · ${workspace.name}`;
          if (local?.projects[workspaceId]?.appliedName !== projectName || local.projects[workspaceId].projectId !== projectId)
            await host.renameProject(projectId, projectName);
          await this.options.store.update(state => {
            connectionState(state, connection.connectionKey).projects[workspaceId] = { cwd: projectDirectory, projectId, name: workspace.name, appliedName: projectName, slug: workspace.slug };
          });
          for (const issue of issues) {
            if (stopped()) return;
            const previous = (await this.options.store.read()).connections[connection.connectionKey]?.issues[issue.id];
            const overview = await issueOverview(connection, workspace, issue, previous?.overview);
            await connection.assertCurrent?.();
            if (stopped()) return;
            const title = [issue.identifier, issue.title].filter(Boolean).join(" ");
            const oldProjectId = previous?.projectId ?? local?.projects[workspaceId]?.projectId;
            const rebuildWorkspace = previous?.workspaceCreated && oldProjectId && oldProjectId !== projectId;
            const cwd = local?.issues[issue.id]?.cwd ?? join(projectDirectory, stableId(issue.id).slice(0, 20));
            await mkdir(cwd, { recursive: true });
            // Persist intent before native creation. A retry uses the same valid native ID.
            await this.options.store.update(state => {
              const local = connectionState(state, connection.connectionKey);
              const generation = local.rebuildGeneration ?? 0;
              const newWorkspaceId = `wks_${stableId(connection.connectionKey, issue.id,
                ...(rebuildWorkspace ? [projectId] : []), ...(generation > 0 ? [String(generation)] : [])).slice(0, 16)}`;
              local.issues[issue.id] = issueSchema.parse({ ...local.issues[issue.id], remoteWorkspaceId: workspaceId,
                projectId,
                workspaceId: rebuildWorkspace ? newWorkspaceId : local.issues[issue.id]?.workspaceId ?? newWorkspaceId,
                workspaceCreated: rebuildWorkspace ? false : local.issues[issue.id]?.workspaceCreated,
                appliedTitle: rebuildWorkspace ? undefined : local.issues[issue.id]?.appliedTitle,
                cwd, title, description: issue.description ?? "", overview, updatedAt: issue.updated_at });
            });
            let mapping = (await this.options.store.read()).connections[connection.connectionKey].issues[issue.id];
            if (!mapping.workspaceCreated) {
              if (!await findActiveWorkspace(host, mapping.workspaceId)) {
                const result = await host.createWorkspace({ source: { kind: "directory", path: cwd, projectId }, title,
                  workspaceId: mapping.workspaceId, idempotencyKey: `multica:${connection.connectionKey}:${issue.id}` +
                    (mapping.workspaceId === `wks_${stableId(connection.connectionKey, issue.id).slice(0, 16)}` ? "" : `:${mapping.workspaceId}`) });
                if (result.error || result.workspace?.id !== mapping.workspaceId) throw new Error("Native workspace creation failed");
              }
              if (mapping.manualHidden.workspace) {
                const result = await host.archiveWorkspace(mapping.workspaceId);
                if (result.error) throw new Error("Native workspace archive failed");
              }
              await this.options.store.update(state => { state.connections[connection.connectionKey].issues[issue.id].workspaceCreated = true; });
            }
            if (previous?.workspaceCreated && !rebuildWorkspace && !mapping.archiveReason) {
              const workspaceRestored = mapping.manualHidden.workspace &&
                (await (activeWorkspaceIds ??= fetchActiveWorkspaceIds(host))).has(mapping.workspaceId);
              if (!mapping.manualHidden.workspace || workspaceRestored) {
                const restoredRoots = new Set<string>();
                for (const rootId of mapping.manualHidden.discussions) {
                  if (this.options.lifecycle.unavailable({ connectionKey: connection.connectionKey, issueId: issue.id, rootId })) continue;
                  const agentId = discussionAgent(mapping, rootId);
                  if (!agentId) continue;
                  const agent = (await host.fetchAgent(agentId))?.agent;
                  if (agent?.workspaceId === mapping.workspaceId && agent.cwd === mapping.cwd && agent.provider === providerId && !agent.archivedAt)
                    restoredRoots.add(rootId);
                }
                if (stopped()) return;
                if (workspaceRestored || restoredRoots.size) {
                  await this.options.store.update(state => {
                    const saved = state.connections[connection.connectionKey].issues[issue.id];
                    if (workspaceRestored) saved.manualHidden.workspace = false;
                    saved.manualHidden.discussions = saved.manualHidden.discussions.filter(rootId => !restoredRoots.has(rootId));
                  });
                  mapping = (await this.options.store.read()).connections[connection.connectionKey].issues[issue.id];
                }
              }
            }
            if (mapping.manualHidden.workspace) continue;
            if (mapping.archiveReason) {
              await restoreWorkspacePreservingHidden(host, this.options.lifecycle, mapping, { connectionKey: connection.connectionKey, issueId: issue.id });
              for (const agentId of mapping.ruleArchivedAgentIds) {
                if (hiddenAgent(mapping, agentId)) continue;
                await restoreMappedDiscussion(host, this.options.lifecycle, agentId, mapping, { connectionKey: connection.connectionKey, issueId: issue.id });
                await this.options.metadata.write(agentId, connection.connectionKey, issue.id);
              }
              await this.options.store.update(state => {
                const saved = state.connections[connection.connectionKey].issues[issue.id];
                delete saved.archiveReason;
                delete saved.appliedTitle;
                delete saved.mainHistory.appliedTitle;
                for (const thread of Object.values(saved.threads)) if (thread.agentId && saved.ruleArchivedAgentIds.includes(thread.agentId)) delete thread.appliedTitle;
                saved.ruleArchivedAgentIds = [];
              });
            }
            if (!mapping.workspaceCreated || mapping.archiveReason || mapping.appliedTitle !== title) {
              await host.setWorkspaceTitle(mapping.workspaceId, title);
              await this.options.store.update(state => { state.connections[connection.connectionKey].issues[issue.id].appliedTitle = title; });
            }
            let mainAgentId = mapping.mainAgentId;
            if (!mainAgentId && !mapping.manualHidden.discussions.includes("main")) {
              const labels = issueLabels(connection.connectionKey, issue.id);
              mainAgentId = (await findNativeDiscussion(host, { workspaceId: mapping.workspaceId, provider: providerId, labels }))?.id;
              if (!mainAgentId) {
                mainAgentId = (await host.importAgent({ providerId, providerHandleId: `plugin:${JSON.stringify(mainPersistence(connection.connectionKey, issue.id))}`,
                  cwd, workspaceId: mapping.workspaceId, labels })).id;
                await this.options.metadata.write(mainAgentId, connection.connectionKey, issue.id);
              }
              await this.options.store.update(state => {
                const saved = state.connections[connection.connectionKey].issues[issue.id];
                saved.mainAgentId = mainAgentId;
                delete saved.mainHistory.appliedTitle;
              });
            }
            if (mainAgentId && !mapping.manualHidden.discussions.includes("main") &&
              (mainAgentId !== mapping.mainAgentId || mapping.archiveReason || mapping.mainHistory.appliedTitle !== "主讨论")) {
              await host.updateAgent(mainAgentId, { name: "主讨论" });
              await this.options.store.update(state => { state.connections[connection.connectionKey].issues[issue.id].mainHistory.appliedTitle = "主讨论"; });
            }
            if (stopped()) return;
            this.syncState.stage = readingWorkspaces ? "issues" : "history";
            await this.options.onIssue?.(connection, workspace, issue.id, host);
            if (stopped()) return;
            rebuild?.progress(++completed, total);
          }
          if (stopped()) return;
          this.syncState.completedWorkspaces++;
        } catch (error) {
          if (stopped()) return;
          try {
            connection.signal?.throwIfAborted();
            await connection.assertCurrent?.();
            await this.assertOwningDaemon();
          } catch (error) { fatalError ??= error; return; }
          if (stopped()) return;
          const message = !workspace ? "此 Multica 工作区不在可访问列表中，请检查权限。"
            : error instanceof Error && /^Multica read failed \(HTTP \d{3}\)$/.test(error.message)
            ? `Multica 读取失败（HTTP ${error.message.match(/\d{3}/)![0]}），请检查连接或权限后重试。`
            : "此 Multica 工作区同步失败，请检查连接或权限后重试。";
          const name = workspace?.name || local?.projects[workspaceId]?.name || workspaceId;
          (this.syncState.failedWorkspaces ??= []).push({ workspaceId, name, message });
        }
      }
    };
    const workers = Array.from({ length: Math.min(4, enabled.length) }, () => worker());
    await Promise.all(workers);
    // Keep summaries in rule order, independent of request completion order.
    const order = new Map(allEnabled.map(([id], index) => [id, index]));
    this.syncState.failedWorkspaces?.sort((a, b) => (order.get(a.workspaceId) ?? -1) - (order.get(b.workspaceId) ?? -1));
    if (fatalError !== undefined) {
      if (!dirtyWorkspaces) this.syncState.failedWorkspaces = undefined;
      throw fatalError;
    }
  }
  close() {
    this.closed = true;
    if (this.timer) clearInterval(this.timer);
    if (this.eventTimer) clearTimeout(this.eventTimer);
    this.events.close();
    for (const controller of this.previews.values()) controller.abort();
    this.previews.clear();
    return Promise.all([this.mutationPending, this.pending]).then(async () => { await this.host?.close(); });
  }
}
