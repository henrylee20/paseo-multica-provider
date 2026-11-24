import { useEffect, useState } from "react";
import { Pressable, Text, View } from "react-native";
import { useRpc, type PluginSurfaceProps, type PluginTimelineItemProps } from "@getpaseo/plugin/client";
import { SettingsAction, SettingsCard, SettingsSection } from "@getpaseo/plugin/client/ui";
import type { z } from "zod";
import { deliveryList, deliveryMentions, deliveryRead, deliverySummary, deliveryTargets } from "../shared/delivery.js";

type Summary = z.infer<typeof deliverySummary>;
const labels = { received: "插件已接收：输入已持久保存，等待远端结果。", saved: "评论已保存；是否执行请查看独立 Run 状态。", failed: "投递失败：原输入已保留。", pending_verification: "投递结果待核实：不会自动重发，原输入已保留。" };

function PreservedInput({ record, theme }: { record: Summary; theme: PluginSurfaceProps["theme"] }) {
  const read = useRpc(deliveryRead);
  const [text, setText] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  async function load() {
    try {
      let offset: number | null = 0, result = "";
      while (offset !== null) { const part = await read({ connectionKey: record.connectionKey, issueId: record.issueId, rootId: record.rootId, clientMessageId: record.clientMessageId, offset }); result += part.text; offset = part.nextOffset; }
      setText(result); setError(null);
    } catch { setError("无法读取原输入，请重试。"); }
  }
  return <View style={{ gap: 4 }}><Text selectable style={{ color: theme.colors.foreground }}>{text ?? record.body}</Text>
    {record.truncated && text === null ? <Pressable accessibilityRole="button" onPress={() => { void load(); }}><Text style={{ color: theme.colors.foreground }}>读取完整原输入</Text></Pressable> : null}
    {error ? <Text style={{ color: theme.colors.statusDanger }}>{error}</Text> : null}
  </View>;
}

export function DeliveryStatus({ item, theme, openManagement }: PluginTimelineItemProps<Summary> & { openManagement?: () => void }) {
  const record = item.data;
  return <View style={{ gap: 6 }}>
    <Text style={{ color: record.status === "failed" || record.status === "pending_verification" ? theme.colors.statusDanger : theme.colors.foregroundMuted }}>{labels[record.status]}</Text>
    {record.message ? <Text style={{ color: theme.colors.foregroundMuted }}>{record.message}</Text> : null}
    {record.commentId ? <Text selectable style={{ color: theme.colors.foregroundMuted }}>评论：{record.commentId}</Text> : null}
    {record.status === "failed" || record.status === "pending_verification" ? <PreservedInput record={record} theme={theme} /> : null}
    {openManagement ? <Pressable accessibilityRole="button" onPress={openManagement}><Text style={{ color: theme.colors.foreground }}>{record.status === "saved" && record.rootId === "main" ? "在管理页继续新 Thread" : "查看投递记录"}</Text></Pressable> : null}
  </View>;
}

export function DeliveryManagement({ theme, navigation, host, refreshKey }: Pick<PluginSurfaceProps, "theme" | "navigation" | "host"> & { refreshKey: string }) {
  const list = useRpc(deliveryList), targets = useRpc(deliveryTargets), mentions = useRpc(deliveryMentions);
  const [records, setRecords] = useState<Summary[]>([]);
  const [issues, setIssues] = useState<Array<{ connectionKey: string; issueId: string; title: string }>>([]);
  const [agents, setAgents] = useState<Array<{ id: string; name: string; reference: string }>>([]);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let active = true;
    const update = async () => { try { const [deliveries, mappings] = await Promise.all([list({}), targets({})]); if (active) { setRecords(deliveries.records); setIssues(mappings.issues); } } catch { if (active) setError("无法读取投递记录。"); } };
    void update(); const timer = setInterval(() => { void update(); }, 3000);
    return () => { active = false; clearInterval(timer); };
  }, [list, targets, refreshKey]);
  async function choose(issue: { connectionKey: string; issueId: string }) {
    setAgents([]);
    try { const result = await mentions(issue); setAgents(result.agents); setError(null); }
    catch { setError("无法读取此任务的 agent 身份，请恢复原连接后重试。"); }
  }
  return <>
    <SettingsSection title="评论投递">
      <Text style={{ color: theme.colors.foregroundMuted }}>插件接收、评论保存和远端执行分别报告。失败或待核实输入不会自动重发。</Text>
      {error ? <Text accessibilityRole="alert" style={{ color: theme.colors.statusDanger }}>{error}</Text> : null}
      {records.map(record => <SettingsCard key={`${record.connectionKey}:${record.issueId}:${record.idempotencyKey}`}>
        <Text style={{ color: theme.colors.foregroundMuted }}>{record.createdAt} · {record.rootId === "main" ? "主讨论新 Thread" : `Thread ${record.rootId}`}</Text>
        <DeliveryStatus item={{ type: "plugin", kind: "comment-delivery", version: 1, data: record }} theme={theme} host={host} layout={{ compact: false, platform: "web" }} agentId="" timestamp={new Date(record.createdAt)} />
        {record.status === "saved" && record.threadAgentId && navigation ? <SettingsAction label={`Thread ${record.threadRootId}`} actionLabel="继续此 Thread" onPress={() => navigation.openAgent({ agentId: record.threadAgentId!, serverId: host.id })} /> : null}
      </SettingsCard>)}
      {!records.length ? <Text style={{ color: theme.colors.foregroundMuted }}>暂无投递记录。</Text> : null}
    </SettingsSection>
    <SettingsSection title="明确提及 agent">
      <Text style={{ color: theme.colors.foregroundMuted }}>选择任务后复制完整身份引用到原生输入框。同名 agent 按 ID 区分；普通 @名字不代表已选定接收者。</Text>
      {issues.map(issue => <SettingsAction key={`${issue.connectionKey}:${issue.issueId}`} label={issue.title} actionLabel="读取可提及身份" onPress={() => { void choose(issue); }} />)}
      {agents.map(agent => <SettingsCard key={agent.id}><Text style={{ color: theme.colors.foreground }}>{agent.name} · {agent.id}</Text><Text selectable style={{ color: theme.colors.foreground }}>{agent.reference}</Text></SettingsCard>)}
    </SettingsSection>
  </>;
}
