import { defineRpc } from "@getpaseo/plugin";
import { z } from "zod";
import { runStatusSchema } from "./runs.js";

export const stopList = defineRpc({ name: "stop.list", input: z.object({}), output: z.object({ records: z.array(z.object({
  connectionKey: z.string(), issueId: z.string(), rootId: z.string(), runId: z.string(), title: z.string(),
  status: runStatusSchema.optional(), cleanup: z.enum(["unknown", "pending", "confirmed", "unconfirmed"]),
  retryable: z.boolean(), message: z.string().optional(),
})) }) });
export const stopRetry = defineRpc({ name: "stop.retry", input: z.object({
  connectionKey: z.string(), issueId: z.string(), rootId: z.string(), runId: z.string(),
}), output: z.object({ status: z.enum(["ready", "unavailable"]), message: z.string().optional() }) });
