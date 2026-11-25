import { useEffect, useState } from "react";
import { Text, View } from "react-native";
import { useRpc, type PluginSurfaceProps } from "@getpaseo/plugin/client";
import { Markdown, SettingsAction, SettingsCard, SettingsSection } from "@getpaseo/plugin/client/ui";
import { cachedIssueSnapshot, issueHistoryList, issueHistoryRead } from "../shared/access.js";
import type { z } from "zod";
import { RunMetadataView } from "./run-metadata.js";
import { collectText } from "./chunked-text.js";

type Summary = z.infer<typeof issueHistoryList.output>["issues"][number];
type Snapshot = z.infer<typeof cachedIssueSnapshot>;
const key = (issue: Summary) => JSON.stringify([issue.connectionKey, issue.issueId]);

export function ReadonlyHistory({ theme }: { theme: PluginSurfaceProps["theme"] }) {
  const list = useRpc(issueHistoryList);
  const read = useRpc(issueHistoryRead);
  const [issues, setIssues] = useState<Summary[]>([]);
  const [opened, setOpened] = useState<{ key: string; snapshot: Snapshot } | null>(null);
  const [loading, setLoading] = useState<string | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  const [scope] = useState({ active: true });
  useEffect(() => { scope.active = true; return () => { scope.active = false; }; }, [scope]);
  useEffect(() => {
    let active = true;
    const refresh = async () => {
      try { const result = await list({}); if (active) setIssues(result.issues ?? []); }
      catch { if (active) setFailure("无法读取主机缓存；已显示的历史仍保留，请重试。"); }
    };
    void refresh();
    const timer = setInterval(() => { void refresh(); }, 10_000);
    return () => { active = false; clearInterval(timer); };
  }, [list]);
  async function open(issue: Summary) {
    const id = key(issue); setLoading(id);
    try {
      const text = await collectText(offset => read({ connectionKey: issue.connectionKey, issueId: issue.issueId, revision: issue.revision, offset }), () => scope.active);
      if (text === undefined) return;
      setOpened({ key: id, snapshot: cachedIssueSnapshot.parse(JSON.parse(text)) }); setFailure(null);
    } catch { if (scope.active) setFailure("缓存已变化或读取失败，请重新读取历史。"); }
    finally { if (scope.active) setLoading(null); }
  }
  const muted = { color: theme.colors.foregroundMuted };
  const text = { color: theme.colors.foreground };
  return <SettingsSection title="只读历史">
    <Text style={muted}>远端任务删除或失权后从活跃列表移出，原连接、评论、执行及问题记录保留在这里。这里只读取缓存；访问恢复后按筛选规则和人工隐藏意愿恢复原记录。</Text>
    {failure ? <Text accessibilityRole="alert" style={muted}>{failure}</Text> : null}
    {issues.map(issue => <SettingsCard key={key(issue)}>
      <Text style={text}>{issue.title} · {issue.status === "inaccessible" ? issue.reason === "forbidden" ? "访问受限 · 只读" : "远端不存在或不可访问 · 只读" : "缓存历史 · 只读"}</Text>
      <Text selectable style={muted}>连接：{issue.connectionKey} · Issue：{issue.issueId}</Text>
      <Text style={muted}>最后完整同步：{issue.lastSuccessAt ?? "尚无完整同步记录"} · 最近核对：{issue.checkedAt ?? "未知"}</Text>
      <SettingsAction label="保留原发言身份及最后已知执行状态" actionLabel="读取缓存历史" disabled={loading !== null} onPress={() => { void open(issue); }} />
      {opened?.key === key(issue) ? <View style={{ gap: 12 }}>
        <Text style={muted}>只读缓存；执行状态为最后已知状态。</Text>
        <Markdown>{opened.snapshot.description}</Markdown>
        {opened.snapshot.discussions.map(discussion => <View key={discussion.rootId} style={{ gap: 6 }}>
          <Text style={text}>{discussion.title} · {discussion.rootId}</Text>
          {discussion.rows.map(row => <View key={row.id}>
            <Text style={muted}>{row.role === "user" ? "原连接用户" : row.role === "assistant" ? "其他发言者" : "独立事件"} · {row.sourceCreatedAt ?? "来源时间未知"}</Text>
            <Markdown>{row.text}</Markdown>
          </View>)}
        </View>)}
        {opened.snapshot.runs.map(run => <View key={run.id} style={{ gap: 6 }}>
          <Text style={text}>{run.agentName} · Run {run.id} · {run.status} · {run.ownerRootId ?? "归属待定"}</Text>
          <RunMetadataView metadata={run.metadata} theme={theme} />
          {run.messages?.map(message => <View key={message.seq}>
            <Text style={muted}>#{message.seq} · {message.type} · {message.tool ?? ""}</Text>
            {message.call_id ? <Text style={muted}>调用 ID：{message.call_id}</Text> : null}
            {message.type === "tool_result" ? <Text style={muted}>{message.output_truncated === true ? "源端已截断" : message.output_truncated === false ? "源端输出完整" : "输出完整性未知"}</Text> : null}
            <Text selectable style={text}>{message.content ?? message.output ?? (message.input ? JSON.stringify(message.input, null, 2) : "无已读正文")}</Text>
          </View>)}
          {!run.messages ? <Text style={muted}>没有已读执行正文缓存。</Text> : null}
        </View>)}
        {opened.snapshot.deliveries.map(record => <View key={record.idempotencyKey}>
          <Text selectable style={muted}>输入 {record.clientMessageId} · {record.createdAt} · {record.status} · {record.message ?? ""}</Text>
          <Markdown>{record.body}</Markdown>
        </View>)}
        {opened.snapshot.stops.map(record => <Text key={record.runId} style={muted}>停止记录 · {record.runId} · {record.status} · 清理 {record.cleanup} · {record.message ?? ""}</Text>)}
      </View> : null}
    </SettingsCard>)}
    {!issues.length ? <Text style={muted}>暂无缓存任务。</Text> : null}
  </SettingsSection>;
}
