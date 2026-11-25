import { defineRpc } from "@getpaseo/plugin";
import { z } from "zod";

export const taskDescriptionKind = "task-description";
export const taskDescriptionVersion = 1;
export const taskDescriptionSchema = z.object({
  connectionKey: z.string(), issueId: z.string(), revision: z.string(), preview: z.string(), truncated: z.boolean(),
});
export const readTaskDescription = defineRpc({ name: "description.read",
  input: z.object({ connectionKey: z.string(), issueId: z.string(), revision: z.string(), offset: z.number().int().min(0) }),
  output: z.object({ text: z.string(), nextOffset: z.number().int().min(0).nullable() }),
});

export const observeTaskDescription = defineRpc({ name: "description.observe",
  input: z.object({ connectionKey: z.string(), issueId: z.string() }), output: taskDescriptionSchema,
});
