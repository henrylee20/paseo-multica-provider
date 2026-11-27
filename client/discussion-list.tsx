import { useEffect, useState } from "react";
import { Pressable, Text, View } from "react-native";
import { useRpc, type PluginWorkspacePanelProps } from "@getpaseo/plugin/client";
import { Icon, Loading, ScrollView } from "@getpaseo/plugin/client/ui";
import type { z } from "zod";
import { discussionList } from "../shared/threads.js";
import { formatEventTime } from "./format.js";

export function DiscussionListPanel(props: PluginWorkspacePanelProps) {
  return <DiscussionListBody key={props.workspaceId} {...props} />;
}

function DiscussionListBody({ workspaceId, revision, navigation, theme }: PluginWorkspacePanelProps) {
  const read = useRpc(discussionList);
  const [result, setResult] = useState<z.output<typeof discussionList.output> | undefined>(undefined);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let active = true, latest = 0;
    async function refresh() {
      const request = ++latest;
      try {
        const value = await read({ workspaceId });
        if (active && request === latest) { setResult(value); setError(null); }
      } catch { if (active && request === latest) setError("讨论列表读取失败，请稍后重试。"); }
    }
    void refresh();
    const timer = setInterval(() => { void refresh(); }, 5000);
    return () => { active = false; clearInterval(timer); };
  }, [read, workspaceId, revision]);
  if (result === undefined && !error) return <Loading />;
  return <ScrollView style={{ flex: 1 }} contentContainerStyle={{ padding: 8, gap: 2 }}>
    {!navigation ? <Text style={{ color: theme.colors.foregroundMuted, padding: 8 }}>当前 Paseo 版本不支持从面板打开，请在侧边栏打开对应讨论。</Text> : null}
    {error ? <Text accessibilityRole="alert" style={{ color: theme.colors.statusDanger, padding: 8 }}>{error}</Text> : null}
    {result === null ? <Text style={{ color: theme.colors.foregroundMuted, padding: 8 }}>此 Paseo 工作区不是 Multica 任务</Text> : null}
    {result ? <>
      <Text style={{ color: theme.colors.foregroundMuted, fontSize: 12, padding: 8 }}>{[result.identifier, `${result.threads.length} 个 Thread`].filter(Boolean).join(" · ")}</Text>
      {!result.threads.length ? <Text style={{ color: theme.colors.foregroundMuted, padding: 8 }}>此任务暂无 Thread。</Text> : null}
      {result.threads.map(thread => {
        const time = formatEventTime(thread.lastActivityAt);
        const content = <>
          <View style={{ paddingTop: 2 }}><Icon name="MessageSquare" size={14} color={theme.colors.foregroundMuted} /></View>
          <View style={{ flex: 1, gap: 4 }}>
            <Text numberOfLines={2} style={{ color: theme.colors.foreground, fontSize: 14, lineHeight: 20 }}>{thread.title}</Text>
            <View style={{ flexDirection: "row", flexWrap: "wrap", alignItems: "center", gap: 8 }}>
              {time ? <Text style={{ color: theme.colors.foregroundMuted, fontSize: 12 }}>{time}</Text> : null}
              {thread.running ? <View style={{ flexDirection: "row", alignItems: "center", gap: 4 }}>
                <View style={{ width: 6, height: 6, borderRadius: 3, backgroundColor: theme.colors.statusSuccess }} />
                <Text style={{ color: theme.colors.statusSuccess, fontSize: 12 }}>执行中</Text>
              </View> : null}
              {thread.pendingAskuser ? <Text style={{ color: theme.colors.statusWarning, fontSize: 12 }}>待回答</Text> : null}
            </View>
          </View>
        </>;
        const style = { flexDirection: "row" as const, alignItems: "flex-start" as const, gap: 10, paddingHorizontal: 10, paddingVertical: 9, borderRadius: 8 };
        return thread.agentId && navigation ? <Pressable key={thread.rootId} accessibilityRole="button" accessibilityLabel={thread.title}
          style={({ pressed }) => [style, pressed ? { backgroundColor: theme.colors.surface2 } : null]} onPress={() => navigation.openAgent({ agentId: thread.agentId! })}>{content}</Pressable>
          : <View key={thread.rootId} style={style}>{content}</View>;
      })}
      {result.hiddenCount > 0 ? <Text style={{ color: theme.colors.foregroundMuted, fontSize: 12, padding: 8 }}>另有 {result.hiddenCount} 个已隐藏讨论，可在 Multica 设置页恢复。</Text> : null}
    </> : null}
  </ScrollView>;
}
