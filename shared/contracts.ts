import { defineRpc, defineSettings } from "@getpaseo/plugin";
import { z } from "zod";

export const multicaSettings = defineSettings({
  id: "multica", scope: "host", version: 1,
  schema: z.object({ profile: z.string().trim().max(128).refine(value => value !== "." && value !== ".." && !/[\\/\u0000-\u001f]/.test(value), "Profile must be a single safe name").default("") }),
});

export const connectionStatusSchema = z.object({
  status: z.enum(["ready", "missing_config", "unreadable_config", "invalid_config", "not_logged_in", "authentication_failed", "offline", "isolated_context", "invalid_settings"]),
  profile: z.string(),
  configPath: z.string().optional(),
  apiUrl: z.string().optional(),
  appUrl: z.string().optional(),
  source: z.object({ api: z.enum(["config", "environment", "none"]), credentials: z.enum(["config", "environment", "none"]), app: z.enum(["config", "environment", "none"]) }),
  user: z.object({ id: z.string(), name: z.string(), email: z.string() }).optional(),
  connectionKey: z.string().optional(),
  message: z.string(),
  loginCommand: z.string(),
});
export type ConnectionStatus = z.output<typeof connectionStatusSchema>;
export const connectionStatus = defineRpc({ name: "connection.status", input: z.object({}), output: connectionStatusSchema });

export const syncBootstrap = defineRpc({ name: "sync.bootstrap", input: z.object({}), output: z.object({
  status: z.enum(["ready", "unavailable"]), message: z.string().optional(),
}) });
export const workspaceList = defineRpc({ name: "workspace.list", input: z.object({}), output: z.object({
  workspaces: z.array(z.object({ id: z.string(), name: z.string(), enabled: z.boolean() })),
}) });
export const workspaceEnable = defineRpc({ name: "workspace.enable", input: z.object({ workspaceId: z.string().min(1), enabled: z.boolean() }), output: syncBootstrap.output });
