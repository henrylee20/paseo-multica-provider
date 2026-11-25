import { defineRpc } from "@getpaseo/plugin";
import { z } from "zod";

export const deliverySummary = z.object({});
export const deliveryMentions = defineRpc({ name: "delivery.mentions", input: z.object({ connectionKey: z.string(), issueId: z.string() }),
  output: z.object({ agents: z.array(z.object({ id: z.string(), name: z.string(), reference: z.string() })) }) });
