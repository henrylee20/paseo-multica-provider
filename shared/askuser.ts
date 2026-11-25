import { defineRpc } from "@getpaseo/plugin";
import { z } from "zod";

const nonempty = z.string().refine(value => value.trim().length > 0, "Must not be blank");
const commonQuestion = { id: nonempty, title: nonempty, description: z.string().optional() };
const condition = z.strictObject({ question_id: nonempty, option_ids: z.array(nonempty).min(1).refine(ids => new Set(ids).size === ids.length) });
const options = z.array(z.strictObject({ id: nonempty, label: nonempty })).min(1).max(5).refine(items => new Set(items.map(item => item.id)).size === items.length);
const other = z.strictObject({ enabled: z.boolean(), label: z.string().optional() }).optional();
export const askuserQuestionSchema = z.discriminatedUnion("type", [
  z.strictObject({ ...commonQuestion, type: z.literal("text"), required: z.boolean().optional(), required_when: condition.optional() }),
  z.strictObject({ ...commonQuestion, type: z.literal("single"), options, other }),
  z.strictObject({ ...commonQuestion, type: z.literal("multiple"), options, other }),
]);
export const askuserDocumentSchema = z.strictObject({ version: z.literal("1"), title: nonempty, description: z.string().optional(),
  answer_user_id: nonempty.optional(), require_answer: z.boolean().optional(), questions: z.array(askuserQuestionSchema).min(1) }).superRefine((document, context) => {
  const ids = new Set<string>();
  document.questions.forEach((question, index) => {
    const problem = (message: string) => context.addIssue({ code: "custom", path: ["questions", index], message });
    if (ids.has(question.id)) problem("Question IDs must be unique");
    ids.add(question.id);
    if (question.type !== "text" || !question.required_when) return;
    if (question.required !== undefined) problem("required and required_when are mutually exclusive");
    const parent = document.questions.slice(0, index).find(item => item.id === question.required_when!.question_id);
    if (parent?.type !== "single" || question.required_when.option_ids.some(id => !parent.options.some(option => option.id === id))) {
      problem("Condition must reference options from a preceding single question");
    }
  });
});
export type AskuserDocument = z.infer<typeof askuserDocumentSchema>;
export const askuserAddress = z.object({ connectionKey: z.string(), issueId: z.string(), commentId: z.string(), attachmentId: z.string() });
export const askuserAnswerSchema = z.object({ commentId: z.string(), content: z.string(), actorId: z.string().optional(), actorType: z.string().optional(), delegatedBy: z.string().optional() });
export const askuserCardSchema = askuserAddress.extend({ rootId: z.string(), revision: z.string(), title: z.string(), description: z.string().optional(),
  delivery: z.object({ status: z.enum(["received", "saved", "failed", "pending_verification"]), clientMessageId: z.string(), message: z.string().optional() }).optional(),
  questions: z.array(askuserQuestionSchema), status: z.enum(["pending", "answered", "skipped", "invalid"]), collapsed: z.boolean().optional(),
  readOnly: z.boolean(), readOnlyReason: z.string().optional(), offline: z.boolean(), truncated: z.boolean(), error: z.string().optional(), statusError: z.string().optional(), answer: askuserAnswerSchema.optional(), skippedAt: z.string().optional(), skippedBy: z.string().optional(),
});
export type AskuserCardData = z.infer<typeof askuserCardSchema>;
export const askuserObserve = defineRpc({ name: "askuser.observe", input: askuserAddress, output: askuserCardSchema });
export const askuserReopen = defineRpc({ name: "askuser.reopen", input: askuserAddress, output: askuserCardSchema });
export const askuserSkip = defineRpc({ name: "askuser.skip", input: askuserAddress.extend({ confirmed: z.literal(true) }), output: askuserCardSchema });
export const askuserRead = defineRpc({ name: "askuser.read", input: askuserAddress.extend({ revision: z.string(), offset: z.number().int().nonnegative() }),
  output: z.object({ text: z.string(), nextOffset: z.number().int().nonnegative().nullable() }) });

/** Requiredness over canonical answer strings, shared by submit and observed replies. */
export function isAskuserQuestionRequired(questions: AskuserDocument["questions"], question: AskuserDocument["questions"][number], answers: readonly string[]) {
  if (question.type !== "text") return true;
  if (!question.required_when) return question.required !== false;
  const condition = question.required_when;
  const parentIndex = questions.findIndex(item => item.id === condition.question_id);
  const parent = questions[parentIndex];
  const value = answers[parentIndex] ?? "";
  const matches = parent?.type === "single" ? parent.options.filter(option => value === option.label || value.startsWith(`${option.label}（补充：`)) : [];
  return matches.length !== 1 || condition.option_ids.includes(matches[0].id);
}

/** Match complete direct replies after undoing Markdown punctuation escaping. */
export function isAskuserReplyValid(document: AskuserDocument, reply: { content: string; actor_type?: string; actor_id?: string; delegated_by?: string | null }) {
  const body = reply.content.trim().replace(/\\([!"#$%&'()*+,\-./:;<=>?@[\\\]^_`{|}~])/g, "$1");
  const prefixes = document.questions.map((question, index) => `${index + 1}. **${question.title}**：`);
  if (!body.startsWith("**确认结果**") || !prefixes.every(prefix => body.includes(prefix))) return false;
  if (!document.require_answer && !document.answer_user_id) return true;
  if (document.answer_user_id && !(
    reply.actor_type === "member" && reply.actor_id === document.answer_user_id ||
    reply.actor_type === "agent" && reply.delegated_by === document.answer_user_id
  )) return false;
  const lines = body.split(/\r?\n/);
  const answers: string[] = [];
  for (const prefix of prefixes) {
    const matches = lines.filter(line => line.startsWith(prefix));
    if (matches.length !== 1) return false;
    answers.push(matches[0].slice(prefix.length).trim());
  }
  return document.questions.every((question, index) => !isAskuserQuestionRequired(document.questions, question, answers) || answers[index] !== "" && answers[index] !== "未回答");
}


export function askuserConditionHint(questions: AskuserDocument["questions"], question: AskuserDocument["questions"][number]) {
  if (question.type !== "text" || !question.required_when) return undefined;
  const condition = question.required_when;
  const parent = questions.find(item => item.id === condition.question_id);
  const labels = parent?.type === "single" ? parent.options.filter(option => condition.option_ids.includes(option.id)).map(option => `「${option.label}」`).join("、") : "指定选项";
  return `条件必填：「${parent?.title ?? condition.question_id}」选择${labels}时必填；无法确认选项时也必填（包括自定义回答）。`;
}
