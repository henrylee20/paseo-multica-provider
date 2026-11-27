import { useState } from "react";
import { Pressable, Text, View } from "react-native";
import { useAgent, type PluginClientContext, type PluginTimelineItemProps } from "@getpaseo/plugin/client";
import { ExternalLink } from "@getpaseo/plugin/client/ui";
import type { z } from "zod";
import type { deliverySummary } from "../shared/delivery.js";
import { discussionKeys } from "../shared/discussion.js";
import { openAttachmentPreview } from "./attachment-preview.js";
import { formatSize } from "./format.js";
import { HeaderAction } from "./ui-kit.js";

export function DeliveryStatus({ agentId, item, theme, layout, client }: PluginTimelineItemProps<z.infer<typeof deliverySummary>> & { client: PluginClientContext }) {
  const [error, setError] = useState(false);
  const agent = useAgent(agentId, value => ({ workspaceId: value.workspaceId, connectionKey: value.labels[discussionKeys.connection], issueId: value.labels[discussionKeys.issue] }));
  const data = item.data;
  return <View style={{ gap: 4 }}>
    {data.threadCreated !== false ? <View style={{ flexDirection: "row", flexWrap: "wrap", alignItems: "center", gap: 10 }}>
      <Text style={{ color: theme.colors.foregroundMuted }}>{data.threadTitle ? `已新建 Thread「${data.threadTitle}」` : "已新建 Thread。"}</Text>
      {agent?.workspaceId ? <HeaderAction theme={theme} label="在讨论列表中查看" icon="PanelRight" onPress={() => client.openPanel("discussion-list", { workspaceId: agent.workspaceId!, location: layout.compact ? "workspace" : "explorer" })} /> : null}
    </View> : null}
    {data.attachments?.map(attachment => {
      const label = <Text style={{ color: theme.colors.foreground }}>{attachment.name} · {attachment.mimeType} · {formatSize(attachment.size)}</Text>;
      if (agent?.workspaceId && agent.connectionKey && agent.issueId) {
        const selection = { connectionKey: agent.connectionKey, issueId: agent.issueId, attachment };
        return <View key={attachment.id} style={{ gap: 4 }}>
          <Pressable accessibilityRole="button" accessibilityLabel={`预览 ${attachment.name}`} onPress={() => openAttachmentPreview(client, agent.workspaceId, selection, layout.compact ? "workspace" : "explorer")}>
            {label}
          </Pressable>
          <View style={{ flexDirection: "row", flexWrap: "wrap", alignItems: "center", gap: 12 }}>
            <HeaderAction theme={theme} label="在 tab 中打开" icon="PanelTop" onPress={() => openAttachmentPreview(client, agent.workspaceId, selection, "workspace")} />
            {attachment.url ? <ExternalLink href={attachment.url} onError={() => setError(true)}><Text style={{ color: theme.colors.foregroundMuted, fontSize: 13 }}>在 Multica 查看</Text></ExternalLink> : null}
          </View>
        </View>;
      }
      return attachment.url ? <ExternalLink key={attachment.id} href={attachment.url} onError={() => setError(true)}>{label}</ExternalLink>
        : <View key={attachment.id}>{label}<Text style={{ color: theme.colors.foregroundMuted }}>附件链接不可用</Text></View>;
    })}
    {error ? <Text accessibilityRole="alert" style={{ color: theme.colors.statusDanger }}>无法打开附件链接，请在 Multica 查看。</Text> : null}
  </View>;
}
