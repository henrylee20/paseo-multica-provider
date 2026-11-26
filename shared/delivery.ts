import { defineRpc } from "@getpaseo/plugin";
import { z } from "zod";

export const deliveredAttachment = z.object({
  id: z.string(), name: z.string(), mimeType: z.string(), size: z.number().int().nonnegative().optional(),
  url: z.url().refine(value => /^https?:\/\//i.test(value)).optional(),
});
export const deliverySummary = z.object({
  // Version 1's original {} payload remains the new-Thread hint.
  threadCreated: z.boolean().optional(), attachments: z.array(deliveredAttachment).max(10).optional(),
});
export const deliveryMentions = defineRpc({ name: "delivery.mentions", input: z.object({ connectionKey: z.string(), issueId: z.string() }),
  output: z.object({ agents: z.array(z.object({ id: z.string(), name: z.string(), reference: z.string() })) }) });
