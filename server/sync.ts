import { createHash } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import type { PaseoApi } from "@getpaseo/client";
import { z } from "zod";
import { taskRuleSchema, type TaskRule } from "../shared/contracts.js";
import { issueQuery } from "./filters.js";
import { WorkspaceEvents, type WorkspaceEvent } from "./workspace-events.js";
import type { AuthenticatedConnection } from "./connection.js";
import { ensureWorkspaceActive, findActiveWorkspace, type NativeHost } from "./native-host.js";
import { StateStore, connectionState } from "./state.js";
import { hiddenAgent } from "./hiding.js";

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
  const response = await fetch(`${connection.apiUrl}${path}`, {
    headers: { Authorization: `Bearer ${connection.token}`, ...(workspace ? { "X-Workspace-Slug": workspace.slug } : {}) },
    redirect: "error", signal: AbortSignal.timeout(10_000),
  });
  if (!response.ok) { await response.body?.cancel(); throw new Error(`Multica read failed (HTTP ${response.status})`); }
  return schema.parse(await response.json());
}

export class SidebarSynchronizer {
  private pending: Promise<unknown> = Promise.resolve();
  private host?: NativeHost;
  private syncPending?: Promise<void>;
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
    store: StateStore; connection: () => Promise<AuthenticatedConnection>;
    connectHost: () => Promise<NativeHost>; intervalMs: number; onRemoteEvent?: (event: WorkspaceEvent) => void;
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
      const operation = this.serialize(() => this.sync());
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
  enable(paseo: PaseoApi, workspaceId: string, enabled: boolean): Promise<void> {
    return this.serialize(async () => {
      const connection = await this.options.connection();
      const workspace = (await this.workspaces(connection)).find(item => item.id === workspaceId);
      if (!workspace) throw new Error("Multica workspace unavailable");
      await this.options.store.update(state => {
        const rules = connectionState(state, connection.connectionKey).rules;
        rules[workspaceId] = { ...taskRuleSchema.parse(rules[workspaceId] ?? {}), enabled };
      });
    }).then(() => this.bootstrap(paseo));
  }
  rule(paseo: PaseoApi, workspaceId: string, rule: TaskRule): Promise<void> {
    return this.serialize(async () => {
      const connection = await this.options.connection();
      if (!(await this.workspaces(connection)).some(item => item.id === workspaceId)) throw new Error("Multica workspace unavailable");
      await this.options.store.update(state => {
        const rules = connectionState(state, connection.connectionKey).rules;
        rules[workspaceId] = { ...rule, enabled: rules[workspaceId]?.enabled ?? false };
      });
    }).then(() => this.bootstrap(paseo));
  }
  private async archive(connectionKey: string, issueId: string, reason: "rule_disabled" | "filter_exit") {
    const issue = (await this.options.store.read()).connections[connectionKey].issues[issueId];
    if (!issue.workspaceCreated || issue.manualHidden.workspace || (issue.archiveReason && !issue.archivePending)) return;
    if (!issue.archiveReason) {
      const restoreAgents: string[] = [];
      let cursor: string | undefined;
      do {
        const page = await this.host!.fetchAgents({ filter: { labels: { "multica.connection": connectionKey, "multica.issue": issueId }, includeArchived: true }, page: { limit: 100, cursor } });
        restoreAgents.push(...page.entries.filter(item => item.agent.workspaceId === issue.workspaceId && !item.agent.archivedAt).map(item => item.agent.id));
        if (!page.pageInfo.hasMore) break;
        if (!page.pageInfo.nextCursor || page.pageInfo.nextCursor === cursor) throw new Error("Incomplete native agent pagination");
        cursor = page.pageInfo.nextCursor;
      } while (true);
      // Keep the pre-archive active set across response loss and restart.
      await this.options.store.update(state => {
        const mapping = state.connections[connectionKey].issues[issueId];
        mapping.archiveReason = reason;
        mapping.archivePending = true;
        mapping.ruleArchivedAgentIds = restoreAgents;
      });
    }
    const result = await this.host!.archiveWorkspace(issue.workspaceId);
    if (result.error) throw new Error("Native workspace archive failed");
    await this.options.store.update(state => { state.connections[connectionKey].issues[issueId].archivePending = false; });
  }

