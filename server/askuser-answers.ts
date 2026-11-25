import type { ProviderPermissionRequest } from "@getpaseo/plugin/server/provider";
import { askuserConditionHint, type AskuserCardData } from "../shared/askuser.js";

export const askuserPermissionId = (card: { commentId: string; attachmentId: string }) => `multica:askuser:${card.commentId}:${card.attachmentId}`;
const excerpt = (value: string, length: number) => [...value].slice(0, length).join("");
export function askuserPermission(card: AskuserCardData): ProviderPermissionRequest {
  return { id: askuserPermissionId(card), name: "askuser", kind: "question", title: excerpt(card.title, 240),
    description: excerpt(card.description?.trim() || `${card.questions.length} 个问题：${card.questions[0].title}`, 800),
    input: { dismissLabel: "仅本地收起（不跳过）", questions: card.questions.map((question, index) => ({
      header: `${index + 1}. ${excerpt(question.title, 40)}`,
      question: [index === 0 ? `**${excerpt(card.title, 240)}**${card.description ? `\n\n${excerpt(card.description, 1600)}` : ""}` : "", question.title, question.description,
        question.type === "text" ? question.required_when ? askuserConditionHint(card.questions, question) : question.required === false ? "选填" : "必填" : "必选",
      ].filter(Boolean).join("\n\n"),
      options: question.type === "text" ? [] : question.options.map(option => ({ label: option.label })),
      multiSelect: question.type === "multiple", allowOther: question.type !== "text" && question.other?.enabled === true,
      ...(question.type !== "text" && question.other?.label !== undefined ? { placeholder: question.other.label } : {}),
      allowEmpty: question.type === "text" && (question.required === false || !!question.required_when),
    })) } };
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
    let required = question.required !== false && !question.required_when;
    if (question.required_when) {
      const condition = question.required_when;
      const parentIndex = card.questions.findIndex(item => item.id === condition.question_id);
      const parent = card.questions[parentIndex];
      const matches = parent?.type === "single" ? parent.options.filter(option => values[parentIndex] === option.label || values[parentIndex].startsWith(`${option.label}（补充：`)) : [];
      required = matches.length !== 1 || condition.option_ids.includes(matches[0].id);
    }
    if (required && (!values[index] || values[index] === "未回答")) throw new Error(`请填写「${question.title}」${question.required_when ? "（条件必填；自定义或无法确认前置选项时也必填）" : ""}。`);
  });
  return `**确认结果**\n\n${card.questions.map((question, index) => `${index + 1}. **${question.title}**：${values[index].split("\n").map((line, i) => i === 0 ? line : line ? `> ${line}` : ">").join("\n")}`).join("\n")}`;
}
