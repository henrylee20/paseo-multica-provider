import { z } from "zod";
import { runMetadataSchema, runStatusSchema } from "../shared/runs.js";

export const storedRunSchema = z.object({
  agentId: z.string(), agentName: z.string(), status: runStatusSchema,
  markerProjected: z.boolean().optional(),
  ownerRootId: z.string().optional(), triggerAuthor: z.string().optional(),
  // Remote coverage changes independently from the permanent display owner.
  triggerCommentId: z.string().nullish(), coalescedCommentIds: z.array(z.string()),
  generatedCommentIds: z.array(z.string()).default([]),
  deliveredCommentIds: z.array(z.string()).optional(), supplementCommentIds: z.array(z.string()),
  createdAt: z.string().optional(), startedAt: z.string().optional(), completedAt: z.string().optional(),
  metadata: runMetadataSchema.optional(),
});
export type StoredRun = z.infer<typeof storedRunSchema>;
