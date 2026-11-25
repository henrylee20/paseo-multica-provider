import { createHash } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import type { PaseoApi } from "@getpaseo/client";
import { z } from "zod";
import { taskRuleSchema, type TaskRule, type SyncStatus } from "../shared/contracts.js";
import { issueQuery } from "./filters.js";
import { WorkspaceEvents, type WorkspaceEvent } from "./workspace-events.js";
import { remoteFetch, type AuthenticatedConnection } from "./connection.js";
import { archiveClosedDiscussion, ensureWorkspaceActive, findActiveWorkspace, findNativeDiscussion, projectHasActiveWorkspaces, restoreMappedDiscussion, type NativeHost } from "./native-host.js";
import { StateStore, connectionState } from "./state.js";
import { hiddenAgent, restoreWorkspacePreservingHidden } from "./hiding.js";
import { discussionKeys } from "../shared/discussion.js";
import type { DiscussionLifecycle } from "./discussion-lifecycle.js";

export const workspaceSchema = z.object({ id: z.string().min(1), name: z.string(), slug: z.string().min(1) });
const issueSchema = z.object({ id: z.string().min(1), workspace_id: z.string(), identifier: z.string().optional(), title: z.string(),
  description: z.string().nullish(), status: z.string(), status_category: z.string().optional(), updated_at: z.string().optional() });
const pageSchema = z.object({ issues: z.array(issueSchema), total: z.number().int().nonnegative() });
export type RemoteWorkspace = z.infer<typeof workspaceSchema>;
export const defaultStatusCategories = ["unstarted", "started"];
export const providerId = "multica";
export function mainPersistence(connectionKey: string, issueId: string) {
  return { version: 1, data: { connectionKey, issueId, discussion: "main" } } as const;
}
export function issueLabels(connectionKey: string, issueId: string) {
  return { [discussionKeys.connection]: connectionKey, [discussionKeys.issue]: issueId, [discussionKeys.discussion]: "main" };
}
function stableId(...parts: string[]) { return createHash("sha256").update(JSON.stringify(parts)).digest("hex"); }

export async function remoteJson(connection: AuthenticatedConnection, path: string, schema: z.ZodType, workspace?: RemoteWorkspace) {
  const response = await remoteFetch(connection, path, { headers: workspace ? { "X-Workspace-Slug": workspace.slug } : {} });
  if (!response.ok) { await response.body?.cancel(); throw new Error(`Multica read failed (HTTP ${response.status})`); }
  return schema.parse(await response.json());
}

export class SidebarSynchronizer {
  private pending: Promise<unknown> = Promise.resolve();
  private host?: NativeHost;
  private syncPending?: Promise<void>;
  private syncState: SyncStatus = { status: "idle", stage: "idle", completedWorkspaces: 0, enabledWorkspaces: 0 };
  status(): SyncStatus { return { ...this.syncState }; }
  private expectedServerId?: string;
  private timer?: ReturnType<typeof setInterval>;
  private closed = false;
  private eventTimer?: ReturnType<typeof setTimeout>;
  private eventSyncPending = false;
  private eventDirty = false;
  private readonly events = new WorkspaceEvents(event => {
    this.options.onRemoteEvent?.(event);
    this.eventDirty = true;
    this.scheduleInvalidation();
  });
  private scheduleInvalidation() {
    if (this.closed || this.eventTimer || this.eventSyncPending) return;
    this.eventTimer = setTimeout(() => {
      this.eventTimer = undefined;
      this.eventDirty = false;
      this.eventSyncPending = true;
      void this.requestSync().catch(() => {}).finally(() => {
        this.eventSyncPending = false;
        if (this.eventDirty) this.scheduleInvalidation();
      });
    }, 20);
    this.eventTimer.unref?.();
  }
  constructor(private readonly options: {
    store: StateStore; connection: () => Promise<AuthenticatedConnection>; lifecycle: DiscussionLifecycle;
    connectHost: () => Promise<NativeHost>; intervalMs: number; onRemoteEvent?: (event: WorkspaceEvent) => void;
    onCached?: (host: NativeHost) => Promise<void>;
    onIssue?: (connection: AuthenticatedConnection, workspace: RemoteWorkspace, issueId: string, host: NativeHost) => Promise<void>;
  }) {}

