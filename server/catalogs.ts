import { z } from "zod";
import type { AuthenticatedConnection } from "./connection.js";
import { remoteJson, type RemoteWorkspace } from "./sync.js";

export async function workspaceCatalogs(connection: AuthenticatedConnection, workspace: RemoteWorkspace) {
  const name = z.string();
  const member = z.object({ user_id: z.string(), name });
  const agent = z.object({ id: z.string(), name });
  const status = z.object({ key: z.string(), name, category: z.string() });
  const project = z.object({ id: z.string(), title: z.string() });
  const label = z.object({ id: z.string(), name });
  const read = async <T extends z.ZodType>(path: string, schema: T): Promise<z.output<T>> =>
    await remoteJson(connection, path, schema, workspace) as z.output<T>;
  const [members, agents, squads, statuses, projects, labels] = await Promise.all([
    read(`/api/workspaces/${encodeURIComponent(workspace.id)}/members`, z.array(member)),
    read(`/api/agents?workspace_id=${encodeURIComponent(workspace.id)}&include_archived=true`, z.array(agent)),
    read("/api/squads", z.array(agent)), read("/api/issue-statuses?include_archived=true", z.object({ statuses: z.array(status) })),
    read("/api/projects?include_archived=true", z.object({ projects: z.array(project) })),
    read("/api/labels?resource_type=issue", z.object({ labels: z.array(label) })),
  ]);
  return { assignees: [
    ...members.map(item => ({ type: "member" as const, id: item.user_id, name: item.name })),
    ...agents.map(item => ({ ...item, type: "agent" as const })), ...squads.map(item => ({ ...item, type: "squad" as const })),
  ], statuses: statuses.statuses, projects: projects.projects.map(item => ({ id: item.id, name: item.title })), labels: labels.labels };
}
