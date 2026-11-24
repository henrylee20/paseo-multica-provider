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
const filterValue = z.string().trim().min(1).max(256).refine(value => !value.includes(","), "Filter values cannot include commas");
export const taskRuleSchema = z.object({
  statusCategories: z.array(z.enum(["unstarted", "started", "done", "closed"])).default(["unstarted", "started"]),
  statuses: z.array(filterValue).default([]),
  assignees: z.array(z.object({ type: z.enum(["member", "agent", "squad"]), id: filterValue })).default([]),
  projectIds: z.array(filterValue).default([]), labelIds: z.array(filterValue).default([]),
});
export type TaskRule = z.output<typeof taskRuleSchema>;
export const workspaceRule = defineRpc({ name: "workspace.rule", input: z.object({ workspaceId: z.string().min(1), rule: taskRuleSchema }), output: syncBootstrap.output });
const catalogItem = z.object({ id: z.string(), name: z.string() });
export const workspaceCatalog = defineRpc({ name: "workspace.catalog", input: z.object({ workspaceId: z.string().min(1) }), output: z.object({
  assignees: z.array(catalogItem.extend({ type: z.enum(["member", "agent", "squad"]) })),
  statuses: z.array(z.object({ key: z.string(), name: z.string(), category: z.string() })), projects: z.array(catalogItem), labels: z.array(catalogItem),
}) });
export const workspaceList = defineRpc({ name: "workspace.list", input: z.object({}), output: z.object({
  workspaces: z.array(z.object({ id: z.string(), name: z.string(), enabled: z.boolean(), rule: taskRuleSchema })),
}) });
export const workspaceEnable = defineRpc({ name: "workspace.enable", input: z.object({ workspaceId: z.string().min(1), enabled: z.boolean() }), output: syncBootstrap.output });

export const syncStatusSchema = z.object({
  status: z.enum(["idle", "syncing", "ready", "unavailable"]),
  stage: z.enum(["idle", "connection", "workspaces", "issues", "history"]),
  connectionKey: z.string().optional(), lastSuccessAt: z.string().optional(),
  completedWorkspaces: z.number().int().nonnegative(), enabledWorkspaces: z.number().int().nonnegative(),
  message: z.string().optional(),
});
export type SyncStatus = z.output<typeof syncStatusSchema>;
export const syncStatus = defineRpc({ name: "sync.status", input: z.object({}), output: syncStatusSchema });