  async workspaces(connection: AuthenticatedConnection): Promise<RemoteWorkspace[]> {
    return await remoteJson(connection, "/api/workspaces", z.array(workspaceSchema)) as RemoteWorkspace[];
  }
  async bootstrap(paseo: PaseoApi): Promise<void> {
    const serverId = (await paseo.hosts.list()).self.serverId;
    if (this.expectedServerId && this.expectedServerId !== serverId) throw new Error("Bootstrap daemon identity changed");
    this.expectedServerId = serverId;
    // A client connection starts daemon recovery even if the first remote read fails.
    if (!this.closed && !this.timer) {
      this.timer = setInterval(() => { void this.requestSync().catch(() => {}); }, this.options.intervalMs);
      this.timer.unref?.();
    }
    return this.requestSync();
  }
  private requestSync(): Promise<void> {
    if (!this.syncPending) {
      const operation = this.serialize(async () => {
        this.syncState = { ...this.syncState, status: "syncing", stage: "connection", completedWorkspaces: 0, message: undefined };
        try {
          await this.sync();
          this.syncState = { ...this.syncState, status: "ready", stage: "idle", lastSuccessAt: new Date().toISOString() };
        } catch (error) {
          this.syncState = { ...this.syncState, status: "unavailable", message: "同步未完成；保留已读缓存，daemon 将继续重试。" };
          throw error;
        }
      });
      this.syncPending = operation;
      void operation.finally(() => { if (this.syncPending === operation) this.syncPending = undefined; }).catch(() => {});
    }
    return this.syncPending;
  }
  withNativeHost(paseo: PaseoApi, operation: (host: NativeHost) => Promise<void>): Promise<void> {
    return this.serialize(async () => {
      const serverId = (await paseo.hosts.list()).self.serverId;
      if (this.expectedServerId && this.expectedServerId !== serverId) throw new Error("Bootstrap daemon identity changed");
      this.expectedServerId = serverId;
      if (!this.host) this.host = await this.options.connectHost();
      if ((await this.host.listHosts()).self.serverId !== serverId) throw new Error("Native host is not the owning daemon");
      await operation(this.host);
    });
  }
  /** Reconcile a saved comment without changing the client's selected discussion. */
  reconcile(): Promise<void> { return this.expectedServerId ? this.serialize(() => this.sync()) : Promise.resolve(); }
  enable(paseo: PaseoApi, workspaceId: string, enabled: boolean, expectedConnectionKey?: string): Promise<void> {
    return this.serialize(async () => {
      const connection = await this.options.connection();
      if (expectedConnectionKey && connection.connectionKey !== expectedConnectionKey) throw new Error("Connection identity changed");
      const workspace = (await this.workspaces(connection)).find(item => item.id === workspaceId);
      if (!workspace) throw new Error("Multica workspace unavailable");
      await this.options.store.update(state => {
        const rules = connectionState(state, connection.connectionKey).rules;
        rules[workspaceId] = { ...taskRuleSchema.parse(rules[workspaceId] ?? {}), enabled };
      });
    }).then(() => this.bootstrap(paseo));
  }
  rule(paseo: PaseoApi, workspaceId: string, rule: TaskRule, expectedConnectionKey?: string): Promise<void> {
    return this.serialize(async () => {
      const connection = await this.options.connection();
      if (expectedConnectionKey && connection.connectionKey !== expectedConnectionKey) throw new Error("Connection identity changed");
      if (!(await this.workspaces(connection)).some(item => item.id === workspaceId)) throw new Error("Multica workspace unavailable");
      await this.options.store.update(state => {
        const rules = connectionState(state, connection.connectionKey).rules;
        rules[workspaceId] = { ...rule, enabled: rules[workspaceId]?.enabled ?? false };
      });
    }).then(() => this.bootstrap(paseo));
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
    if (issue.archiveReason && !workspaceActive && !activeAgents.length) {
      if (issue.archivePending) await this.options.store.update(state => { state.connections[connectionKey].issues[issueId].archivePending = false; });
      return;
    }
    // Native prompt admission can reopen an agent inside an archived workspace.
    // Preserve the original restore set while repairing that later native drift.
    await this.options.store.update(state => {
      const mapping = state.connections[connectionKey].issues[issueId];
      if (!mapping.archiveReason) {
        mapping.archiveReason = reason;
        mapping.ruleArchivedAgentIds = activeAgents;
      }
      mapping.archivePending = true;
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
    await this.options.store.update(state => { state.connections[connectionKey].issues[issueId].archivePending = false; });
  }

  private async removeDisabledProjects(connectionKey: string) {
    const local = (await this.options.store.read()).connections[connectionKey];
    for (const [workspaceId, cached] of Object.entries(local?.projects ?? {})) {
      if (local.rules[workspaceId]?.enabled !== false || !cached.projectId) continue;
      const project = (await this.host!.listProjects()).projects.find(project => project.projectId === cached.projectId);
      if (project && (project.projectRootPath !== cached.cwd || project.projectKind !== "non_git")) continue;
      if (project && await projectHasActiveWorkspaces(this.host!, cached.projectId)) continue;
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
  private async sync() {
    if (!this.host) this.host = await this.options.connectHost();
    if ((await this.host.listHosts()).self.serverId !== this.expectedServerId) throw new Error("Native host is not the owning daemon");
    this.syncState.stage = "history";
    await this.options.onCached?.(this.host);
    this.syncState.stage = "connection";
    const connection = await this.options.connection();
    this.syncState.connectionKey = connection.connectionKey;
    const state = await this.options.store.read();
    const local = state.connections[connection.connectionKey];
    const enabled = Object.entries(local?.rules ?? {}).filter(([, rule]) => rule.enabled);
    this.syncState.enabledWorkspaces = enabled.length;
    this.syncState.stage = "workspaces";
    const disabledIssues = Object.entries(local?.issues ?? {}).filter(([, issue]) =>
      local?.rules[issue.remoteWorkspaceId]?.enabled === false);
    const disabledProjects = Object.keys(local?.projects ?? {}).some(id => local?.rules[id]?.enabled === false);
    if (!enabled.length && !disabledIssues.length && !disabledProjects) { this.events.reconcile(connection, []); return; }
    const workspaces = enabled.length ? await this.workspaces(connection) : [];
    this.events.reconcile(connection, workspaces.filter(workspace => local?.rules[workspace.id]?.enabled));
    if (!this.host) this.host = await this.options.connectHost();
    if ((await this.host.listHosts()).self.serverId !== this.expectedServerId) throw new Error("Native host is not the owning daemon");
    for (const [issueId] of disabledIssues) await this.archive(connection.connectionKey, issueId, "rule_disabled");
    await this.removeDisabledProjects(connection.connectionKey);
    for (const [workspaceId, rule] of enabled) {
      const workspace = workspaces.find(item => item.id === workspaceId);
      if (!workspace) throw new Error("Enabled workspace snapshot unavailable");
      this.syncState.stage = "issues";
      const issues: z.infer<typeof issueSchema>[] = [];
      let offset = 0;
      for (;;) {
        const query = issueQuery(rule, offset);
        const page = await remoteJson(connection, `/api/issues?${query}`, pageSchema, workspace) as z.infer<typeof pageSchema>;
        if (page.issues.some(issue => issue.workspace_id !== workspaceId)) throw new Error("Issue belongs to a different workspace");
        issues.push(...page.issues);
        offset += page.issues.length;
        if (offset >= page.total) break;
        if (!page.issues.length) throw new Error("Incomplete issue pagination");
      }
      // Only the complete successful snapshot is authoritative for rule exits.
      const matchingIds = new Set(issues.map(issue => issue.id));
      for (const [issueId, mapping] of Object.entries(local?.issues ?? {})) {
        if (mapping.remoteWorkspaceId !== workspaceId || matchingIds.has(issueId)) continue;
        await this.archive(connection.connectionKey, issueId, "filter_exit");
      }
      // AgentStorage flattens the entire cwd into one filename component.
      // Keep existing mappings bound to their original directories and history.
      const projectDirectory = local?.projects[workspaceId]?.cwd
        ?? join(this.options.store.directory, "placeholders", connection.connectionKey.slice(0, 20), stableId(workspaceId).slice(0, 20));
      await mkdir(projectDirectory, { recursive: true });
      const added = await this.host.addProject(projectDirectory);
      if (added.error || !added.project || added.project.projectKind === "git") throw new Error("Could not register non-Git native project");
      const projectId = added.project.projectId;
      await this.host.renameProject(projectId, workspace.name);
      await this.options.store.update(state => { connectionState(state, connection.connectionKey).projects[workspaceId] = { cwd: projectDirectory, projectId, name: workspace.name, slug: workspace.slug }; });
      for (const issue of issues) {
        const previous = (await this.options.store.read()).connections[connection.connectionKey]?.issues[issue.id];
        const title = [issue.identifier, issue.title].filter(Boolean).join(" ");
        const oldProjectId = previous?.projectId ?? local?.projects[workspaceId]?.projectId;
        const rebuild = previous?.workspaceCreated && oldProjectId && oldProjectId !== projectId;
        const cwd = local?.issues[issue.id]?.cwd ?? join(projectDirectory, stableId(issue.id).slice(0, 20));
        await mkdir(cwd, { recursive: true });
        // Persist intent before native creation. A retry uses the same valid native ID.
        await this.options.store.update(state => {
          const local = connectionState(state, connection.connectionKey);
          local.issues[issue.id] = { ...local.issues[issue.id], remoteWorkspaceId: workspaceId,
            projectId,
            workspaceId: rebuild ? `wks_${stableId(connection.connectionKey, issue.id, projectId).slice(0, 16)}`
              : local.issues[issue.id]?.workspaceId ?? `wks_${stableId(connection.connectionKey, issue.id).slice(0, 16)}`,
            workspaceCreated: rebuild ? false : local.issues[issue.id]?.workspaceCreated ?? false,
            commentSourceTaskIds: local.issues[issue.id]?.commentSourceTaskIds ?? {},
            runs: local.issues[issue.id]?.runs ?? {}, runDetails: local.issues[issue.id]?.runDetails ?? {}, commentCreatedAt: local.issues[issue.id]?.commentCreatedAt ?? {},
            commentInputs: local.issues[issue.id]?.commentInputs ?? {},
            manualHidden: local.issues[issue.id]?.manualHidden ?? { workspace: false, discussions: [] },
            threads: local.issues[issue.id]?.threads ?? {}, commentRoots: local.issues[issue.id]?.commentRoots ?? {}, unresolvedCommentIds: local.issues[issue.id]?.unresolvedCommentIds ?? [],
            systemRootIds: local.issues[issue.id]?.systemRootIds ?? [], mainHistory: local.issues[issue.id]?.mainHistory ?? { title: "主讨论", historyLoaded: false, rows: [], observed: {} },
            ruleArchivedAgentIds: local.issues[issue.id]?.ruleArchivedAgentIds ?? [], archivePending: local.issues[issue.id]?.archivePending ?? false, cwd, title, description: issue.description ?? "", updatedAt: issue.updated_at };
        });
        const mapping = (await this.options.store.read()).connections[connection.connectionKey].issues[issue.id];
        if (!mapping.workspaceCreated) {
          if (!await findActiveWorkspace(this.host, mapping.workspaceId)) {
            const result = await this.host.createWorkspace({ source: { kind: "directory", path: cwd, projectId }, title,
              workspaceId: mapping.workspaceId, idempotencyKey: `multica:${connection.connectionKey}:${issue.id}` +
                (mapping.workspaceId === `wks_${stableId(connection.connectionKey, issue.id).slice(0, 16)}` ? "" : `:${mapping.workspaceId}`) });
            if (result.error || result.workspace?.id !== mapping.workspaceId) throw new Error("Native workspace creation failed");
          }
          if (mapping.manualHidden.workspace) {
            const result = await this.host.archiveWorkspace(mapping.workspaceId);
            if (result.error) throw new Error("Native workspace archive failed");
          }
          await this.options.store.update(state => { state.connections[connection.connectionKey].issues[issue.id].workspaceCreated = true; });
        }
        if (mapping.manualHidden.workspace) continue;
        if (mapping.archiveReason) {
          await restoreWorkspacePreservingHidden(this.host, this.options.lifecycle, mapping, { connectionKey: connection.connectionKey, issueId: issue.id });
          for (const agentId of mapping.ruleArchivedAgentIds) {
            if (hiddenAgent(mapping, agentId)) continue;
            await restoreMappedDiscussion(this.host, this.options.lifecycle, agentId, mapping, { connectionKey: connection.connectionKey, issueId: issue.id });
          }
          await this.options.store.update(state => {
            const saved = state.connections[connection.connectionKey].issues[issue.id];
            delete saved.archiveReason;
            saved.archivePending = false;
            saved.ruleArchivedAgentIds = [];
          });
        }
        await this.host.setWorkspaceTitle(mapping.workspaceId, title);
        let mainAgentId = mapping.mainAgentId;
        if (!mainAgentId && !mapping.manualHidden.discussions.includes("main")) {
          const labels = issueLabels(connection.connectionKey, issue.id);
          mainAgentId = (await findNativeDiscussion(this.host, { workspaceId: mapping.workspaceId, provider: providerId, labels }))?.id;
          if (!mainAgentId) {
            mainAgentId = (await this.host.importAgent({ providerId, providerHandleId: `plugin:${JSON.stringify(mainPersistence(connection.connectionKey, issue.id))}`,
              cwd, workspaceId: mapping.workspaceId, labels })).id;
          }
          await this.options.store.update(state => { state.connections[connection.connectionKey].issues[issue.id].mainAgentId = mainAgentId; });
        }
        if (mainAgentId && !mapping.manualHidden.discussions.includes("main")) await this.host.updateAgent(mainAgentId, { name: "主讨论" });
        this.syncState.stage = "history";
        await this.options.onIssue?.(connection, workspace, issue.id, this.host);

      }
      this.syncState.completedWorkspaces++;
    }
  }
  close() {
    this.closed = true;
    if (this.timer) clearInterval(this.timer);
    if (this.eventTimer) clearTimeout(this.eventTimer);
    this.events.close();
    return this.pending.then(async () => { await this.host?.close(); });
  }
}
