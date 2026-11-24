import { useState } from "react";
import { useRpc, type PluginTimelineItemProps } from "@getpaseo/plugin/client";
import { Markdown, SettingsAction } from "@getpaseo/plugin/client/ui";
import { Text, View } from "react-native";
import type { z } from "zod";
import { readTaskDescription, taskDescriptionSchema } from "../shared/description.js";

type DescriptionProps = PluginTimelineItemProps<z.output<typeof taskDescriptionSchema>>;

export function TaskDescription(props: DescriptionProps) {
  const { connectionKey, issueId, revision } = props.item.data;
  return <TaskDescriptionBody key={`${connectionKey}:${issueId}:${revision}`} {...props} />;
}

function TaskDescriptionBody({ item, theme }: DescriptionProps) {
  const read = useRpc(readTaskDescription);
  const [fullDescription, setFullDescription] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  async function load() {
    if (loading) return;
    setLoading(true);
    setError(null);
    try {
      const parts: string[] = [];
      let offset: number | null = 0;
      while (offset !== null) {
        const page = await read({ connectionKey: item.data.connectionKey, issueId: item.data.issueId, revision: item.data.revision, offset });
        parts.push(page.text);
        offset = page.nextOffset;
      }
      setFullDescription(parts.join(""));
    } catch { setError("完整描述暂不可用，请重新打开讨论后重试。"); }
    finally { setLoading(false); }
  }
  return <View style={{ gap: 8 }}>
    <Text style={{ color: theme.colors.foregroundMuted }}>任务描述</Text>
    <Markdown>{(fullDescription ?? item.data.preview) || "（此任务暂无描述）"}</Markdown>
    {item.data.truncated && fullDescription === null ? <SettingsAction label="描述较长，当前仅显示预览。"
      actionLabel={loading ? "正在读取…" : "读取完整描述"} disabled={loading} onPress={() => { void load(); }} /> : null}
    {error ? <Text accessibilityRole="alert" style={{ color: theme.colors.statusDanger }}>{error}</Text> : null}
  </View>;
}

