import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { createHostClient } from "@getpaseo/client/node";
import type { DaemonClient } from "@getpaseo/client/internal/daemon-client";

/** These are the real low-level SDK methods, including explicit project placement. */
export type NativeHost = Pick<DaemonClient, "listHosts" | "addProject" | "renameProject" | "fetchWorkspaces" |
  "createWorkspace" | "setWorkspaceTitle" | "fetchAgents" | "importAgent" | "updateAgent" | "close" |
  "archiveWorkspace" | "restoreWorkspace" | "fetchAgent" | "refreshAgent" | "fetchAgentTimeline">;

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
