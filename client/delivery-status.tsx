import { useEffect, useState } from "react";
import { Pressable, Text, View } from "react-native";
import { useRpc, type PluginSurfaceProps, type PluginTimelineItemProps } from "@getpaseo/plugin/client";
import { copyText, SettingsAction, SettingsCard, SettingsRow, SettingsSection, SettingsSelect } from "@getpaseo/plugin/client/ui";
import type { z } from "zod";
import { deliveryList, deliveryMentions, deliveryRead, deliverySummary, deliveryTargets, deliveryVerify, deliveryResend } from "../shared/delivery.js";
import { collectText } from "./chunked-text.js";
import { formatTime } from "./format.js";
import { CardBody, Notice, SubHeading } from "./ui-kit.js";

type Summary = z.infer<typeof deliverySummary>;
type Theme = PluginSurfaceProps["theme"];
type Target = { connectionKey: string; issueId: string; title: string };
const shortLabels = { received: "已接收", saved: "已保存", failed: "失败", pending_verification: "待核实" };
const needsDecision = (record: Summary) => record.status === "failed" || record.status === "pending_verification";
/** Settled deliveries stay reachable ("继续此 Thread") without pushing the rest of the page down. */
const recentLimit = 3;
const targetKey = (target: { connectionKey: string; issueId: string }) => JSON.stringify([target.connectionKey, target.issueId]);

function PreservedInput({ record, theme }: { record: Summary; theme: Theme }) {
  const read = useRpc(deliveryRead);
  const [text, setText] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [scope] = useState({ active: true });
  useEffect(() => { scope.active = true; return () => { scope.active = false; }; }, [scope]);
  async function load() {
    try {
      const result = await collectText(offset => read({ connectionKey: record.connectionKey, issueId: record.issueId, rootId: record.rootId, clientMessageId: record.clientMessageId, offset }), () => scope.active);
      if (result !== undefined) { setText(result); setError(null); }
    } catch { if (scope.active) setError("无法读取原输入，请重试。"); }
  }
  return <View style={{ gap: 4 }}><Text selectable style={{ color: theme.colors.foreground }}>{text ?? record.body}</Text>
    {record.truncated && text === null ? <Pressable accessibilityRole="button" onPress={() => { void load(); }}><Text style={{ color: theme.colors.foreground }}>读取完整原输入</Text></Pressable> : null}
    {error ? <Text style={{ color: theme.colors.statusDanger }}>{error}</Text> : null}
  </View>;
}

export function DeliveryStatus({ item, theme, openManagement }: PluginTimelineItemProps<Summary> & { openManagement?: () => void }) {
  const record = item.data;
  if (!needsDecision(record)) return record.status === "saved" && record.rootId === "main"
    ? <Text style={{ color: theme.colors.foregroundMuted }}>新 Thread 已建立，可在侧边栏打开。</Text> : null;
  return <View style={{ gap: 6 }}>
    <Text style={{ color: needsDecision(record) ? theme.colors.statusDanger : theme.colors.foregroundMuted }}>{record.status === "failed" ? "投递失败，原输入已保留。" : "投递结果待核实，原输入已保留。"}</Text>
    {record.message ? <Text style={{ color: theme.colors.foregroundMuted }}>{record.message}</Text> : null}
    {needsDecision(record) ? <PreservedInput record={record} theme={theme} /> : null}
    {openManagement ? <Pressable accessibilityRole="button" onPress={openManagement}><Text style={{ color: theme.colors.foreground }}>查看投递记录</Text></Pressable> : null}
  </View>;
}

