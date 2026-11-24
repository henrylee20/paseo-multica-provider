import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { setTimeout } from "node:timers/promises";
import { createHostClient } from "@getpaseo/client/node";
import type { DaemonClient } from "@getpaseo/client/internal/daemon-client";

/** These are the real low-level SDK methods, including explicit project placement. */
export type NativeHost = Pick<DaemonClient, "listHosts" | "addProject" | "renameProject" | "fetchWorkspaces" |
  "createWorkspace" | "setWorkspaceTitle" | "fetchAgents" | "importAgent" | "updateAgent" | "close" |
  "archiveWorkspace" | "restoreWorkspace" | "fetchAgent" | "archiveAgent" | "refreshAgent" | "fetchAgentTimeline">;

/** The native directory contains active workspaces, without an archivedAt field.
 * idPrefix is accepted but ignored by the host, so check exact IDs across pages. */
export async function findActiveWorkspace(host: NativeHost, workspaceId: string) {
  let cursor: string | undefined;
  const cursors = new Set<string>();
  for (;;) {
    const page = await host.fetchWorkspaces({ filter: { idPrefix: workspaceId }, page: { limit: 100, cursor } });
    const workspace = page.entries.find(entry => entry.id === workspaceId);
    if (workspace) return workspace;
    if (!page.pageInfo.hasMore) return undefined;
    const next = page.pageInfo.nextCursor;
    if (!next || cursors.has(next)) throw new Error("Incomplete native workspace pagination");
    cursors.add(next);
    cursor = next;
  }
}

export async function ensureWorkspaceActive(host: NativeHost, workspaceId: string) {
  if (!await findActiveWorkspace(host, workspaceId)) await host.restoreWorkspace(workspaceId);
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
    if (snapshot.provider !== "multica") throw new Error("Mapped native discussion unavailable");
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
