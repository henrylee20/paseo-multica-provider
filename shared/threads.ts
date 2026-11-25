import { defineRpc } from "@getpaseo/plugin";
import { z } from "zod";

export const threadAddress = z.object({ connectionKey: z.string(), issueId: z.string(), rootId: z.string() });
export const commentDividerSchema = z.object({});
export const threadSummarySchema = threadAddress.extend({ title: z.string() });
export const threadOpen = defineRpc({ name: "thread.open", input: threadAddress, output: z.object({
  status: z.enum(["ready", "cached", "unavailable"]), message: z.string().optional(),
}) });

export const commentEventSchema = threadAddress.extend({
  recordId: z.string(), commentId: z.string(), category: z.enum(["system", "correction", "deletion", "source"]),
  text: z.string(), truncated: z.boolean(), sourceCreatedAt: z.string().optional(), sourceUpdatedAt: z.string().optional(),
});
export const commentEventDetail = defineRpc({ name: "thread.event", input: threadAddress.extend({ recordId: z.string() }), output: z.object({ text: z.string() }) });
