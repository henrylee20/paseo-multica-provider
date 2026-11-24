import { useEffect, useState } from "react";
import { useRpc, type PluginTimelineItemProps } from "@getpaseo/plugin/client";
import { Markdown, SettingsAction } from "@getpaseo/plugin/client/ui";
import { Text, View } from "react-native";
import type { z } from "zod";
import { readTaskDescription, observeTaskDescription, taskDescriptionSchema } from "../shared/description.js";
import { collectText } from "./chunked-text.js";

type DescriptionProps = PluginTimelineItemProps<z.output<typeof taskDescriptionSchema>>;

export function TaskDescription(props: DescriptionProps) {
  const { connectionKey, issueId, revision } = props.item.data;
  const observe = useRpc(observeTaskDescription);
  const [cached, setCached] = useState(props.item.data);
  useEffect(() => {
    let active = true;
    let inFlight = false;
    setCached(props.item.data);
    async function update() {
      if (inFlight) return;
      inFlight = true;
      try { const data = await observe({ connectionKey, issueId }); if (active) setCached(data); }
      catch { /* The already-rendered description remains readable offline. */ }
      finally { inFlight = false; }
    }
    void update();
    const timer = setInterval(() => { void update(); }, 10_000);
    return () => { active = false; clearInterval(timer); };
  }, [observe, connectionKey, issueId, revision]);
  return <TaskDescriptionBody key={`${connectionKey}:${issueId}:${cached.revision}`} {...props} item={{ ...props.item, data: cached }} />;
}

function TaskDescriptionBody({ item, theme }: DescriptionProps) {
  const read = useRpc(readTaskDescription);
  const [fullDescription, setFullDescription] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [scope] = useState({ active: true });
  useEffect(() => { scope.active = true; return () => { scope.active = false; }; }, [scope]);
  async function load() {
    if (loading) return;
    setLoading(true);
    setError(null);
    try {
      const text = await collectText(offset => read({ connectionKey: item.data.connectionKey, issueId: item.data.issueId, revision: item.data.revision, offset }), () => scope.active);
      if (text !== undefined) setFullDescription(text);
    } catch { if (scope.active) setError("完整描述暂不可用，请重新打开讨论后重试。"); }
    finally { if (scope.active) setLoading(false); }
  }
  return <View style={{ gap: 8 }}>
    <Text style={{ color: theme.colors.foregroundMuted }}>任务描述</Text>
    <Markdown>{(fullDescription ?? item.data.preview) || "（此任务暂无描述）"}</Markdown>
    {item.data.truncated && fullDescription === null ? <SettingsAction label="描述较长，当前仅显示预览。"
      actionLabel={loading ? "正在读取…" : "读取完整描述"} disabled={loading} onPress={() => { void load(); }} /> : null}
    {error ? <Text accessibilityRole="alert" style={{ color: theme.colors.statusDanger }}>{error}</Text> : null}
  </View>;
}
