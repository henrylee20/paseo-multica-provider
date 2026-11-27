import { z } from "zod";
import type { TaskRule } from "../shared/contracts.js";
import { remoteFetch, type AuthenticatedConnection } from "./connection.js";
import { issueQuery } from "./filters.js";

export const workspaceSchema = z.object({ id: z.string().min(1), name: z.string(), slug: z.string().min(1) });
const overviewText = z.string().trim().min(1).optional().catch(undefined);
export const remoteIssueSchema = z.object({ id: z.string().min(1), workspace_id: z.string(), title: z.string(),
  description: z.string().nullish(), updated_at: z.string().optional(),
  identifier: overviewText, status: overviewText, status_name: overviewText, status_category: overviewText,
  priority: z.enum(["urgent", "high", "medium", "low", "none"]).optional().catch(undefined),
  assignee_type: z.enum(["member", "agent", "squad"]).optional().catch(undefined), assignee_id: overviewText, project_id: overviewText,
  due_date: z.iso.date().optional().catch(undefined),
  labels: z.array(z.object({ name: z.string().trim().min(1) })).optional().catch(undefined),
});
export const pageSchema = z.object({ issues: z.array(remoteIssueSchema), total: z.number().int().nonnegative() });
// These requests live only for this snapshot (or an explicit Thread open).
export type RemoteWorkspace = z.infer<typeof workspaceSchema> & {
  agents?: Promise<Array<{ id: string; name: string; archived_at?: string | null }>>;
  members?: Promise<Array<{ user_id: string; name: string }>>;
  squads?: Promise<Array<{ id: string; name: string }>>;
  projects?: Promise<{ projects: Array<{ id: string; title: string }> }>;
  statuses?: Promise<{ statuses: Array<{ key: string; name: string; category: string }> }>;
};

export function workspaceHeaders(workspace: RemoteWorkspace) {
  return { "X-Workspace-Slug": workspace.slug };
}

export async function remoteJson(connection: AuthenticatedConnection, path: string, schema: z.ZodType, workspace?: RemoteWorkspace, signal?: AbortSignal, toleratedStatuses?: readonly number[]) {
  const response = await remoteFetch(connection, path, { headers: workspace ? workspaceHeaders(workspace) : {}, signal });
  if (!response.ok) {
    await response.body?.cancel();
    if (toleratedStatuses?.includes(response.status)) return { unavailable: response.status };
    throw new Error(`Multica read failed (HTTP ${response.status})`);
  }
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
export function workspaceSquads(connection: AuthenticatedConnection, workspace: RemoteWorkspace) {
  return workspace.squads ??= remoteJson(connection, "/api/squads", z.array(z.object({ id: z.string(), name: z.string() })), workspace) as NonNullable<RemoteWorkspace["squads"]>;
}
export function workspaceProjects(connection: AuthenticatedConnection, workspace: RemoteWorkspace) {
  return workspace.projects ??= remoteJson(connection, "/api/projects?include_archived=true",
    z.object({ projects: z.array(z.object({ id: z.string(), title: z.string() })) }), workspace) as NonNullable<RemoteWorkspace["projects"]>;
}
export function workspaceStatuses(connection: AuthenticatedConnection, workspace: RemoteWorkspace) {
  return workspace.statuses ??= remoteJson(connection, "/api/issue-statuses?include_archived=true",
    z.object({ statuses: z.array(z.object({ key: z.string(), name: z.string(), category: z.string() })) }), workspace) as NonNullable<RemoteWorkspace["statuses"]>;
}

export async function workspaces(connection: AuthenticatedConnection, signal?: AbortSignal): Promise<RemoteWorkspace[]> {
  return await remoteJson(connection, "/api/workspaces", z.array(workspaceSchema), undefined, signal) as RemoteWorkspace[];
}
export async function issuePage(connection: AuthenticatedConnection, workspace: RemoteWorkspace, query: URLSearchParams, signal?: AbortSignal) {
  const page = await remoteJson(connection, `/api/issues?${query}`, pageSchema, workspace, signal) as z.infer<typeof pageSchema>;
  if (page.issues.some(issue => issue.workspace_id !== workspace.id)) throw new Error("Issue belongs to a different workspace");
  return page;
}
export async function supportsIssueIds(connection: AuthenticatedConnection, workspace: RemoteWorkspace, signal: AbortSignal): Promise<boolean> {
  const response = await remoteFetch(connection, "/api/issues?limit=1&offset=0&ids=", { headers: workspaceHeaders(workspace), signal });
  if (!response.ok) {
    await response.body?.cancel();
    if (response.status === 400 || response.status === 422) return false;
    throw new Error(`Multica read failed (HTTP ${response.status})`);
  }
  const page = pageSchema.parse(await response.json());
  if (page.issues.some(issue => issue.workspace_id !== workspace.id)) throw new Error("Issue belongs to a different workspace");
  return page.total === 0 && page.issues.length === 0;
}
export async function matchingIssues(connection: AuthenticatedConnection, workspace: RemoteWorkspace, rule: TaskRule, signal?: AbortSignal, shouldStop?: () => boolean) {
  const issues: z.infer<typeof remoteIssueSchema>[] = [];
  let offset = 0;
  for (;;) {
    if (shouldStop?.()) return issues;
    const query = issueQuery(rule, offset);
    const page = await issuePage(connection, workspace, query, signal);
    issues.push(...page.issues);
    offset += page.issues.length;
    if (offset >= page.total) break;
    if (!page.issues.length) throw new Error("Incomplete issue pagination");
  }
  return issues;
}
