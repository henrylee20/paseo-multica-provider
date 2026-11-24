import { z } from "zod";
import { runStatusSchema } from "../shared/runs.js";

export const stopRecordSchema = z.object({
  rootId: z.string(), stopId: z.string(), epoch: z.number().int().nonnegative(),
  attemptedAt: z.string(), status: runStatusSchema.optional(),
  cleanup: z.enum(["unknown", "pending", "confirmed", "unconfirmed"]),
  retryable: z.boolean(), message: z.string().optional(),
});
