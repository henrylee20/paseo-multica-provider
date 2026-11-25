import { z } from "zod";

export const storedRowSchema = z.object({
  id: z.string(), role: z.enum(["user", "assistant", "event"]), text: z.string(),
  commentId: z.string(), category: z.enum(["system", "correction", "deletion"]).optional(),
  clientMessageId: z.string().optional(),
  sourceCreatedAt: z.string().optional(), sourceUpdatedAt: z.string().optional(),
});
export type StoredRow = z.infer<typeof storedRowSchema>;
export const threadSchema = z.object({
  title: z.string(), agentId: z.string().optional(), historyLoaded: z.boolean().default(false),
  rows: z.array(storedRowSchema).default([]),
  observed: z.record(z.string(), z.object({ fingerprint: z.string(), deleted: z.boolean(), revision: z.number().optional(), updatedAt: z.string().optional() })).default({}),
});
