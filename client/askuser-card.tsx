import { useEffect, useState } from "react";
import { Pressable, Text, View } from "react-native";
import { useRpc, type PluginSurfaceProps, type PluginTimelineItemProps } from "@getpaseo/plugin/client";
import { Markdown, SettingsAction } from "@getpaseo/plugin/client/ui";
import { askuserObserve, askuserRead, askuserReopen, askuserSkip, askuserCardSchema, askuserConditionHint, type AskuserCardData } from "../shared/askuser.js";
import { collectText } from "./chunked-text.js";
import { formatTime } from "./format.js";

type Props = PluginTimelineItemProps<AskuserCardData>;
const status = { pending: "待答", answered: "已答", skipped: "已跳过", invalid: "不可解析" };

/** Shared with cache-only history; native questions own answer submission. */
export function AskuserContents({ data, theme }: { data: AskuserCardData; theme: PluginSurfaceProps["theme"] }) {
  const muted = { color: theme.colors.foregroundMuted };
  return <View style={{ gap: 8 }}>
    <Text style={{ color: theme.colors.foreground, fontWeight: "600" }}>{data.title}</Text>
    <Text style={muted}>{status[data.status]}{data.readOnly ? " · 只读" : ""}{data.offline ? " · 离线缓存" : ""}</Text>
    {data.collapsed && data.status === "pending" ? <Text style={muted}>已在本地收起，远端仍待答。</Text> : null}
    {data.description ? <Markdown>{data.description}</Markdown> : null}
    {data.questions.map((question, index) => <View key={`${index}:${question.id}`} style={{ gap: 4 }}>
      <Text style={{ color: theme.colors.foreground }}>{index + 1}. {question.title}</Text>
      {question.description ? <Markdown>{question.description}</Markdown> : null}
      <Text style={muted}>{question.type === "text" ? question.required_when ? "条件必填" : question.required === false ? "选填" : "必填文本" : question.type === "single" ? "单选" : "多选"}</Text>
      {question.type !== "text" ? <Text style={muted}>{question.options.map(option => option.label).join(" · ")}{question.other?.enabled ? ` · ${question.other.label || "其他（自定义）"}` : ""}</Text> : question.required_when ? <Text style={muted}>{askuserConditionHint(data.questions, question)}</Text> : null}
    </View>)}
    {data.answer ? <View style={{ gap: 4 }}><Text style={muted}>答复者：{data.answer.actorId ?? "未知"}{data.answer.delegatedBy ? ` · 代理委托：${data.answer.delegatedBy}` : ""}</Text><Markdown>{data.answer.content}</Markdown></View> : null}
    {data.skippedAt ? <Text style={muted}>跳过时间：{formatTime(data.skippedAt) ?? data.skippedAt} · 操作者：{data.skippedBy ?? "未知"}</Text> : null}
    {data.readOnlyReason ? <Text style={muted}>{data.readOnlyReason}</Text> : null}
    {data.delivery?.status === "pending_verification" || data.delivery?.status === "received" ? <Text style={muted}>回答保存结果待核实：请在 Multica 管理页「评论投递」核实原投递，或核实远端后明确重新发送；请勿重复提交。{data.delivery.message}</Text> : null}
    {data.statusError ? <Text style={muted}>{data.statusError}</Text> : null}
    {data.error ? <Text accessibilityRole="alert" style={{ color: theme.colors.statusDanger }}>{data.error}</Text> : null}
    <Text selectable style={muted}>原评论 {data.commentId} · 附件 {data.attachmentId} · Thread {data.rootId}</Text>
  </View>;
}

export function AskuserCard(props: Props & { openManagement?: () => void }) {
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
  return <AskuserBody key={data.revision} data={data} theme={props.theme} onChanged={setData} openManagement={props.openManagement} />;
}

function AskuserBody({ data, theme, onChanged, openManagement }: { data: AskuserCardData; theme: PluginSurfaceProps["theme"]; onChanged: (card: AskuserCardData) => void; openManagement?: () => void }) {
  const read = useRpc(askuserRead);
  const reopen = useRpc(askuserReopen);
  const skip = useRpc(askuserSkip);
  const [full, setFull] = useState<AskuserCardData | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [confirmSkip, setConfirmSkip] = useState(false);
  const [acting, setActing] = useState(false);
  const [scope] = useState({ active: true, busy: false });
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
  async function act(kind: "reopen" | "skip") {
    if (scope.busy || data.status !== "pending" || data.readOnly || data.offline) return;
    scope.busy = true; setActing(true); setError(null); setConfirmSkip(false);
    const address = { connectionKey: data.connectionKey, issueId: data.issueId, commentId: data.commentId, attachmentId: data.attachmentId };
    try {
      const updated = kind === "reopen" ? await reopen(address) : await skip({ ...address, confirmed: true });
      if (scope.active) onChanged(updated);
    } catch (failure) { if (scope.active) setError(failure instanceof Error ? failure.message : "卡片操作失败，请核对后重试。"); }
    finally { scope.busy = false; if (scope.active) setActing(false); }
  }
  const actionable = data.status === "pending" && !data.readOnly && !data.offline;
  return <View style={{ gap: 8 }}>
    <AskuserContents data={full ?? data} theme={theme} />
    {actionable && data.collapsed ? <Pressable accessibilityRole="button" accessibilityLabel="重新展开作答" disabled={acting} onPress={() => { void act("reopen"); }}><Text style={{ color: theme.colors.foreground }}>重新展开作答</Text></Pressable> : null}
    {actionable ? confirmSkip ? <View style={{ gap: 8 }}>
      <Text style={{ color: theme.colors.statusDanger }}>此操作会在 Multica 跳过此卡，所有成员都会看到已跳过状态。确认继续？</Text>
      <Pressable accessibilityRole="button" accessibilityLabel="确认远端跳过" disabled={acting} onPress={() => { void act("skip"); }}><Text style={{ color: theme.colors.statusDanger }}>确认远端跳过</Text></Pressable>
      <Pressable accessibilityRole="button" accessibilityLabel="取消" disabled={acting} onPress={() => setConfirmSkip(false)}><Text style={{ color: theme.colors.foreground }}>取消</Text></Pressable>
    </View> : <Pressable accessibilityRole="button" accessibilityLabel="跳过此卡" disabled={acting} onPress={() => setConfirmSkip(true)}><Text style={{ color: theme.colors.foreground }}>跳过此卡</Text></Pressable> : null}
    {data.delivery && ["received", "pending_verification", "failed"].includes(data.delivery.status) && openManagement ? <Pressable accessibilityRole="button" onPress={openManagement}><Text style={{ color: theme.colors.foreground }}>在管理页核实 / 重新发送</Text></Pressable> : null}
    {data.truncated && !full ? <SettingsAction label="内容较长，当前仅显示标题、警示和题目摘要。" actionLabel={loading ? "正在读取…" : "读取完整提问"} disabled={loading} onPress={() => { void load(); }} /> : null}
    {error ? <Text accessibilityRole="alert" style={{ color: theme.colors.statusDanger }}>{error}</Text> : null}
  </View>;
}
