import { createHash } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import type { PaseoApi } from "@getpaseo/client";
import { z } from "zod";
import { taskRuleSchema, type TaskRule, type SyncStatus } from "../shared/contracts.js";
import { issueQuery } from "./filters.js";
import { WorkspaceEvents, type WorkspaceEvent } from "./workspace-events.js";
import { remoteFetch, type AuthenticatedConnection } from "./connection.js";
import { ensureWorkspaceActive, findActiveWorkspace, findNativeDiscussion, type NativeHost } from "./native-host.js";
import { StateStore, connectionState } from "./state.js";
import { hiddenAgent, restoreWorkspacePreservingHidden } from "./hiding.js";
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
  return { "multica.connection": connectionKey, "multica.issue": issueId, "multica.discussion": "main" };
}
function stableId(...parts: string[]) { return createHash("sha256").update(JSON.stringify(parts)).digest("hex"); }

export async function remoteJson(connection: AuthenticatedConnection, path: string, schema: z.ZodType, workspace?: RemoteWorkspace) {
  const response = await remoteFetch(connection, path, { headers: workspace ? { "X-Workspace-Slug": workspace.slug } : {} });
  if (!response.ok) { await response.body?.cancel(); throw new Error(`Multica read failed (HTTP ${response.status})`); }
  const value = schema.parse(await response.json());
  await connection.assertCurrent?.();
  return value;
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
  private async archive(connectionKey: string, issueId: string, reason: "rule_disabled" | "filter_exit" | "inaccessible") {
    const issue = (await this.options.store.read()).connections[connectionKey].issues[issueId];
    if (!issue.workspaceCreated || issue.manualHidden.workspace) return;
    const activeAgents: string[] = [];
    let cursor: string | undefined;
    const cursors = new Set<string>();
    for (;;) {
      const page = await this.host!.fetchAgents({ filter: { labels: { "multica.connection": connectionKey, "multica.issue": issueId }, includeArchived: true }, page: { limit: 100, cursor } });
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
    if (!workspaceActive) await ensureWorkspaceActive(this.host!, issue.workspaceId);
    const result = await this.host!.archiveWorkspace(issue.workspaceId);
    if (result.error) throw new Error("Native workspace archive failed");
    await this.options.store.update(state => { state.connections[connectionKey].issues[issueId].archivePending = false; });
  }

  /** A filtered list cannot distinguish a rule exit from loss of object access. */
  private async objectAccess(connection: AuthenticatedConnection, workspace: RemoteWorkspace, issueId: string) {
    const response = await remoteFetch(connection, `/api/issues/${encodeURIComponent(issueId)}`, { headers: { "X-Workspace-Slug": workspace.slug } });
    if (response.ok) {
      const parsed = issueSchema.safeParse(await response.json());
      await connection.assertCurrent?.();
      if (!parsed.success || parsed.data.id !== issueId || parsed.data.workspace_id !== workspace.id) return "unknown" as const;
      return "available" as const;
    }
    const status = response.status;
    let error = "";
    try { error = z.object({ error: z.string() }).parse(await response.json()).error; } catch { /* An HTML/generic route error is not object evidence. */ }
    await connection.assertCurrent?.();
    if (status !== 403 && status !== 404) throw new Error(`Multica object read failed (HTTP ${status})`);
    const issue = (await this.options.store.read()).connections[connection.connectionKey]?.issues[issueId];
    const explicitIssueError = /\bissue\b/i.test(error) && /not found|forbidden|denied|permission/i.test(error);
    if (!error || (!issue?.access?.objectVerifiedAt && !explicitIssueError)) return "unknown" as const;
    // Recheck both account and workspace AFTER denial. Token expiry, a service
    // outage or a workspace-wide rejection must not retire every cached Issue.
    const me = await remoteJson(connection, "/api/me", z.object({ id: z.string() })) as { id: string };
    if (me.id !== connection.userId || !(await this.workspaces(connection)).some(item => item.id === workspace.id && item.slug === workspace.slug)) {
      throw new Error("Multica connection or workspace unavailable");
    }
    return status === 403 ? "forbidden" as const : "not_found" as const;
  }
  private async inaccessible(connectionKey: string, issueId: string, reason: "forbidden" | "not_found") {
    await this.options.store.update(state => {
      const issue = state.connections[connectionKey].issues[issueId];
      issue.access = { ...issue.access, status: "inaccessible", reason, checkedAt: new Date().toISOString() };
    });
    await this.archive(connectionKey, issueId, "inaccessible");
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
    if (!enabled.length && !disabledIssues.length) { this.events.reconcile(connection, []); return; }
    const workspaces = enabled.length ? await this.workspaces(connection) : [];
    this.events.reconcile(connection, workspaces.filter(workspace => local?.rules[workspace.id]?.enabled));
    if (!this.host) this.host = await this.options.connectHost();
    if ((await this.host.listHosts()).self.serverId !== this.expectedServerId) throw new Error("Native host is not the owning daemon");
    for (const [issueId] of disabledIssues) await this.archive(connection.connectionKey, issueId, "rule_disabled");
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
        const access = await this.objectAccess(connection, workspace, issueId);
        if (access === "forbidden" || access === "not_found") await this.inaccessible(connection.connectionKey, issueId, access);
        else {
          // A readable object that left the filter remains outside active work.
          // Unknown legacy routes retain their prior access classification.
          if (access === "available") await this.options.store.update(state => {
            const issue = state.connections[connection.connectionKey].issues[issueId];
            issue.access = { ...issue.access, status: "available", checkedAt: new Date().toISOString(), objectVerifiedAt: new Date().toISOString() };
            delete issue.access.reason;
          });
          await this.archive(connection.connectionKey, issueId, "filter_exit");
        }
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
      await this.options.store.update(state => { connectionState(state, connection.connectionKey).projects[workspaceId] = { cwd: projectDirectory, projectId, name: workspace.name }; });
      for (const issue of issues) {
        const previous = (await this.options.store.read()).connections[connection.connectionKey]?.issues[issue.id];
        // A returned list row alone does not undo a confirmed object denial.
        const access = await this.objectAccess(connection, workspace, issue.id);
        if (access === "forbidden" || access === "not_found") {
          if (previous) await this.inaccessible(connection.connectionKey, issue.id, access);
          continue;
        }
        if (previous?.access?.status === "inaccessible" && access !== "available") {
          await this.archive(connection.connectionKey, issue.id, "inaccessible");
          continue;
        }
        const title = [issue.identifier, issue.title].filter(Boolean).join(" ");
        const cwd = local?.issues[issue.id]?.cwd ?? join(projectDirectory, stableId(issue.id).slice(0, 20));
        await mkdir(cwd, { recursive: true });
        // Persist intent before native creation. A retry uses the same valid native ID.
        await this.options.store.update(state => {
          const local = connectionState(state, connection.connectionKey);
          local.issues[issue.id] = { ...local.issues[issue.id], remoteWorkspaceId: workspaceId,
            access: { ...local.issues[issue.id]?.access, status: "available", reason: undefined, checkedAt: new Date().toISOString(),
              ...(access === "available" ? { objectVerifiedAt: new Date().toISOString() } : {}) },
            workspaceId: local.issues[issue.id]?.workspaceId ?? `wks_${stableId(connection.connectionKey, issue.id).slice(0, 16)}`,
            workspaceCreated: local.issues[issue.id]?.workspaceCreated ?? false,
            commentSourceTaskIds: local.issues[issue.id]?.commentSourceTaskIds ?? {},
            runs: local.issues[issue.id]?.runs ?? {}, runDetails: local.issues[issue.id]?.runDetails ?? {}, commentCreatedAt: local.issues[issue.id]?.commentCreatedAt ?? {},
            stopEpochs: local.issues[issue.id]?.stopEpochs ?? {}, stopRecords: local.issues[issue.id]?.stopRecords ?? {},
            deliveries: local.issues[issue.id]?.deliveries ?? {},
            manualHidden: local.issues[issue.id]?.manualHidden ?? { workspace: false, discussions: [] },
            threads: local.issues[issue.id]?.threads ?? {}, commentRoots: local.issues[issue.id]?.commentRoots ?? {}, unresolvedCommentIds: local.issues[issue.id]?.unresolvedCommentIds ?? [],
            systemRootIds: local.issues[issue.id]?.systemRootIds ?? [], mainHistory: local.issues[issue.id]?.mainHistory ?? { title: "主讨论", historyLoaded: false, rows: [], observed: {} },
            ruleArchivedAgentIds: local.issues[issue.id]?.ruleArchivedAgentIds ?? [], archivePending: local.issues[issue.id]?.archivePending ?? false, cwd, title, description: issue.description ?? "", updatedAt: issue.updated_at };
        });
        const mapping = (await this.options.store.read()).connections[connection.connectionKey].issues[issue.id];
        if (mapping.manualHidden.workspace) continue;
        if (mapping.archiveReason) {
          await restoreWorkspacePreservingHidden(this.host, this.options.lifecycle, mapping, { connectionKey: connection.connectionKey, issueId: issue.id });
          for (const agentId of mapping.ruleArchivedAgentIds) {
            if (hiddenAgent(mapping, agentId)) continue;
            const existing = await this.host.fetchAgent(agentId);
            // refreshAgent interrupts a live agent; use it only for archived records.
            if (existing?.agent.archivedAt) await this.host.refreshAgent(agentId);
          }
          await this.options.store.update(state => {
            const saved = state.connections[connection.connectionKey].issues[issue.id];
            delete saved.archiveReason;
            saved.archivePending = false;
            saved.ruleArchivedAgentIds = [];
          });
        }
        if (!mapping.workspaceCreated) {
          if (!await findActiveWorkspace(this.host, mapping.workspaceId)) {
            const result = await this.host.createWorkspace({ source: { kind: "directory", path: cwd, projectId }, title,
              workspaceId: mapping.workspaceId, idempotencyKey: `multica:${connection.connectionKey}:${issue.id}` });
            if (result.error || result.workspace?.id !== mapping.workspaceId) throw new Error("Native workspace creation failed");
          }
          await this.options.store.update(state => { state.connections[connection.connectionKey].issues[issue.id].workspaceCreated = true; });
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
        await this.options.store.update(state => {
          const saved = state.connections[connection.connectionKey].issues[issue.id];
          saved.access = { ...saved.access, status: "available", lastSuccessAt: new Date().toISOString() };
          delete saved.access.reason;
        });
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
