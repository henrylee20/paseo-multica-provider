import { Text } from "react-native";
import type { PluginTimelineItemProps } from "@getpaseo/plugin/client";

export function DeliveryStatus({ theme }: PluginTimelineItemProps) {
  return <Text style={{ color: theme.colors.foregroundMuted }}>新 Thread 已建立，可在侧边栏打开。</Text>;
}
