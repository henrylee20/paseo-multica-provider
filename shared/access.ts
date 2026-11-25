import { defineRpc } from "@getpaseo/plugin";
import { z } from "zod";
import { askuserCardSchema } from "./askuser.js";
import { runMetadataSchema, runMessageSchema } from "./runs.js";

export const issueAccessSchema = z.object({
  status: z.enum(["available", "inaccessible"]), reason: z.enum(["not_found", "forbidden"]).optional(),
  checkedAt: z.string().optional(), lastSuccessAt: z.string().optional(), objectVerifiedAt: z.string().optional(),
});
const address = z.object({ connectionKey: z.string(), issueId: z.string() });
export const issueHistoryList = defineRpc({ name: "issue.history.list", input: z.object({}), output: z.object({
  issues: z.array(address.extend({ title: z.string(), workspaceId: z.string(), ...issueAccessSchema.shape, revision: z.string() })),
}) });
export const issueHistoryRead = defineRpc({ name: "issue.history.read", input: address.extend({ revision: z.string(), offset: z.number().int().nonnegative() }),
  output: z.object({ text: z.string(), nextOffset: z.number().int().nonnegative().nullable() }) });
export const cachedIssueSnapshot = z.object({
  title: z.string(), description: z.string(), discussions: z.array(z.object({ rootId: z.string(), title: z.string(), rows: z.array(z.object({
    id: z.string(), role: z.string(), text: z.string(), sourceCreatedAt: z.string().optional(), sourceUpdatedAt: z.string().optional(),
  })) })),
  runs: z.array(z.object({ id: z.string(), agentName: z.string(), status: z.string(), ownerRootId: z.string().optional(), metadata: runMetadataSchema.optional(), messages: z.array(runMessageSchema).optional() })),
  askuserCards: z.array(askuserCardSchema).default([]),
  deliveries: z.array(z.object({ clientMessageId: z.string(), idempotencyKey: z.string(), body: z.string(), status: z.string(), createdAt: z.string(), message: z.string().optional() })),
  stops: z.array(z.object({ runId: z.string(), status: z.string(), cleanup: z.string(), message: z.string().optional() })),
});
