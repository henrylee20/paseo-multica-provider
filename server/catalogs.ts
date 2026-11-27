import { z } from "zod";
import type { AuthenticatedConnection } from "./connection.js";
import { remoteJson, workspaceAgents, workspaceMembers, workspaceProjects, workspaceSquads, workspaceStatuses, type RemoteWorkspace } from "./multica-api.js";

export async function workspaceCatalogs(connection: AuthenticatedConnection, workspace: RemoteWorkspace) {
  const label = z.object({ id: z.string(), name: z.string() });
  const [members, agents, squads, statuses, projects, labels] = await Promise.all([
    workspaceMembers(connection, workspace), workspaceAgents(connection, workspace),
    workspaceSquads(connection, workspace), workspaceStatuses(connection, workspace),
    workspaceProjects(connection, workspace),
    remoteJson(connection, "/api/labels?resource_type=issue", z.object({ labels: z.array(label) }), workspace) as Promise<{ labels: Array<z.output<typeof label>> }>,
  ]);
  return { assignees: [
    ...members.map(item => ({ type: "member" as const, id: item.user_id, name: item.name })),
    ...agents.map(item => ({ type: "agent" as const, id: item.id, name: item.name })), ...squads.map(item => ({ type: "squad" as const, id: item.id, name: item.name })),
  ], statuses: statuses.statuses, projects: projects.projects.map(item => ({ id: item.id, name: item.title })), labels: labels.labels };
}
