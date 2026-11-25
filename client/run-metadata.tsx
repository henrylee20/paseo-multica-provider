import { Text, View } from "react-native";
import type { PluginSurfaceProps } from "@getpaseo/plugin/client";
import type { RunMetadata } from "../shared/runs.js";

export function RunMetadataView({ metadata, theme }: { metadata?: RunMetadata; theme: PluginSurfaceProps["theme"] }) {
  if (!metadata) return null;
  const muted = { color: theme.colors.foregroundMuted };
  const text = { color: theme.colors.foreground };
  return <View style={{ gap: 4 }}>
    {metadata.error ? <><Text style={muted}>任务错误</Text><Text selectable style={text}>{metadata.error}</Text></> : null}
    {metadata.failure_reason ? <><Text style={muted}>失败原因</Text><Text selectable style={text}>{metadata.failure_reason}</Text></> : null}
    {metadata.work_dir ? <><Text style={muted}>远端目录</Text><Text selectable style={text}>{metadata.work_dir}</Text></> : null}
  </View>;
}
