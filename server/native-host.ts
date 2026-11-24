import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { createHostClient } from "@getpaseo/client/node";
import type { DaemonClient } from "@getpaseo/client/internal/daemon-client";

/** These are the real low-level SDK methods, including explicit project placement. */
export type NativeHost = Pick<DaemonClient, "listHosts" | "addProject" | "renameProject" | "fetchWorkspaces" |
  "createWorkspace" | "setWorkspaceTitle" | "fetchAgents" | "importAgent" | "updateAgent" | "close" |
  "archiveWorkspace" | "restoreWorkspace" | "fetchAgent" | "refreshAgent">;

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
