import { z } from "zod";

export const runStatusSchema = z.enum(["queued", "dispatched", "running", "waiting_local_directory", "deferred", "completed", "failed", "cancelled"]);
export const isActiveRun = (status: z.infer<typeof runStatusSchema>) => ["queued", "dispatched", "running", "waiting_local_directory", "deferred"].includes(status);
// Preserve source values, including explicit null and empty strings. These can
// be arbitrarily large and belong in the Run subagent, never parent markers.
export const runMetadataSchema = z.object({
  error: z.string().nullish(), failure_reason: z.string().nullish(),
  work_dir: z.string().nullish(), relative_work_dir: z.string().nullish(),
});
export const runMessageSchema = z.object({
  task_id: z.string(), issue_id: z.string(), seq: z.number().int().nonnegative().safe(),
  type: z.enum(["text", "thinking", "tool_use", "tool_result", "error"]),
  call_id: z.string().optional(), tool: z.string().optional(), content: z.string().optional(),
  input: z.record(z.string(), z.unknown()).optional(), output: z.string().optional(),
  output_truncated: z.boolean().optional(), created_at: z.string().optional(), chat_session_id: z.string().optional(),
});
export type RunMessage = z.infer<typeof runMessageSchema>;