  private serialize(operation: () => Promise<void>) {
    const result = this.pending.then(async () => { if (this.closed) return; await operation(); });
    this.pending = result.catch(() => {});
    return result;
  }
  private async sync() {
    const connection = await this.options.connection();
    const state = await this.options.store.read();
    const local = state.connections[connection.connectionKey];
    const enabled = Object.entries(local?.rules ?? {}).filter(([, rule]) => rule.enabled);
    const disabledIssues = Object.entries(local?.issues ?? {}).filter(([, issue]) =>
      local?.rules[issue.remoteWorkspaceId]?.enabled === false && (!issue.archiveReason || issue.archivePending));
    if (!enabled.length && !disabledIssues.length) { this.events.reconcile(connection, []); return; }
    const workspaces = enabled.length ? await this.workspaces(connection) : [];
    this.events.reconcile(connection, workspaces.filter(workspace => local?.rules[workspace.id]?.enabled));
    if (!this.host) this.host = await this.options.connectHost();
    if ((await this.host.listHosts()).self.serverId !== this.expectedServerId) throw new Error("Native host is not the owning daemon");
    for (const [issueId] of disabledIssues) await this.archive(connection.connectionKey, issueId, "rule_disabled");
    for (const [workspaceId, rule] of enabled) {
      const workspace = workspaces.find(item => item.id === workspaceId);
      if (!workspace) continue;
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
        if (mapping.remoteWorkspaceId === workspaceId && !matchingIds.has(issueId)) await this.archive(connection.connectionKey, issueId, "filter_exit");
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
        const title = [issue.identifier, issue.title].filter(Boolean).join(" ");
        const cwd = local?.issues[issue.id]?.cwd ?? join(projectDirectory, stableId(issue.id).slice(0, 20));
        await mkdir(cwd, { recursive: true });
        // Persist intent before native creation. A retry uses the same valid native ID.
        await this.options.store.update(state => {
          const local = connectionState(state, connection.connectionKey);
          local.issues[issue.id] = { ...local.issues[issue.id], remoteWorkspaceId: workspaceId,
            workspaceId: local.issues[issue.id]?.workspaceId ?? `wks_${stableId(connection.connectionKey, issue.id).slice(0, 16)}`,
            workspaceCreated: local.issues[issue.id]?.workspaceCreated ?? false,
            commentSourceTaskIds: local.issues[issue.id]?.commentSourceTaskIds ?? {},
            runs: local.issues[issue.id]?.runs ?? {}, runDetails: local.issues[issue.id]?.runDetails ?? {}, commentCreatedAt: local.issues[issue.id]?.commentCreatedAt ?? {},
            manualHidden: local.issues[issue.id]?.manualHidden ?? { workspace: false, discussions: [] },
            threads: local.issues[issue.id]?.threads ?? {}, commentRoots: local.issues[issue.id]?.commentRoots ?? {}, unresolvedCommentIds: local.issues[issue.id]?.unresolvedCommentIds ?? [],
            systemRootIds: local.issues[issue.id]?.systemRootIds ?? [], mainHistory: local.issues[issue.id]?.mainHistory ?? { title: "主讨论", historyLoaded: false, rows: [], observed: {} },
            ruleArchivedAgentIds: local.issues[issue.id]?.ruleArchivedAgentIds ?? [], archivePending: local.issues[issue.id]?.archivePending ?? false, cwd, title, description: issue.description ?? "", updatedAt: issue.updated_at };
        });
        const mapping = (await this.options.store.read()).connections[connection.connectionKey].issues[issue.id];
        if (mapping.manualHidden.workspace) continue;
        if (mapping.archiveReason) {
          await ensureWorkspaceActive(this.host, mapping.workspaceId);
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
          let cursor: string | undefined;
          do {
            const page = await this.host.fetchAgents({ filter: { labels, includeArchived: true }, page: { limit: 100, cursor } });
            mainAgentId = page.entries.find(entry => entry.agent.workspaceId === mapping.workspaceId && Object.entries(labels).every(([key, value]) => entry.agent.labels[key] === value))?.agent.id;
            if (mainAgentId || !page.pageInfo.hasMore) break;
            if (!page.pageInfo.nextCursor || page.pageInfo.nextCursor === cursor) throw new Error("Incomplete native agent pagination");
            cursor = page.pageInfo.nextCursor;
          } while (true);
          if (!mainAgentId) {
            mainAgentId = (await this.host.importAgent({ providerId, providerHandleId: `plugin:${JSON.stringify(mainPersistence(connection.connectionKey, issue.id))}`,
              cwd, workspaceId: mapping.workspaceId, labels })).id;
          }
          await this.options.store.update(state => { state.connections[connection.connectionKey].issues[issue.id].mainAgentId = mainAgentId; });
        }
        if (mainAgentId && !mapping.manualHidden.discussions.includes("main")) await this.host.updateAgent(mainAgentId, { name: "主讨论" });
        await this.options.onIssue?.(connection, workspace, issue.id, this.host);
      }
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
