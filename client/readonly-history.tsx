import { useEffect, useState } from "react";
import { Text, View } from "react-native";
import { useRpc, type PluginSurfaceProps } from "@getpaseo/plugin/client";
import { Markdown, Modal, SettingsAction, SettingsCard, SettingsSection } from "@getpaseo/plugin/client/ui";
import { cachedIssueSnapshot, issueHistoryList, issueHistoryRead } from "../shared/access.js";
import type { z } from "zod";
import { RunMetadataView } from "./run-metadata.js";
import { collectText } from "./chunked-text.js";
import { formatTime, runStatusLabel } from "./format.js";
import { Notice, SubHeading } from "./ui-kit.js";

type Summary = z.infer<typeof issueHistoryList.output>["issues"][number];
type Snapshot = z.infer<typeof cachedIssueSnapshot>;
type Theme = PluginSurfaceProps["theme"];
const key = (issue: Summary) => JSON.stringify([issue.connectionKey, issue.issueId]);
const access = (issue: Summary) => issue.status === "inaccessible" ? issue.reason === "forbidden" ? "访问受限 · 只读" : "远端不存在或不可访问 · 只读" : "缓存历史 · 只读";

/** A cached issue can be long (every discussion, Run and preserved input), so it opens in a modal rather than inside the list. */
function SnapshotView({ issue, snapshot, theme }: { issue: Summary; snapshot: Snapshot; theme: Theme }) {
  const muted = { color: theme.colors.foregroundMuted };
  const text = { color: theme.colors.foreground };
  return <View style={{ gap: 16 }}>
    <View style={{ gap: 4 }}>
      <Text style={muted}>{access(issue)}；执行状态为最后已知状态。</Text>
      <Text selectable style={muted}>连接 {issue.connectionKey} · Issue {issue.issueId}</Text>
    </View>
    <View style={{ gap: 6 }}><SubHeading theme={theme}>任务描述</SubHeading><Markdown>{snapshot.description}</Markdown></View>
    {snapshot.discussions.map(discussion => <View key={discussion.rootId} style={{ gap: 6 }}>
      <SubHeading theme={theme}>讨论 · {discussion.title} · {discussion.rootId}</SubHeading>
      {discussion.rows.map(row => <View key={row.id}>
        <Text style={muted}>{row.role === "user" ? "原连接用户" : row.role === "assistant" ? "其他发言者" : "独立事件"} · {formatTime(row.sourceCreatedAt) ?? "来源时间未知"}</Text>
        <Markdown>{row.text}</Markdown>
      </View>)}
    </View>)}
    {snapshot.runs.map(run => <View key={run.id} style={{ gap: 6 }}>
      <SubHeading theme={theme}>执行 · {run.agentName} · {runStatusLabel(run.status)}</SubHeading>
      <Text selectable style={muted}>Run {run.id} · {run.ownerRootId ? `归属 ${run.ownerRootId}` : "归属待定"}</Text>
      <RunMetadataView metadata={run.metadata} theme={theme} />
      {run.messages?.map(message => <View key={message.seq}>
        <Text style={muted}>#{message.seq} · {message.type}{message.tool ? ` · ${message.tool}` : ""}</Text>
        {message.call_id ? <Text style={muted}>调用 ID：{message.call_id}</Text> : null}
        {message.type === "tool_result" ? <Text style={muted}>{message.output_truncated === true ? "源端已截断" : message.output_truncated === false ? "源端输出完整" : "输出完整性未知"}</Text> : null}
        <Text selectable style={text}>{message.content ?? message.output ?? (message.input ? JSON.stringify(message.input, null, 2) : "无已读正文")}</Text>
      </View>)}
      {!run.messages ? <Text style={muted}>没有已读执行正文缓存。</Text> : null}
    </View>)}
    {snapshot.deliveries.length ? <View style={{ gap: 6 }}>
      <SubHeading theme={theme}>原始输入</SubHeading>
      {snapshot.deliveries.map(record => <View key={record.idempotencyKey}>
        <Text selectable style={muted}>输入 {record.clientMessageId} · {formatTime(record.createdAt)} · {record.status}{record.message ? ` · ${record.message}` : ""}</Text>
        <Markdown>{record.body}</Markdown>
      </View>)}
    </View> : null}
    {snapshot.stops.length ? <View style={{ gap: 6 }}>
      <SubHeading theme={theme}>停止记录</SubHeading>
      {snapshot.stops.map(record => <Text key={record.runId} selectable style={muted}>Run {record.runId} · {runStatusLabel(record.status)} · 清理 {record.cleanup}{record.message ? ` · ${record.message}` : ""}</Text>)}
    </View> : null}
  </View>;
}

/** Shown only while cached read-only issues exist or the cache cannot be read. */
export function ReadonlyHistory({ theme }: { theme: Theme }) {
  const list = useRpc(issueHistoryList);
  const read = useRpc(issueHistoryRead);
  const [issues, setIssues] = useState<Summary[]>([]);
  const [opened, setOpened] = useState<{ issue: Summary; snapshot: Snapshot } | null>(null);
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
    setLoading(key(issue));
    try {
      const text = await collectText(offset => read({ connectionKey: issue.connectionKey, issueId: issue.issueId, revision: issue.revision, offset }), () => scope.active);
      if (text === undefined) return;
      setOpened({ issue, snapshot: cachedIssueSnapshot.parse(JSON.parse(text)) }); setFailure(null);
    } catch { if (scope.active) setFailure("缓存已变化或读取失败，请重新读取历史。"); }
    finally { if (scope.active) setLoading(null); }
  }
  if (!issues.length && !failure) return null;
  return <SettingsSection title="只读历史" info="远端任务删除或失权后从活跃列表移出，原连接、评论、执行及问题记录保留在这里。这里只读取缓存；访问恢复后按筛选规则和人工隐藏意愿恢复原记录。">
    {failure ? <Notice theme={theme}>{failure}</Notice> : null}
    {issues.length ? <SettingsCard>
      {issues.map(issue => <SettingsAction key={key(issue)} label={issue.title}
        hint={`${access(issue)}\n最后完整同步：${formatTime(issue.lastSuccessAt) ?? "尚无记录"} · 最近核对：${formatTime(issue.checkedAt) ?? "未知"}`}
        actionLabel={loading === key(issue) ? "正在读取…" : "读取缓存历史"} disabled={loading !== null} onPress={() => { void open(issue); }} />)}
    </SettingsCard> : null}
    {opened ? <Modal title={opened.snapshot.title || opened.issue.title} open onOpenChange={value => { if (!value) setOpened(null); }}>
      <Modal.Content><SnapshotView issue={opened.issue} snapshot={opened.snapshot} theme={theme} /></Modal.Content>
    </Modal> : null}
  </SettingsSection>;
}
