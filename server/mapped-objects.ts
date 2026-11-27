import { readdir, rm, rmdir } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { discussionKeys } from "../shared/discussion.js";
import { providerId } from "./discussion-identity.js";
import type { DiscussionLifecycle } from "./discussion-lifecycle.js";
import { directory, directoryEntries, type NativeHost } from "./native-host.js";
import type { RunAddress } from "./runs.js";
import type { ConnectionState } from "./state.js";

export interface MappedProject { projectId: string; root: string; name: string }
export interface MappedObjects {
  scope: string;
  discussions: string[];
  addresses: RunAddress[];
  workspaceIds: Set<string>;
  projects: MappedProject[];
  removableProjects: number;
}
export type TeardownStage = "delete" | "archive" | "remove" | "clean" | "reset";
export interface TeardownOptions {
  onStage?: (stage: TeardownStage) => void;
  reset: () => Promise<void>;
}

/** Discover the native Paseo objects owned by these Multica connections. */
export async function discoverMappedObjects(host: NativeHost, connections: Readonly<Record<string, ConnectionState>>, scope: string): Promise<MappedObjects> {
  const discussions = new Set<string>();
  const addresses = new Map<string, RunAddress>();
  const knownWorkspaces = new Set(Object.values(connections).flatMap(conn => Object.values(conn.issues).map(issue => issue.workspaceId)));
  for (const [connectionKey, conn] of Object.entries(connections)) {
    for await (const { agent } of directoryEntries(cursor => host.fetchAgents({ filter: { labels: { [discussionKeys.connection]: connectionKey }, includeArchived: true, includeBackground: true, includeInternal: true }, page: { limit: 100, cursor } }), "discussion")) {
      if (agent.provider !== providerId || agent.labels[discussionKeys.connection] !== connectionKey) continue;
      discussions.add(agent.id);
      if (agent.workspaceId) knownWorkspaces.add(agent.workspaceId);
      const issueId = agent.labels[discussionKeys.issue], rootId = agent.labels[discussionKeys.discussion];
      if (issueId && rootId) addresses.set(agent.id, { connectionKey, issueId, rootId });
    }
    for (const [issueId, issue] of Object.entries(conn.issues)) {
      const mapped = [{ rootId: "main", agentId: issue.mainAgentId },
        ...Object.entries(issue.threads).map(([rootId, thread]) => ({ rootId, agentId: thread.agentId }))];
      for (const { rootId, agentId } of mapped) {
        if (!agentId) continue;
        if (discussions.has(agentId)) {
          if (!addresses.has(agentId)) addresses.set(agentId, { connectionKey, issueId, rootId });
          continue;
        }
        const agent = (await host.fetchAgent(agentId))?.agent;
        if (agent?.provider === providerId && (agent.labels[discussionKeys.connection] === connectionKey || agent.cwd === issue.cwd)) {
          discussions.add(agentId);
          if (agent.workspaceId) knownWorkspaces.add(agent.workspaceId);
          addresses.set(agentId, { connectionKey, issueId, rootId });
        }
      }
    }
  }
  const active = await directory(cursor => host.fetchWorkspaces({ filter: { includeBackground: true, includeInternal: true }, page: { limit: 100, cursor } }), "workspace");
  const prefix = scope + sep;
  const workspaceIds = new Set(active.filter(workspace => knownWorkspaces.has(workspace.id) || workspace.workspaceDirectory?.startsWith(prefix)).map(workspace => workspace.id));
  const candidates = new Map<string, { cwd: string; name: string }>();
  for (const conn of Object.values(connections)) {
    for (const project of Object.values(conn.projects)) if (project.projectId) candidates.set(project.projectId, project);
    for (const issue of Object.values(conn.issues)) if (issue.projectId && !candidates.has(issue.projectId)) {
      const project = conn.projects[issue.remoteWorkspaceId];
      candidates.set(issue.projectId, { cwd: project?.cwd ?? resolve(issue.cwd, ".."), name: project?.name ?? issue.title });
    }
  }
  const nativeProjects = (await host.listProjects()).projects;
  for (const project of nativeProjects) if (project.projectKind === "non_git" && project.projectRootPath.startsWith(prefix)) {
    candidates.set(project.projectId, { cwd: project.projectRootPath,
      name: candidates.get(project.projectId)?.name ?? project.projectDisplayName ?? project.projectId });
  }
  const projects: MappedProject[] = [];
  for (const project of nativeProjects) {
    const cached = candidates.get(project.projectId);
    if (!cached || project.projectKind !== "non_git" || project.projectRootPath !== cached.cwd) continue;
    projects.push({ projectId: project.projectId, root: project.projectRootPath, name: cached.name });
  }
  const removableProjects = projects.filter(project => !active.some(workspace => workspace.projectId === project.projectId && !workspaceIds.has(workspace.id))).length;
  return { scope, discussions: [...discussions], addresses: [...addresses.values()], workspaceIds, projects, removableProjects };
}

/** Keep the local resource gate held through reset, including every failure path. */
export async function teardownMappedObjects(host: NativeHost, lifecycle: DiscussionLifecycle, found: MappedObjects, options: TeardownOptions): Promise<MappedProject[]> {
  const release = await lifecycle.hold(found.addresses);
  try {
    options.onStage?.("delete");
    for (const agentId of found.discussions) await host.deleteAgent(agentId);
    options.onStage?.("archive");
    for (const workspaceId of found.workspaceIds) {
      const result = await host.archiveWorkspace(workspaceId);
      if (result.error) throw new Error(result.error);
    }
    options.onStage?.("remove");
    const retained: MappedProject[] = [];
    for (const project of found.projects) {
      // A user may have created or archived a workspace since discovery.
      const active = await directory(cursor => host.fetchWorkspaces({ filter: { includeBackground: true, includeInternal: true }, page: { limit: 100, cursor } }), "workspace");
      if (active.some(workspace => workspace.projectId === project.projectId)) retained.push(project);
      else await host.removeProject(project.projectId);
    }
    options.onStage?.("clean");
    await removePlaceholderTree(found.scope, retained.map(project => project.root));
    options.onStage?.("reset");
    await options.reset();
    return retained;
  } finally { release(); }
}

export async function removePlaceholderTree(scope: string, preserved: readonly string[]) {
  const root = resolve(scope);
  const kept = preserved.map(directory => resolve(directory));
  const inside = (target: string) => { const path = relative(root, resolve(target)); return !!path && !path.startsWith("..") && !isAbsolute(path); };
  const clean = async (directory: string) => {
    if (kept.includes(directory)) return;
    for (const entry of await readdir(directory, { withFileTypes: true }).catch((error: NodeJS.ErrnoException) => { if (error.code === "ENOENT") return []; throw error; })) {
      const target = resolve(directory, entry.name);
      if (!inside(target)) throw new Error("Unsafe placeholder removal target");
      if (kept.includes(target)) continue;
      if (entry.isDirectory() && kept.some(path => path.startsWith(target + sep))) {
        await clean(target);
      } else await rm(target, { recursive: true, force: true });
    }
    await rmdir(directory).catch((error: NodeJS.ErrnoException) => { if (error.code !== "ENOENT" && error.code !== "ENOTEMPTY") throw error; });
  };
  await clean(root);
}
