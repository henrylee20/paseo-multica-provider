import { useEffect, useState, type ReactNode } from "react";
import { useAgent, useRpc, type PluginClientContext, type PluginTimelineItemProps } from "@getpaseo/plugin/client";
import { ExternalLink, Icon, Markdown, SettingsAction } from "@getpaseo/plugin/client/ui";
import { Text, View } from "react-native";
import type { z } from "zod";
import { readTaskDescription, taskDescriptionSchema } from "../shared/description.js";
import { collectText } from "./chunked-text.js";
import { formatDate } from "./format.js";
import { HeaderAction } from "./ui-kit.js";

type DescriptionProps = PluginTimelineItemProps<z.output<typeof taskDescriptionSchema>> & { client: PluginClientContext };

function Pill({ theme, color = theme.colors.foregroundMuted, backgroundColor = theme.colors.surface2, children }: { theme: DescriptionProps["theme"]; color?: string; backgroundColor?: string; children: ReactNode }) {
  return <View style={{ paddingHorizontal: 8, paddingVertical: 2, borderRadius: 10, backgroundColor }}>
    <Text style={{ color, fontSize: 12 }}>{children}</Text>
  </View>;
}

function MetaRow({ theme, label, value }: { theme: DescriptionProps["theme"]; label: string; value?: string }) {
  return value ? <View style={{ flexDirection: "row", gap: 12 }}>
    <Text style={{ color: theme.colors.foregroundMuted, fontSize: 13, width: 84 }}>{label}</Text>
    <Text style={{ color: theme.colors.foreground, fontSize: 14, flex: 1 }}>{value}</Text>
  </View> : null;
}

export function TaskDescription(props: DescriptionProps) {
  const { connectionKey, issueId, revision } = props.item.data;
  return <TaskDescriptionBody key={`${connectionKey}:${issueId}:${revision}`} {...props} />;
}

function TaskDescriptionBody({ agentId, item, theme, layout, client }: DescriptionProps) {
  const read = useRpc(readTaskDescription);
  const workspaceId = useAgent(agentId, agent => agent.workspaceId);
  const [fullDescription, setFullDescription] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [scope] = useState({ active: true });
  const [expanded, setExpanded] = useState(false);
  const { overview } = item.data;
  const text = fullDescription ?? item.data.preview;
  const paragraphs = text.split(/\r?\n(?:[\t ]*\r?\n)+/).filter(paragraph => paragraph.trim());
  const firstBody = paragraphs.findIndex(paragraph => !paragraph.split(/\r?\n/).filter(line => line.trim()).every(line => /^ {0,3}#{1,6}(?:\s|$)/.test(line)));
  const visibleParagraphs = firstBody < 0 ? paragraphs.length : firstBody + 1;
  const collapsed = paragraphs.slice(0, visibleParagraphs).join("\n\n");
  const canExpand = visibleParagraphs < paragraphs.length || (item.data.truncated && fullDescription === null);
  const statusColor = overview?.statusCategory === "started" ? theme.colors.accentForeground
    : overview?.statusCategory === "done" ? theme.colors.statusSuccess : theme.colors.foregroundMuted;
  const priorities = { urgent: "紧急", high: "高", medium: "中", low: "低", none: "无优先级" };
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
  return <View style={{ borderWidth: 1, borderColor: theme.colors.border, borderRadius: 12, backgroundColor: theme.colors.surface1, padding: 14, gap: 12 }}>
    {overview ? <>
      <View style={{ flexDirection: "row", flexWrap: "wrap", alignItems: "center", gap: 8 }}>
        {overview.identifier ? <Text style={{ color: theme.colors.foregroundMuted, fontSize: 13 }}>{overview.identifier}</Text> : null}
        {overview.statusName ? <Pill theme={theme} color={statusColor} backgroundColor={overview.statusCategory === "started" ? theme.colors.accent : theme.colors.surface2}>{overview.statusName}</Pill> : null}
        {overview.priority && overview.priority !== "none" ? <Pill theme={theme}>优先级 {priorities[overview.priority]}</Pill> : null}
        {overview.dueDate ? <Pill theme={theme}>截止 {formatDate(overview.dueDate)}</Pill> : null}
      </View>
      <View style={{ gap: 4 }}>
        <MetaRow theme={theme} label="负责人" value={overview.assigneeName} />
        <MetaRow theme={theme} label="Multica 项目" value={overview.projectName} />
        {overview.labels?.length ? <View style={{ flexDirection: "row", gap: 12 }}>
          <Text style={{ color: theme.colors.foregroundMuted, fontSize: 13, width: 84 }}>标签</Text>
          <View style={{ flex: 1, flexDirection: "row", flexWrap: "wrap", gap: 6 }}>
            {overview.labels.map((label, index) => <Pill key={index} theme={theme}>{label}</Pill>)}
          </View>
        </View> : null}
      </View>
      <View style={{ height: 1, backgroundColor: theme.colors.border }} />
    </> : null}
    <View style={{ gap: 8 }}>
      <Text style={{ color: theme.colors.foregroundMuted, fontSize: 13 }}>任务描述</Text>
      <Markdown>{text.trim() ? expanded ? text : collapsed : "（此任务暂无描述）"}</Markdown>
      {canExpand ? <HeaderAction theme={theme} label={expanded ? "收起" : "展开全文"} icon={expanded ? "ChevronUp" : "ChevronDown"} onPress={() => setExpanded(value => !value)} /> : null}
      {expanded && item.data.truncated && fullDescription === null ? <SettingsAction label="描述较长，当前仅显示预览。"
        actionLabel={loading ? "正在读取…" : "读取完整描述"} disabled={loading} onPress={() => { void load(); }} /> : null}
    </View>
    {overview?.url || workspaceId ? <>
      <View style={{ height: 1, backgroundColor: theme.colors.border }} />
      <View style={{ flexDirection: "row", flexWrap: "wrap", alignItems: "center", gap: 18 }}>
        {workspaceId ? <HeaderAction theme={theme} label="讨论列表" icon="PanelRight" onPress={() => client.openPanel("discussion-list", { workspaceId, location: layout.compact ? "workspace" : "explorer" })} /> : null}
        {overview?.url ? <ExternalLink href={overview.url} onError={() => setError("无法打开 Multica 链接，请重试。")}>
          <View style={{ flexDirection: "row", alignItems: "center", gap: 4, marginRight: 4 }}>
            <Icon name="ExternalLink" size={14} color={theme.colors.foregroundMuted} />
            <Text style={{ color: theme.colors.foregroundMuted, fontSize: 13 }}>在 Multica 打开</Text>
          </View>
        </ExternalLink> : null}
      </View>
    </> : null}
    {error ? <Text accessibilityRole="alert" style={{ color: theme.colors.statusDanger }}>{error}</Text> : null}
  </View>;
}
