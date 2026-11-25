import { useSyncStatus } from "./sync-status.js";
import { useEffect, useState } from "react";
import { Pressable, Text, View } from "react-native";
import { useRpc, type PluginTimelineItemProps } from "@getpaseo/plugin/client";
import type { z } from "zod";
import { threadOpen, threadSummarySchema, commentEventSchema, commentEventDetail } from "../shared/threads.js";

export function ThreadSummary({ item, theme }: PluginTimelineItemProps<z.infer<typeof threadSummarySchema>>) {
  const open = useRpc(threadOpen);
  const sync = useSyncStatus();
  const [message, setMessage] = useState("");
  const [attempt, setAttempt] = useState(0);
  const { connectionKey, issueId, rootId } = item.data;
  useEffect(() => {
    let active = true;
    void open({ connectionKey, issueId, rootId }).then(result => {
      if (active) setMessage(result.status === "ready" ? "" : result.message ?? "无法读取远端历史。");
    }).catch(() => { if (active) setMessage("无法读取远端历史，已读记录仍保存在本地。"); });
    return () => { active = false; };
  }, [open, connectionKey, issueId, rootId, attempt]);
  if (!message && sync.tone === "muted") return null;
  return <View style={{ gap: 6 }}>
    {sync.tone !== "muted" ? <Text style={{ color: theme.colors.foregroundMuted }}>{[sync.label, sync.message].filter(Boolean).join(" · ")}</Text> : null}
    {message ? <Text style={{ color: theme.colors.foregroundMuted }}>{message}</Text> : null}
    <Pressable accessibilityRole="button" onPress={() => setAttempt(value => value + 1)}><Text style={{ color: theme.colors.foreground }}>重新读取历史</Text></Pressable>
  </View>;
}

const labels = { system: "系统事件", correction: "评论更正", deletion: "评论删除", source: "评论来源" };
export function CommentEvent({ item, theme }: PluginTimelineItemProps<z.infer<typeof commentEventSchema>>) {
  const detail = useRpc(commentEventDetail);
  const [fullText, setFullText] = useState<string | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  const data = item.data;
  return <View style={{ gap: 6 }}>
    <Text style={{ color: theme.colors.foregroundMuted }}>{labels[data.category]} · {data.commentId}</Text>
    {data.sourceCreatedAt ? <Text style={{ color: theme.colors.foregroundMuted }}>发言时间：{data.sourceCreatedAt}</Text> : null}
    {data.sourceUpdatedAt && data.sourceUpdatedAt !== data.sourceCreatedAt ? <Text style={{ color: theme.colors.foregroundMuted }}>来源更新时间：{data.sourceUpdatedAt}</Text> : null}
    <Text selectable style={{ color: theme.colors.foreground }}>{fullText ?? data.text}</Text>
    {data.truncated && fullText === null ? <Pressable accessibilityRole="button" onPress={() => {
      void detail({ connectionKey: data.connectionKey, issueId: data.issueId, rootId: data.rootId, recordId: data.recordId })
        .then(result => { setFullText(result.text); setFailure(null); }).catch(() => setFailure("无法读取完整记录，请重试。"));
    }}><Text style={{ color: theme.colors.foreground }}>读取完整记录（当前显示摘要）</Text></Pressable> : null}
    {failure ? <Text style={{ color: theme.colors.foregroundMuted }}>{failure}</Text> : null}
  </View>;
}
