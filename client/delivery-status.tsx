import { useState } from "react";
import { Text, View } from "react-native";
import type { PluginTimelineItemProps } from "@getpaseo/plugin/client";
import { ExternalLink } from "@getpaseo/plugin/client/ui";
import type { z } from "zod";
import type { deliverySummary } from "../shared/delivery.js";

export function DeliveryStatus({ item, theme }: PluginTimelineItemProps<z.infer<typeof deliverySummary>>) {
  const [error, setError] = useState(false);
  const data = item.data;
  return <View style={{ gap: 4 }}>
    {data.threadCreated !== false ? <Text style={{ color: theme.colors.foregroundMuted }}>新 Thread 已建立，可在侧边栏打开。</Text> : null}
    {data.attachments?.map(attachment => {
      const size = attachment.size === undefined ? "大小未知" : attachment.size < 1024 ? `${attachment.size} B`
        : attachment.size < 1024 * 1024 ? `${(attachment.size / 1024).toFixed(1)} KiB` : `${(attachment.size / (1024 * 1024)).toFixed(1)} MiB`;
      const label = <Text style={{ color: theme.colors.foreground }}>{attachment.name} · {attachment.mimeType} · {size}</Text>;
      return attachment.url ? <ExternalLink key={attachment.id} href={attachment.url} onError={() => setError(true)}>{label}</ExternalLink>
        : <View key={attachment.id}>{label}<Text style={{ color: theme.colors.foregroundMuted }}>附件链接不可用</Text></View>;
    })}
    {error ? <Text accessibilityRole="alert" style={{ color: theme.colors.statusDanger }}>无法打开附件链接，请在 Multica 查看。</Text> : null}
  </View>;
}
