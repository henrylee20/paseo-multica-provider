import { z } from "zod";

export const deliveryRecordSchema = z.object({
  connectionKey: z.string(), issueId: z.string(), rootId: z.string(), clientMessageId: z.string(),
  idempotencyKey: z.string(), body: z.string(), createdAt: z.string(), stopEpoch: z.number().int().nonnegative(),
  nativeDelivery: z.enum(["auto", "steer"]), status: z.enum(["received", "saved", "failed", "pending_verification"]),
  parentCommentId: z.string().optional(), askuserAnswerTo: z.string().optional(),
  remoteWorkspaceId: z.string().optional(), retryOf: z.string().optional(),
  recoveryHalted: z.boolean().optional(), retryCount: z.number().int().nonnegative().default(0),
  claimedAt: z.string().optional(), commentId: z.string().optional(), threadRootId: z.string().optional(), message: z.string().optional(),
  receipt: z.object({ authorId: z.string(), parentId: z.string().nullable(), createdAt: z.string().optional(), updatedAt: z.string().optional(),
    triggerOutcomes: z.array(z.object({ target_type: z.string(), target_id: z.string(), status: z.string(), reason_code: z.string().optional() })).optional() }).optional(),
});
export type DeliveryRecord = z.infer<typeof deliveryRecordSchema>;
