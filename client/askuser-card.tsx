import { useEffect, useState } from "react";
import { Text, View } from "react-native";
import { useRpc, type PluginSurfaceProps, type PluginTimelineItemProps } from "@getpaseo/plugin/client";
import { Markdown, SettingsAction } from "@getpaseo/plugin/client/ui";
import { askuserObserve, askuserRead, askuserCardSchema, type AskuserCardData } from "../shared/askuser.js";
import { collectText } from "./chunked-text.js";
import { formatTime } from "./format.js";

type Props = PluginTimelineItemProps<AskuserCardData>;
const status = { pending: "待答", answered: "已答", skipped: "已跳过", invalid: "不可解析" };

/** Shared with cache-only history; neither surface offers a submit or skip action. */
export function AskuserContents({ data, theme }: { data: AskuserCardData; theme: PluginSurfaceProps["theme"] }) {
  const muted = { color: theme.colors.foregroundMuted };
  return <View style={{ gap: 8 }}>
    <Text style={{ color: theme.colors.foreground, fontWeight: "600" }}>{data.title}</Text>
    <Text style={muted}>{status[data.status]}{data.readOnly ? " · 只读" : ""}{data.offline ? " · 离线缓存" : ""}</Text>
    {data.description ? <Markdown>{data.description}</Markdown> : null}
    {data.questions.map((question, index) => <View key={`${index}:${question.id}`} style={{ gap: 4 }}>
      <Text style={{ color: theme.colors.foreground }}>{index + 1}. {question.title}</Text>
      {question.description ? <Markdown>{question.description}</Markdown> : null}
      <Text style={muted}>{question.type === "text" ? question.required_when ? "条件必填" : question.required === false ? "选填" : "必填文本" : question.type === "single" ? "单选" : "多选"}</Text>
      {question.type !== "text" ? <Text style={muted}>{question.options.map(option => option.label).join(" · ")}{question.other?.enabled ? ` · ${question.other.label || "其他（自定义）"}` : ""}</Text> : question.required_when ? <Text style={muted}>前置问题 {question.required_when.question_id} 选择 {question.required_when.option_ids.join("、")} 时必填；无法确认选项时也必填。</Text> : null}
    </View>)}
    {data.answer ? <View style={{ gap: 4 }}><Text style={muted}>答复者：{data.answer.actorId ?? "未知"}{data.answer.delegatedBy ? ` · 代理委托：${data.answer.delegatedBy}` : ""}</Text><Markdown>{data.answer.content}</Markdown></View> : null}
    {data.skippedAt ? <Text style={muted}>跳过时间：{formatTime(data.skippedAt) ?? data.skippedAt} · 操作者：{data.skippedBy ?? "未知"}</Text> : null}
    {data.readOnlyReason ? <Text style={muted}>{data.readOnlyReason}</Text> : null}
    {data.statusError ? <Text style={muted}>{data.statusError}</Text> : null}
    {data.error ? <Text accessibilityRole="alert" style={{ color: theme.colors.statusDanger }}>{data.error}</Text> : null}
    <Text selectable style={muted}>原评论 {data.commentId} · 附件 {data.attachmentId} · Thread {data.rootId}</Text>
  </View>;
}

export function AskuserCard(props: Props) {
  const observe = useRpc(askuserObserve);
  const [data, setData] = useState(props.item.data);
  const { connectionKey, issueId, commentId, attachmentId, revision } = props.item.data;
  useEffect(() => {
    let active = true;
    let inFlight = false;
    setData(props.item.data);
    const refresh = async () => {
      if (inFlight) return;
      inFlight = true;
      try { const value = await observe({ connectionKey, issueId, commentId, attachmentId }); if (active) setData(value); }
      catch { if (active) setData(value => ({ ...value, offline: true, readOnly: true, readOnlyReason: "卡片同步暂不可用，保留只读缓存。" })); }
      finally { inFlight = false; }
    };
    void refresh();
    const timer = setInterval(() => { void refresh(); }, 10_000);
    return () => { active = false; clearInterval(timer); };
  }, [observe, connectionKey, issueId, commentId, attachmentId, revision]);
  return <AskuserBody key={data.revision} data={data} theme={props.theme} />;
}

function AskuserBody({ data, theme }: { data: AskuserCardData; theme: PluginSurfaceProps["theme"] }) {
  const read = useRpc(askuserRead);
  const [full, setFull] = useState<AskuserCardData | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [scope] = useState({ active: true });
  useEffect(() => { scope.active = true; return () => { scope.active = false; }; }, [scope]);
  async function load() {
    if (loading) return;
    setLoading(true); setError(null);
    try {
      const text = await collectText(offset => read({ connectionKey: data.connectionKey, issueId: data.issueId, commentId: data.commentId, attachmentId: data.attachmentId, revision: data.revision, offset }), () => scope.active);
      if (text !== undefined) setFull(askuserCardSchema.parse(JSON.parse(text)));
    } catch { if (scope.active) setError("卡片已更新或详情暂不可用，请重新读取。"); }
    finally { if (scope.active) setLoading(false); }
  }
  return <View style={{ gap: 8 }}>
    <AskuserContents data={full ?? data} theme={theme} />
    {data.truncated && !full ? <SettingsAction label="内容较长，当前仅显示标题、警示和题目摘要。" actionLabel={loading ? "正在读取…" : "读取完整提问"} disabled={loading} onPress={() => { void load(); }} /> : null}
    {error ? <Text accessibilityRole="alert" style={{ color: theme.colors.statusDanger }}>{error}</Text> : null}
  </View>;
}
