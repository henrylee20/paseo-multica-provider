import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { setTimeout } from "node:timers/promises";
import { createHostClient } from "@getpaseo/client/node";
import type { DaemonClient } from "@getpaseo/client/internal/daemon-client";
import { discussionKeys } from "../shared/discussion.js";
import { providerId } from "./discussion-identity.js";
import type { DiscussionLifecycle } from "./discussion-lifecycle.js";

/** These are the real low-level SDK methods, including explicit project placement. */
export type NativeHost = Pick<DaemonClient, "listHosts" | "addProject" | "renameProject" | "listProjects" | "removeProject" | "fetchWorkspaces" |
  "createWorkspace" | "setWorkspaceTitle" | "fetchAgents" | "importAgent" | "updateAgent" | "close" |
  "archiveWorkspace" | "restoreWorkspace" | "fetchAgent" | "archiveAgent" | "deleteAgent" | "refreshAgent" | "fetchAgentTimeline" | "listCommands">;

type DirectoryPage<T> = (cursor?: string) => Promise<{ entries: T[]; pageInfo: { hasMore: boolean; nextCursor?: string | null } }>;

export async function* directoryEntries<T>(page: DirectoryPage<T>, label: string): AsyncGenerator<T> {
  const seen = new Set<string>();
  let cursor: string | undefined;
  for (;;) {
    const result = await page(cursor);
    yield* result.entries;
    if (!result.pageInfo.hasMore) return;
    const next = result.pageInfo.nextCursor;
    if (!next || seen.has(next)) throw new Error(`Incomplete native ${label} pagination`);
    seen.add(next); cursor = next;
  }
}

export async function directory<T>(page: DirectoryPage<T>, label: string): Promise<T[]> {
  const entries: T[] = [];
  for await (const entry of directoryEntries(page, label)) entries.push(entry);
  return entries;
}

/** Directory filters are hints; prove the complete stable identity locally.
 * An incomplete/cyclic directory is never evidence that import is needed. */
export async function findNativeDiscussion(host: NativeHost, expected: { workspaceId: string; provider: string; labels: Record<string, string> }) {
  for await (const { agent } of directoryEntries(cursor => host.fetchAgents({ filter: { labels: expected.labels, includeArchived: true }, page: { limit: 100, cursor } }), "discussion")) {
    if (agent.workspaceId === expected.workspaceId && agent.provider === expected.provider &&
      Object.entries(expected.labels).every(([key, value]) => agent.labels[key] === value)) return agent;
  }
}

/** The native directory contains active workspaces, without an archivedAt field.
 * idPrefix is accepted but ignored by the host, so check exact IDs across pages. */
export async function findActiveWorkspace(host: NativeHost, workspaceId: string) {
  for await (const workspace of directoryEntries(cursor => host.fetchWorkspaces({ filter: { idPrefix: workspaceId }, page: { limit: 100, cursor } }), "workspace")) {
    if (workspace.id === workspaceId) return workspace;
  }
}

export async function fetchActiveWorkspaceIds(host: NativeHost): Promise<Set<string>> {
  return new Set((await directory(cursor => host.fetchWorkspaces({ page: { limit: 100, cursor } }), "workspace")).map(workspace => workspace.id));
}

export async function ensureWorkspaceActive(host: NativeHost, workspaceId: string) {
  if (!await findActiveWorkspace(host, workspaceId)) await host.restoreWorkspace(workspaceId);
}

/** removeProject also archives active children: prove emptiness across every page. */
export async function projectHasActiveWorkspaces(host: NativeHost, projectId: string) {
  for await (const workspace of directoryEntries(cursor => host.fetchWorkspaces({ page: { limit: 100, cursor } }), "workspace")) {
    if (workspace.projectId === projectId) return true;
  }
  return false;
}

/** Reimport an archived handle to move its original agent, preserving native
 * history and cwd. A rebuilt Project cannot reuse an old workspace ID. */
export async function restoreMappedDiscussion(host: NativeHost, lifecycle: DiscussionLifecycle, agentId: string,
  expected: { workspaceId: string; cwd: string }, address: { connectionKey: string; issueId: string }) {
  const agent = (await host.fetchAgent(agentId))?.agent;
  if (!agent || agent.cwd !== expected.cwd) throw new Error("Mapped native discussion unavailable");
  if (agent.workspaceId !== expected.workspaceId) {
    const rootId = agent.labels[discussionKeys.discussion];
    if (agent.provider !== providerId || !agent.workspaceId || !rootId || agent.labels[discussionKeys.connection] !== address.connectionKey ||
      agent.labels[discussionKeys.issue] !== address.issueId || !agent.persistence?.sessionId.startsWith("plugin:"))
      throw new Error("Mapped native discussion cannot be moved");
    // A native history query may have reopened the retired agent. Close its
    // local activity before archiving, so migration cannot interrupt a remote Run.
    const release = await lifecycle.hold([{ ...address, rootId }]);
    try { await archiveClosedDiscussion(host, agentId, { cwd: expected.cwd, workspaceId: agent.workspaceId }); }
    finally { release(); }
    const imported = await host.importAgent({ providerId, providerHandleId: agent.persistence.sessionId,
      cwd: expected.cwd, workspaceId: expected.workspaceId, labels: agent.labels });
    if (imported.id !== agentId) throw new Error("Native discussion identity changed");
  } else if (agent.archivedAt) await host.refreshAgent(agentId);
}

/** Caller must keep this discussion's provider resource closed and reject new
 * opens throughout. Observe host event settlement before its archive command,
 * which would otherwise interrupt a running native projection. */
export async function archiveClosedDiscussion(host: NativeHost, agentId: string, expected: { workspaceId: string; cwd: string }) {
  const deadline = Date.now() + 5000;
  for (;;) {
    const snapshot = (await host.fetchAgent(agentId))?.agent;
    if (!snapshot || snapshot.workspaceId !== expected.workspaceId || snapshot.cwd !== expected.cwd) throw new Error("Mapped native discussion unavailable");
    if (snapshot.archivedAt) return;
    if (snapshot.provider !== providerId) throw new Error("Mapped native discussion unavailable");
    if (["idle", "closed", "error"].includes(snapshot.status) && !snapshot.activeTurn) {
      await host.archiveAgent(agentId);
      if (!(await host.fetchAgent(agentId))?.agent.archivedAt) throw new Error("Native discussion archive not confirmed");
      return;
    }
    if (Date.now() >= deadline) throw new Error("Native discussion close not confirmed");
    await setTimeout(20);
  }
}

export async function connectNativeHost(paseoHome: string): Promise<NativeHost> {
  if (!paseoHome) throw new Error("Owning daemon PASEO_HOME is required");
  const metadata = JSON.parse(await readFile(join(paseoHome, "paseo.pid"), "utf8"));
  if (typeof metadata.listen !== "string" || !metadata.listen.trim()) throw new Error("Owning daemon listener unavailable");
  // The plugin process inherits its owning daemon's PASEO_HOME. Ignore PASEO_HOST.
  // A stale PID is not grounds to reject a live authenticated listener.
  const client = createHostClient(metadata.listen, {
    clientId: "multica-sidebar-sync", clientType: "cli", appVersion: "0.15.4",
    localCredential: async () => (await readFile(join(paseoHome, "local-credential"), "utf8")).trim(),
    reconnect: { enabled: true }, connectTimeoutMs: 10_000,
  });
  try { await client.connect(); return client; }
  catch (error) { await client.close(); throw error; }
}
