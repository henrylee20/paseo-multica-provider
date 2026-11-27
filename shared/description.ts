import { defineRpc } from "@getpaseo/plugin";
import { z } from "zod";

export const taskDescriptionKind = "task-description";
export const taskDescriptionVersion = 1;
export const taskOverviewSchema = z.object({
  identifier: z.string().optional(), statusKey: z.string().optional(), statusName: z.string().optional(), statusCategory: z.string().optional(),
  priority: z.enum(["urgent", "high", "medium", "low", "none"]).optional(),
  assigneeType: z.enum(["member", "agent", "squad"]).optional(), assigneeId: z.string().optional(), assigneeName: z.string().optional(),
  projectId: z.string().optional(), projectName: z.string().optional(), labels: z.array(z.string()).optional(),
  dueDate: z.iso.date().optional(), url: z.url().refine(value => /^https?:\/\//i.test(value)).optional(),
});
export const taskDescriptionSchema = z.object({
  connectionKey: z.string(), issueId: z.string(), revision: z.string(), preview: z.string(), truncated: z.boolean(),
  overview: taskOverviewSchema.optional().catch(undefined),
});
export const readTaskDescription = defineRpc({ name: "description.read",
  input: z.object({ connectionKey: z.string(), issueId: z.string(), revision: z.string(), offset: z.number().int().min(0) }),
  output: z.object({ text: z.string(), nextOffset: z.number().int().min(0).nullable() }),
});
