import { defineRpc } from "@getpaseo/plugin";
import { threadAddress } from "./threads.js";
import { z } from "zod";

export const runStatusSchema = z.enum(["queued", "dispatched", "running", "waiting_local_directory", "deferred", "completed", "failed", "cancelled"]);
export const runSummarySchema = z.object({
  connectionKey: z.string().max(256), issueId: z.string().max(256), rootId: z.string().max(256), runId: z.string().max(256),
  agentId: z.string().max(256), agentName: z.string().max(2000), status: runStatusSchema,
  createdAt: z.string().max(128).optional(), startedAt: z.string().max(128).optional(), completedAt: z.string().max(128).optional(),
});

export const runObserve = defineRpc({ name: "run.observe", input: threadAddress, output: z.object({ status: z.enum(["ready", "unavailable"]) }) });
