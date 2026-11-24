import { Text, View } from "react-native";
import type { PluginSurfaceProps } from "@getpaseo/plugin/client";
import type { RunMetadata } from "../shared/runs.js";

export function RunMetadataView({ metadata, theme }: { metadata?: RunMetadata; theme: PluginSurfaceProps["theme"] }) {
  if (!metadata) return null;
  const value = (source: string | null) => source === null ? "（来源明确为空：null）" : source || "（空字符串）";
  const muted = { color: theme.colors.foregroundMuted };
  const text = { color: theme.colors.foreground };
  const paths = metadata.work_dir !== undefined || metadata.relative_work_dir !== undefined;
  return <View style={{ gap: 4 }}>
    {metadata.error !== undefined ? <><Text style={muted}>任务错误 · error</Text><Text selectable style={text}>{value(metadata.error)}</Text></> : null}
    {metadata.failure_reason !== undefined ? <><Text style={muted}>失败原因 · failure_reason</Text><Text selectable style={text}>{value(metadata.failure_reason)}</Text></> : null}
    {paths ? <Text style={muted}>远端执行路径，与 Paseo 本地占位目录不同。</Text> : null}
    {metadata.work_dir !== undefined ? <><Text style={muted}>REMOTE · work_dir</Text><Text selectable style={text}>{value(metadata.work_dir)}</Text></> : null}
    {metadata.relative_work_dir !== undefined ? <><Text style={muted}>REMOTE · relative_work_dir</Text><Text selectable style={text}>{value(metadata.relative_work_dir)}</Text></> : null}
  </View>;
}
