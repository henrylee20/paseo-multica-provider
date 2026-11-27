import { useEffect, useState } from "react";
import { Image, Text, View } from "react-native";
import { useRpc, type PluginClientContext, type PluginPanelLocation, type PluginWorkspacePanelProps } from "@getpaseo/plugin/client";
import { ExternalLink, Loading, Markdown, ScrollView } from "@getpaseo/plugin/client/ui";
import { z } from "zod";
import { attachmentPreview, type AttachmentPreview } from "../shared/attachments.js";
import { deliveredAttachment } from "../shared/delivery.js";
import { formatSize } from "./format.js";

const selectionSchema = z.object({ connectionKey: z.string(), issueId: z.string(), attachment: deliveredAttachment });
type Selection = z.infer<typeof selectionSchema>;
const selections = new Map<string, Selection>();

export function openAttachmentPreview(client: PluginClientContext, workspaceId: string, selection: Selection, location: PluginPanelLocation) {
  selections.set(workspaceId, selection);
  client.openPanel("attachment-preview", { workspaceId, location });
}

export function AttachmentPreviewPanel({ workspaceId, revision, tab, theme, layout }: PluginWorkspacePanelProps) {
  const saved = selectionSchema.safeParse(tab.state);
  const selection = selections.get(workspaceId) ?? (saved.success ? saved.data : undefined);
  useEffect(() => {
    const current = selections.get(workspaceId);
    if (current) tab.setState(current);
  }, [workspaceId, revision]);
  if (!selection) return <Text style={{ color: theme.colors.foregroundMuted, padding: 16 }}>请选择投递卡片中的附件。</Text>;
  const { attachment } = selection;
  return <View style={{ flex: 1, padding: 16, gap: 8 }}>
    <Text selectable style={{ color: theme.colors.foreground }}>{attachment.name}</Text>
    <Text style={{ color: theme.colors.foregroundMuted }}>{attachment.mimeType} · {formatSize(attachment.size)}</Text>
    {attachment.url ? <ExternalLink href={attachment.url}><Text style={{ color: theme.colors.foreground }}>在 Multica 查看</Text></ExternalLink> : null}
    <PreviewBody key={JSON.stringify([workspaceId, selection.connectionKey, selection.issueId, attachment.id])} selection={selection} theme={theme} layout={layout} />
  </View>;
}

function PreviewBody({ selection, theme, layout }: { selection: Selection } & Pick<PluginWorkspacePanelProps, "theme" | "layout">) {
  const read = useRpc(attachmentPreview);
  const [result, setResult] = useState<AttachmentPreview | null>(null);
  const [error, setError] = useState<string | null>(null);
  const { connectionKey, issueId, attachment } = selection;
  useEffect(() => {
    let active = true;
    void read({ connectionKey, issueId, attachmentId: attachment.id }).then(value => { if (active) setResult(value); },
      failure => { if (active) setError(failure instanceof Error ? failure.message : "附件预览失败，请稍后重试。"); });
    return () => { active = false; };
  }, [read, connectionKey, issueId, attachment.id]);
  if (error) return <Text accessibilityRole="alert" style={{ color: theme.colors.statusDanger }}>{error}</Text>;
  if (!result) return <Loading />;
  if (result.kind === "unsupported") return <Text style={{ color: theme.colors.foregroundMuted }}>{result.reason ?? "此类型暂不支持预览，请在 Multica 查看。"}</Text>;
  if (result.kind === "image") return <Image accessibilityLabel={result.name} source={{ uri: `data:${result.mimeType};base64,${result.data}` }} resizeMode="contain" style={{ flex: 1, width: "100%", minHeight: 160 }} />;
  return <ScrollView style={{ flex: 1 }} contentContainerStyle={{ gap: 8 }}>
    {result.truncated ? <Text style={{ color: theme.colors.foregroundMuted }}>仅显示前 1 MiB</Text> : null}
    {result.kind === "markdown" ? <Markdown>{result.text}</Markdown>
      : <Text selectable style={{ color: theme.colors.foreground, fontFamily: layout.platform === "ios" ? "Menlo" : "monospace" }}>{result.text}</Text>}
  </ScrollView>;
}
