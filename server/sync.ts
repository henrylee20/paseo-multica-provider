import { createHash } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import type { PaseoApi } from "@getpaseo/client";
import { z } from "zod";
import type { AuthenticatedConnection } from "./connection.js";
import type { NativeHost } from "./native-host.js";
import { StateStore, connectionState } from "./state.js";

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
  private expectedServerId?: string;
  private timer?: ReturnType<typeof setInterval>;
  private closed = false;
  constructor(private readonly options: {
    store: StateStore; connection: () => Promise<AuthenticatedConnection>;
    connectHost: () => Promise<NativeHost>; intervalMs: number;
  }) {}

  async workspaces(connection: AuthenticatedConnection): Promise<RemoteWorkspace[]> {
    return await remoteJson(connection, "/api/workspaces", z.array(workspaceSchema)) as RemoteWorkspace[];
  }
  bootstrap(paseo: PaseoApi): Promise<void> {
    return this.serialize(async () => {
      const serverId = (await paseo.hosts.list()).self.serverId;
      if (this.expectedServerId && this.expectedServerId !== serverId) throw new Error("Bootstrap daemon identity changed");
      this.expectedServerId = serverId;
      await this.sync();
      if (!this.closed && !this.timer) {
        this.timer = setInterval(() => { void this.serialize(() => this.sync()).catch(() => {}); }, this.options.intervalMs);
        this.timer.unref?.();
      }
    });
  }
  enable(paseo: PaseoApi, workspaceId: string, enabled: boolean): Promise<void> {
    return this.serialize(async () => {
      const connection = await this.options.connection();
      const workspace = (await this.workspaces(connection)).find(item => item.id === workspaceId);
      if (!workspace) throw new Error("Multica workspace unavailable");
      await this.options.store.update(state => {
        const rules = connectionState(state, connection.connectionKey).rules;
        rules[workspaceId] = { enabled, statusCategories: [...defaultStatusCategories] };
      });
    }).then(() => this.bootstrap(paseo));
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
      local?.rules[issue.remoteWorkspaceId]?.enabled === false && !issue.archiveReason);
    if (!enabled.length && !disabledIssues.length) return;
    const workspaces = enabled.length ? await this.workspaces(connection) : [];
    if (!this.host) this.host = await this.options.connectHost();
    if ((await this.host.listHosts()).self.serverId !== this.expectedServerId) throw new Error("Native host is not the owning daemon");
    for (const [issueId, issue] of disabledIssues) {
      const main = issue.mainAgentId ? await this.host.fetchAgent(issue.mainAgentId) : null;
      const restoreAgents = main?.agent && !main.agent.archivedAt ? [main.agent.id] : [];
      // Record automatic lifecycle intent before the host emits archive/close events.
      await this.options.store.update(state => {
        const mapping = state.connections[connection.connectionKey].issues[issueId];
        mapping.archiveReason = "rule_disabled";
        mapping.ruleArchivedAgentIds = restoreAgents;
      });
      try {
        const result = await this.host.archiveWorkspace(issue.workspaceId);
        if (result.error) throw new Error("Native workspace archive failed");
      } catch (error) {
        await this.options.store.update(state => { delete state.connections[connection.connectionKey].issues[issueId].archiveReason; });
        throw error;
      }
    }
    for (const [workspaceId, rule] of enabled) {
      const workspace = workspaces.find(item => item.id === workspaceId);
      if (!workspace) continue;
      const issues: z.infer<typeof issueSchema>[] = [];
      let offset = 0;
      for (;;) {
        const query = new URLSearchParams({ limit: "100", offset: String(offset), status_categories: rule.statusCategories.join(",") });
        const page = await remoteJson(connection, `/api/issues?${query}`, pageSchema, workspace) as z.infer<typeof pageSchema>;
        if (page.issues.some(issue => issue.workspace_id !== workspaceId)) throw new Error("Issue belongs to a different workspace");
        issues.push(...page.issues);
        offset += page.issues.length;
        if (offset >= page.total) break;
        if (!page.issues.length) throw new Error("Incomplete issue pagination");
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
            ruleArchivedAgentIds: local.issues[issue.id]?.ruleArchivedAgentIds ?? [], cwd, title, description: issue.description ?? "", updatedAt: issue.updated_at };
        });
        const mapping = (await this.options.store.read()).connections[connection.connectionKey].issues[issue.id];
        if (mapping.archiveReason === "rule_disabled") {
          await this.host.restoreWorkspace(mapping.workspaceId);
          for (const agentId of mapping.ruleArchivedAgentIds) {
            const existing = await this.host.fetchAgent(agentId);
            // refreshAgent interrupts a live agent; use it only for archived records.
            if (existing?.agent.archivedAt) await this.host.refreshAgent(agentId);
          }
          await this.options.store.update(state => {
            const saved = state.connections[connection.connectionKey].issues[issue.id];
            delete saved.archiveReason;
            saved.ruleArchivedAgentIds = [];
          });
        }
        if (!mapping.workspaceCreated) {
          const existing = await this.host.fetchWorkspaces({ filter: { idPrefix: mapping.workspaceId }, page: { limit: 100 } });
          if (!existing.entries.some(item => item.id === mapping.workspaceId)) {
            const result = await this.host.createWorkspace({ source: { kind: "directory", path: cwd, projectId }, title,
              workspaceId: mapping.workspaceId, idempotencyKey: `multica:${connection.connectionKey}:${issue.id}` });
            if (result.error || result.workspace?.id !== mapping.workspaceId) throw new Error("Native workspace creation failed");
          }
          await this.options.store.update(state => { state.connections[connection.connectionKey].issues[issue.id].workspaceCreated = true; });
        }
        await this.host.setWorkspaceTitle(mapping.workspaceId, title);
        let mainAgentId = mapping.mainAgentId;
        if (!mainAgentId) {
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
        await this.host.updateAgent(mainAgentId, { name: "主讨论" });
      }
    }
  }
  close() {
    this.closed = true;
    if (this.timer) clearInterval(this.timer);
    void this.pending.then(() => this.host?.close()).catch(() => {});
  }
}
