import { defineRpc } from "@getpaseo/plugin";
import { z } from "zod";
import { runStatusSchema } from "./runs.js";
const scope = z.object({ connectionKey: z.string().min(1) });
export const rebuildBlockerSchema = z.object({ issueId: z.string(), title: z.string(), rootId: z.string(), discussion: z.string(), runs: z.array(z.object({
  runId: z.string(), agentName: z.string(), status: runStatusSchema,
  verification: z.enum(["active", "unconfirmable", "failed"]), reason: z.string().optional(),
})) });
export const rebuildProgressSchema = z.object({
  status: z.enum(["idle", "running", "completed", "failed"]), stage: z.enum(["deleting", "importing"]),
  step: z.string(), completed: z.number().int().nonnegative(), total: z.number().int().nonnegative(), message: z.string().optional(),
});
export type RebuildProgress = z.infer<typeof rebuildProgressSchema>;
export type RebuildBlocker = z.infer<typeof rebuildBlockerSchema>;
export const rebuildPreflight = defineRpc({ name: "rebuild.preflight", input: scope, output: z.object({ projects: z.number(), workspaces: z.number(), discussions: z.number(), blockers: z.array(rebuildBlockerSchema) }) });
export const rebuildStart = defineRpc({ name: "rebuild.start", input: scope.extend({ acknowledgedRunIds: z.array(z.string()).default([]) }), output: z.object({ started: z.boolean(), blockers: z.array(rebuildBlockerSchema), progress: rebuildProgressSchema }) });
export const rebuildStatus = defineRpc({ name: "rebuild.status", input: scope, output: rebuildProgressSchema });
