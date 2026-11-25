import type { ProviderPermissionRequest } from "@getpaseo/plugin/server/provider";
import { askuserConditionHint, isAskuserQuestionRequired, type AskuserCardData } from "../shared/askuser.js";

export const askuserPermissionId = (card: { commentId: string; attachmentId: string }) => `multica:askuser:${card.commentId}:${card.attachmentId}`;
const submissionHeader = "提交确认";
const submissionLabel = "确认提交以上非空回答";
const dismissLabel = "仅本地收起（不跳过）";
const needsSubmissionConfirmation = (card: AskuserCardData) => card.questions.every(question => question.type === "text" && (question.required === false || !!question.required_when));
const excerpt = (value: string, length: number) => [...value].slice(0, length).join("");
export function askuserPermission(card: AskuserCardData): ProviderPermissionRequest {
  return { id: askuserPermissionId(card), name: "askuser", kind: "question", title: excerpt(card.title, 240),
    description: excerpt(card.description?.trim() || `${card.questions.length} 个问题：${card.questions[0].title}`, 800),
    input: { questions: [...card.questions.map((question, index) => ({
      dismissLabel,
      header: `${index + 1}. ${excerpt(question.title, 40)}`,
      question: [index === 0 ? `**${excerpt(card.title, 240)}**${card.description ? `\n\n${excerpt(card.description, 1600)}` : ""}` : "", question.title, question.description,
        question.type === "text" ? question.required_when ? askuserConditionHint(card.questions, question) : question.required === false ? "选填" : "必填" : "必选",
      ].filter(Boolean).join("\n\n"),
      options: question.type === "text" ? [] : question.options.map(option => ({ label: option.label })),
      multiSelect: question.type === "multiple", allowOther: question.type !== "text" && question.other?.enabled === true,
      ...(question.type !== "text" && question.other?.label !== undefined ? { placeholder: question.other.label } : {}),
      allowEmpty: question.type === "text" && (question.required === false || !!question.required_when),
    })), ...(needsSubmissionConfirmation(card) ? [{ header: submissionHeader, question: "确认提交以上非空回答。若只想本地收起，请点击收起按钮；远端卡片仍会保持待答。",
      options: [{ label: submissionLabel }], multiSelect: false, allowOther: false, allowEmpty: false, dismissLabel }] : [])] } };
}

/** Older hosts/clients can send ambiguous allows; only explicit nonempty submission is remote. */
export function isLocalAskuserDismiss(card: AskuserCardData, input: unknown) {
  if (!needsSubmissionConfirmation(card)) return false;
  const answers = (input as { answers?: unknown } | undefined)?.answers;
  if (!answers || typeof answers !== "object" || Array.isArray(answers)) return true;
  const values = answers as Record<string, unknown>;
  const questions = askuserPermission(card).input!.questions as Array<{ header: string }>;
  return values[submissionHeader] !== submissionLabel || questions.slice(0, card.questions.length).every(question =>
    values[question.header] === undefined || typeof values[question.header] === "string" && !(values[question.header] as string).trim());
}

/** Native answers join labels with comma-space, including labels which themselves contain it. */
export function formatAskuserAnswers(card: AskuserCardData, input: unknown) {
  const object = input as { answers?: unknown } | undefined;
  if (!object?.answers || typeof object.answers !== "object" || Array.isArray(object.answers)) throw new Error("提问回答格式无效。");
  const answers = object.answers as Record<string, unknown>;
  const request = askuserPermission(card);
  const headers = (request.input!.questions as Array<{ header: string }>).map(question => question.header);
  const values = card.questions.map((question, index) => {
    const raw = answers[headers[index]];
    if (raw !== undefined && typeof raw !== "string") throw new Error(`「${question.title}」回答必须为文本。`);
    const value = (raw as string | undefined ?? "").trim().replace(/\r\n?/g, "\n");
    if (question.type === "text") return value;
    if (!value) throw new Error(`请回答「${question.title}」。`);
    const selected = new Set<string>();
    let remaining = value;
    let custom = "";
    let note = "";
    const options = [...question.options].sort((a, b) => b.label.length - a.label.length);
    do {
      const option = options.find(option => !selected.has(option.id) && (remaining === option.label || remaining.startsWith(`${option.label}, `) || remaining.startsWith(`${option.label}（补充：`)));
      if (!option) { custom = remaining.trim(); break; }
      selected.add(option.id);
      remaining = remaining.slice(option.label.length);
      if (remaining.startsWith("（补充：") && remaining.endsWith("）")) { note = remaining.slice(4, -1).trim(); remaining = ""; }
      else if (remaining.startsWith(", ")) remaining = remaining.slice(2);
      if (question.type === "single" && remaining) { selected.clear(); custom = value; break; }
    } while (remaining);
    if (custom && !question.other?.enabled) throw new Error(`「${question.title}」包含无效选项。`);
    const labels = question.options.filter(option => selected.has(option.id)).map(option => option.label);
    if (custom) labels.push(custom);
    const chosen = labels.join("、");
    return chosen ? `${chosen}${note ? `（补充：${note}）` : ""}` : note || "未回答";
  });
  card.questions.forEach((question, index) => {
    if (question.type !== "text") return;
    if (isAskuserQuestionRequired(card.questions, question, values) && (!values[index] || values[index] === "未回答")) throw new Error(`请填写「${question.title}」${question.required_when ? "（条件必填；自定义或无法确认前置选项时也必填）" : ""}。`);
  });
  return `**确认结果**\n\n${card.questions.map((question, index) => `${index + 1}. **${question.title}**：${values[index].split("\n").map((line, i) => i === 0 ? line : line ? `> ${line}` : ">").join("\n")}`).join("\n")}`;
}
