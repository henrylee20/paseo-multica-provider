import { defineRpc } from "@getpaseo/plugin";
import { z } from "zod";

export const hiddenObjectsSchema = z.array(z.object({
  connectionKey: z.string(), issueId: z.string(), workspaceId: z.string(), title: z.string(), cwd: z.string(),
  kind: z.enum(["workspace", "main", "thread"]), rootId: z.string().optional(), agentId: z.string().optional(),
}));
export type HiddenObject = z.output<typeof hiddenObjectsSchema>[number];
export const hiddenRestore = defineRpc({ name: "hidden.restore", input: z.object({
  connectionKey: z.string(), issueId: z.string(), rootId: z.string().optional(),
}), output: z.object({ status: z.enum(["ready", "unavailable"]), message: z.string().optional() }) });
