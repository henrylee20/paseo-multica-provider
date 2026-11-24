import { defineRpc } from "@getpaseo/plugin";
import { z } from "zod";

export const hiddenList = defineRpc({ name: "hidden.list", input: z.object({}), output: z.object({ objects: z.array(z.object({
  connectionKey: z.string(), issueId: z.string(), workspaceId: z.string(), title: z.string(), cwd: z.string(),
  kind: z.enum(["workspace", "main", "thread"]), rootId: z.string().optional(), agentId: z.string().optional(),
})) }) });
export const hiddenRestore = defineRpc({ name: "hidden.restore", input: z.object({
  connectionKey: z.string(), issueId: z.string(), rootId: z.string().optional(),
}), output: z.object({ status: z.enum(["ready", "unavailable"]), message: z.string().optional() }) });
