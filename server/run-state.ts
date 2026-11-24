import { z } from "zod";
import { runStatusSchema } from "../shared/runs.js";

export const storedRunSchema = z.object({
  agentId: z.string(), agentName: z.string(), status: runStatusSchema,
  ownerRootId: z.string().optional(),
  // Remote coverage changes independently from the permanent display owner.
  triggerCommentId: z.string().nullish(), coalescedCommentIds: z.array(z.string()),
  deliveredCommentIds: z.array(z.string()).optional(), supplementCommentIds: z.array(z.string()),
  createdAt: z.string().optional(), startedAt: z.string().optional(), completedAt: z.string().optional(),
});
export type StoredRun = z.infer<typeof storedRunSchema>;