/** Shown only while delivery records exist or cannot be read; records that need a decision come first. */
export function DeliveryManagement({ theme, navigation, host, refreshKey }: Pick<PluginSurfaceProps, "theme" | "navigation" | "host"> & { refreshKey: string }) {
  const verify = useRpc(deliveryVerify), resend = useRpc(deliveryResend);
  const list = useRpc(deliveryList), targets = useRpc(deliveryTargets);
  const [confirming, setConfirming] = useState<{ key: string; requestId: string } | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [records, setRecords] = useState<Summary[]>([]);
  const [issues, setIssues] = useState<Target[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [loadFailed, setLoadFailed] = useState(false);
  const [showAll, setShowAll] = useState(false);
  useEffect(() => {
    let active = true;
    const update = async () => {
      try { const [deliveries, mappings] = await Promise.all([list({}), targets({})]); if (active) { setRecords(deliveries.records); setIssues(mappings.issues); setLoadFailed(false); } }
      catch { if (active) setLoadFailed(true); }
    };
    void update(); const timer = setInterval(() => { void update(); }, 3000);
    return () => { active = false; clearInterval(timer); };
  }, [list, targets, refreshKey]);
  const address = (record: Summary) => ({ connectionKey: record.connectionKey, issueId: record.issueId, rootId: record.rootId, clientMessageId: record.clientMessageId });
  async function check(record: Summary) {
    setBusy(record.idempotencyKey);
    try { const result = await verify(address(record)); setRecords((await list({})).records); setError(result.status === "pending_verification" ? result.message ?? "原投递仍待核实。" : null); }
    catch { setError("无法核实此投递，请恢复原 Multica 连接后重试。"); }
    finally { setBusy(null); }
  }
  async function sendAgain(record: Summary) {
    if (!confirming || confirming.key !== record.idempotencyKey) return;
    setBusy(record.idempotencyKey);
    try {
      await resend({ ...address(record), requestId: confirming.requestId, acknowledgeDuplicateRisk: true });
      setConfirming(null); setRecords((await list({})).records); setError(null);
    } catch { setError("重发未确认，请保持原连接后重试本次决定；原记录仍保留。"); }
    finally { setBusy(null); }
  }
  if (!records.length && !error && !loadFailed) return null;
  const newestFirst = [...records].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  const pending = newestFirst.filter(needsDecision);
  const settled = newestFirst.filter(record => !needsDecision(record));
  const visibleSettled = showAll ? settled : settled.slice(0, recentLimit);
  const titleOf = (record: Summary) => issues.find(issue => targetKey(issue) === targetKey(record))?.title ?? `Issue ${record.issueId}`;
  const toneOf = (record: Summary) => needsDecision(record) ? theme.colors.statusDanger : record.status === "saved" ? theme.colors.statusSuccess : theme.colors.foregroundMuted;
  const card = (record: Summary) => {
    const confirmingThis = confirming?.key === record.idempotencyKey;
    return <SettingsCard key={`${record.connectionKey}:${record.issueId}:${record.idempotencyKey}`}>
      <SettingsRow label={titleOf(record)} hint={`${formatTime(record.createdAt)} · ${record.rootId === "main" ? "主讨论" : "Thread"}`}>
        <Text style={{ color: toneOf(record) }}>{shortLabels[record.status]}</Text>
      </SettingsRow>
      <CardBody>
        <DeliveryStatus item={{ type: "plugin", kind: "comment-delivery", version: 1, data: record }} theme={theme} host={host} layout={{ compact: false, platform: "web" }} agentId="" timestamp={new Date(record.createdAt)} />
      </CardBody>
      {needsDecision(record) ? [
        <SettingsAction key="verify" label="查询原回执" hint="查询原评论的保存结果。" actionLabel="核实原投递" disabled={busy !== null} onPress={() => { void check(record); }} />,
        confirmingThis ? <CardBody key="warning"><Text accessibilityRole="alert" style={{ color: theme.colors.statusDanger }}>原评论可能已经发表。另发一次可能重复触发执行；请先在原服务核实，再决定是否创建新请求。</Text></CardBody> : null,
        confirmingThis ? <SettingsAction key="confirm" label="另发一次" hint="另发一条相同评论。" actionLabel="确认另发一次" disabled={busy !== null} onPress={() => { void sendAgain(record); }} /> : null,
        confirmingThis ? <SettingsAction key="cancel" label="保留原记录" hint="不创建新请求。" actionLabel="取消重发" disabled={busy !== null} onPress={() => setConfirming(null)} /> : null,
        !confirmingThis ? <SettingsAction key="resend" label="另发一次" hint="可能重复评论及执行。" actionLabel="重新发送…" disabled={busy !== null}
          onPress={() => setConfirming({ key: record.idempotencyKey, requestId: `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}` })} /> : null,
      ] : null}
      {record.status === "saved" && record.threadAgentId && navigation ? <SettingsAction label="新 Thread 已建立" hint="打开已建立的 Thread。" actionLabel="继续此 Thread"
        onPress={() => navigation.openAgent({ agentId: record.threadAgentId!, serverId: host.id })} /> : null}
    </SettingsCard>;
  };
  return <SettingsSection title="评论投递" info="核实失败或待确认的投递结果。">
    {loadFailed ? <Notice theme={theme}>无法读取投递记录，已显示的记录仍保留。</Notice> : null}
    {error ? <Notice theme={theme}>{error}</Notice> : null}
    {pending.length ? <SubHeading theme={theme}>需要处理 · {pending.length}</SubHeading> : null}
    {pending.map(card)}
    {settled.length ? <SubHeading theme={theme}>最近投递</SubHeading> : null}
    {visibleSettled.map(card)}
    {settled.length > recentLimit ? <SettingsCard>
      <SettingsAction label={showAll ? `共 ${settled.length} 条` : `另有 ${settled.length - recentLimit} 条更早的记录`} actionLabel={showAll ? "收起" : "显示全部"} onPress={() => setShowAll(value => !value)} />
    </SettingsCard> : null}
  </SettingsSection>;
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
