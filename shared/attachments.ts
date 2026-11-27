import { defineRpc } from "@getpaseo/plugin";
import { z } from "zod";
import { deliveredAttachment } from "./delivery.js";

const fileInfo = deliveredAttachment.pick({ name: true, mimeType: true, size: true });
export const attachmentPreview = defineRpc({ name: "attachment.preview",
  input: z.object({ connectionKey: z.string(), issueId: z.string(), attachmentId: z.string() }),
  output: z.discriminatedUnion("kind", [
    fileInfo.extend({ kind: z.literal("image"), data: z.string() }),
    fileInfo.extend({ kind: z.enum(["text", "markdown"]), text: z.string(), truncated: z.boolean() }),
    fileInfo.extend({ kind: z.literal("unsupported"), reason: z.string().optional() }),
  ]),
});
export type AttachmentPreview = z.infer<typeof attachmentPreview.output>;
