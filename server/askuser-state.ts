import { z } from "zod";
import { askuserDocumentSchema, askuserAnswerSchema } from "../shared/askuser.js";

export const askuserAttachmentSchema = z.object({ document: askuserDocumentSchema.optional(), error: z.string().optional() });
export const storedAskuserCardSchema = z.object({ commentId: z.string(), attachmentId: z.string(), rootId: z.string(),
  status: z.enum(["pending", "answered", "skipped", "invalid"]), collapsed: z.boolean().optional(), deleted: z.boolean().optional(), statusError: z.string().optional(), answer: askuserAnswerSchema.optional(), skippedAt: z.string().optional(), skippedBy: z.string().optional() });
