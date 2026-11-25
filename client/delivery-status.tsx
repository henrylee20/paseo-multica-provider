import { useEffect, useState } from "react";
import { Pressable, Text, View } from "react-native";
import { useRpc, type PluginSurfaceProps, type PluginTimelineItemProps } from "@getpaseo/plugin/client";
import { copyText, SettingsAction, SettingsCard, SettingsRow, SettingsSection, SettingsSelect } from "@getpaseo/plugin/client/ui";
import { deliveryMentions, deliveryTargets } from "../shared/delivery.js";
import { CardBody, Notice } from "./ui-kit.js";

type Theme = PluginSurfaceProps["theme"];
type Target = { connectionKey: string; issueId: string; title: string };
const targetKey = (target: { connectionKey: string; issueId: string }) => JSON.stringify([target.connectionKey, target.issueId]);

export function DeliveryStatus({ theme }: PluginTimelineItemProps) {
  return <Text style={{ color: theme.colors.foregroundMuted }}>新 Thread 已建立，可在侧边栏打开。</Text>;
}

/** Shown only while mapped issues exist. A reference names one agent by ID; a bare @name does not. */
export function MentionReferences({ theme, refreshKey, mentionPicker = false }: { theme: Theme; refreshKey: string; mentionPicker?: boolean }) {
  const targets = useRpc(deliveryTargets), mentions = useRpc(deliveryMentions);
  const [issues, setIssues] = useState<Target[]>([]);
  const [selected, setSelected] = useState("");
  const [agents, setAgents] = useState<Array<{ id: string; name: string; reference: string }>>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState<{ id: string; ok: boolean } | null>(null);
  useEffect(() => {
    let active = true;
    void targets({}).then(result => { if (active) setIssues(result.issues); }, () => { if (active) setError("无法读取任务列表。"); });
    return () => { active = false; };
  }, [targets, refreshKey]);
  async function choose(value: string) {
    setSelected(value); setAgents([]); setCopied(null); setError(null);
    const issue = issues.find(item => targetKey(item) === value);
    if (!issue) return;
    setLoading(true);
    try { setAgents((await mentions({ connectionKey: issue.connectionKey, issueId: issue.issueId })).agents); }
    catch { setError("无法读取此任务的 agent 身份，请恢复原连接后重试。"); }
    finally { setLoading(false); }
  }
  async function copy(agent: { id: string; reference: string }) {
    try { await copyText(agent.reference); setCopied({ id: agent.id, ok: true }); } catch { setCopied({ id: agent.id, ok: false }); }
  }
  if (!issues.length && !error) return null;
  const failedCopy = agents.find(agent => copied?.id === agent.id && !copied.ok);
  // Paseo's own `@` suggestions are files, which a plugin cannot replace; the composer control is the picker.
  const route = mentionPicker
    ? "在讨论输入框使用「提及 Agent」，或在此复制引用。"
    : "输入框选择器需要 Paseo 0.16.0，可在此复制完整身份引用。";
  return <SettingsSection title="提及 Agent" info={route}>
    {error ? <Notice theme={theme}>{error}</Notice> : null}
    {issues.length ? <SettingsCard>
      <SettingsSelect label="任务" hint="读取此任务可提及的 agent 身份。" value={selected} onValueChange={value => { void choose(value); }}
        options={[{ label: "选择任务", value: "" }, ...issues.map(issue => ({ label: issue.title, value: targetKey(issue) }))]} />
      {loading ? <SettingsRow key="loading" label="正在读取可提及身份…" /> : null}
      {selected && !loading && !agents.length && !error ? <SettingsRow key="none" label="此任务没有可提及的 agent" /> : null}
      {agents.map(agent => <SettingsAction key={agent.id} label={agent.name}
        actionLabel={copied?.id === agent.id && copied.ok ? "已复制" : "复制引用"} error={copied?.id === agent.id && !copied.ok ? "无法写入剪贴板，请手动选择下方引用。" : null}
        onPress={() => { void copy(agent); }} />)}
      {failedCopy ? <CardBody key="manual"><Text selectable style={{ color: theme.colors.foreground }}>{failedCopy.reference}</Text></CardBody> : null}
    </SettingsCard> : null}
  </SettingsSection>;
}
