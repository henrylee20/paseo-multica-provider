import { defineRpc } from "@getpaseo/plugin";
import { z } from "zod";

export const deliveryAddress = z.object({ connectionKey: z.string(), issueId: z.string(), rootId: z.string(), clientMessageId: z.string() });
export const deliverySummary = deliveryAddress.extend({
  parentCommentId: z.string().optional(), askuserAnswerTo: z.string().optional(),
  retryOf: z.string().optional(), idempotencyKey: z.string(), body: z.string(), truncated: z.boolean().default(false), createdAt: z.string(),
  status: z.enum(["received", "saved", "failed", "pending_verification"]), commentId: z.string().optional(), threadRootId: z.string().optional(), threadAgentId: z.string().optional(), message: z.string().optional(),
});
export const deliveryList = defineRpc({ name: "delivery.list", input: z.object({}), output: z.object({ records: z.array(deliverySummary) }) });
export const deliveryRead = defineRpc({ name: "delivery.read", input: deliveryAddress.extend({ offset: z.number().int().nonnegative() }),
  output: z.object({ text: z.string(), nextOffset: z.number().nullable() }) });
export const deliveryMentions = defineRpc({ name: "delivery.mentions", input: z.object({ connectionKey: z.string(), issueId: z.string() }),
  output: z.object({ agents: z.array(z.object({ id: z.string(), name: z.string(), reference: z.string() })) }) });
export const deliveryTargets = defineRpc({ name: "delivery.targets", input: z.object({}), output: z.object({ issues: z.array(z.object({ connectionKey: z.string(), issueId: z.string(), title: z.string() })) }) });

/** A receipt check never posts. A resend requires an explicit duplicate-risk decision. */
export const deliveryVerify = defineRpc({ name: "delivery.verify", input: deliveryAddress,
  output: z.object({ status: z.enum(["saved", "pending_verification"]), message: z.string().optional() }) });
export const deliveryResend = defineRpc({ name: "delivery.resend", input: deliveryAddress.extend({ requestId: z.string().min(1).max(255), acknowledgeDuplicateRisk: z.literal(true) }),
  output: z.object({ clientMessageId: z.string(), idempotencyKey: z.string() }) });
