import { defineRpc } from "@getpaseo/plugin";
import { threadAddress } from "./threads.js";
import { z } from "zod";

export const runStatusSchema = z.enum(["queued", "dispatched", "running", "waiting_local_directory", "deferred", "completed", "failed", "cancelled"]);
// Preserve source values, including explicit null and empty strings. These can
// be arbitrarily large and belong in paged cached reads, never native rows.
export const runMetadataSchema = z.object({
  error: z.string().nullish(), failure_reason: z.string().nullish(),
  work_dir: z.string().nullish(), relative_work_dir: z.string().nullish(),
});
export type RunMetadata = z.infer<typeof runMetadataSchema>;
export const runSummarySchema = z.object({
  connectionKey: z.string().max(256), issueId: z.string().max(256), rootId: z.string().max(256), runId: z.string().max(256),
  agentId: z.string().max(256), agentName: z.string().max(2000), status: runStatusSchema,
  createdAt: z.string().max(128).optional(), startedAt: z.string().max(128).optional(), completedAt: z.string().max(128).optional(),
});

export const runObserve = defineRpc({ name: "run.observe", input: threadAddress, output: z.object({ status: z.enum(["ready", "unavailable"]) }) });

export const runMessageSchema = z.object({
  task_id: z.string(), issue_id: z.string(), seq: z.number().int().nonnegative().safe(),
  type: z.enum(["text", "thinking", "tool_use", "tool_result", "error"]),
  call_id: z.string().optional(), tool: z.string().optional(), content: z.string().optional(),
  input: z.record(z.string(), z.unknown()).optional(), output: z.string().optional(),
  output_truncated: z.boolean().optional(), created_at: z.string().optional(), chat_session_id: z.string().optional(),
});
export type RunMessage = z.infer<typeof runMessageSchema>;
export const runAddress = threadAddress.extend({ runId: z.string() });
export const runOpen = defineRpc({ name: "run.open", input: runAddress, output: z.object({
  status: z.enum(["ready", "cached", "unavailable"]), revision: z.string().optional(), metadataRevision: z.string().optional(), message: z.string().optional(),
}) });
// Detailed history is a versioned JSON stream, split below the native row/RPC
// budget even when one tool result is much larger than a single transport frame.
export const runRead = defineRpc({ name: "run.read", input: runAddress.extend({ revision: z.string(), offset: z.number().int().nonnegative() }),
  output: z.object({ text: z.string(), nextOffset: z.number().int().nonnegative().nullable() }) });
export const runMetadataRead = defineRpc({ name: "run.metadata.read", input: runRead.input, output: runRead.output });
