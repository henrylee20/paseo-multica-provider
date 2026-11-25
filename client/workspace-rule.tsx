import { useEffect, useState } from "react";
import { Text, View } from "react-native";
import { useRpc, type PluginSurfaceProps } from "@getpaseo/plugin/client";
import { SettingsAction, SettingsCard, SettingsRow, SettingsSwitch } from "@getpaseo/plugin/client/ui";
import { workspaceCatalog, workspaceRule, type TaskRule } from "../shared/contracts.js";
import { SubHeading } from "./ui-kit.js";
import type { z } from "zod";

type Catalog = z.output<typeof workspaceCatalog.output>;
type Theme = PluginSurfaceProps["theme"];
type Choice = { id: string; name: string };

const categories: Array<{ id: TaskRule["statusCategories"][number]; name: string }> = [
  { id: "unstarted", name: "未开始" }, { id: "started", name: "进行中" }, { id: "done", name: "已完成" }, { id: "closed", name: "已关闭" }];
const actorName = { member: "成员", agent: "Agent", squad: "Squad" };
/** Long catalogs (labels, members) stay readable: the rest is one press away, selected items always show. */
const collapsedLimit = 8;

const categoryNames = (ids: string[]) => ids.map(id => categories.find(item => item.id === id)?.name ?? id).join("、");

/** A one-line reading of a saved rule that needs no catalog request. */
export function describeRule(rule: TaskRule) {
  const parts = [rule.statuses.length ? `具体状态 ${rule.statuses.length} 项` : rule.statusCategories.length ? categoryNames(rule.statusCategories) : "状态不限"];
  const limited = ([["负责人", rule.assignees.length], ["Multica 项目", rule.projectIds.length], ["标签", rule.labelIds.length]] as const).filter(([, count]) => count > 0);
  parts.push(...limited.map(([name, count]) => `${name} ${count} 项`));
  if (!limited.length) parts.push("其他条件不限");
  return parts.join(" · ");
}

function Choices({ title, values, choices, onChange, disabled, theme }: { title: string; values: string[]; choices: Choice[]; onChange(values: string[]): void; disabled: boolean; theme: Theme }) {
  const [expanded, setExpanded] = useState(false);
  const all = [...choices, ...values.filter(id => !choices.some(item => item.id === id)).map(id => ({ id, name: `${id}（当前目录不可用）` }))];
  const visible = expanded ? all : all.filter((item, index) => index < collapsedLimit || values.includes(item.id));
  return <View style={{ gap: 8 }}>
    <SubHeading theme={theme}>{title} · {values.length ? `已选 ${values.length} 项` : "不限"}</SubHeading>
    <SettingsCard>
      {visible.map(item => <SettingsSwitch key={item.id} label={item.name} value={values.includes(item.id)} disabled={disabled}
        onValueChange={checked => onChange(checked ? [...values, item.id] : values.filter(value => value !== item.id))} />)}
      {!all.length ? <SettingsRow key="empty" label="当前没有可选项" hint="不限制此字段。" /> : null}
      {all.length > collapsedLimit ? <SettingsAction key="more" label={expanded ? `共 ${all.length} 项` : `另有 ${all.length - visible.length} 项未显示`}
        actionLabel={expanded ? "收起" : "显示全部"} onPress={() => setExpanded(value => !value)} /> : null}
    </SettingsCard>
  </View>;
}

export function WorkspaceRuleEditor({ workspaceId, connectionKey, initialRule, theme, onSaved, onCancel, onDirtyChange }: {
  workspaceId: string; connectionKey?: string; initialRule: TaskRule; theme: Theme; onSaved(rule: TaskRule): void; onCancel(): void; onDirtyChange?(dirty: boolean): void;
}) {
  const load = useRpc(workspaceCatalog);
  const save = useRpc(workspaceRule);
  const [catalog, setCatalog] = useState<Catalog | null>(null);
  const [rule, setRule] = useState(initialRule);
  const [catalogFailed, setCatalogFailed] = useState(false);
  const [saveFailure, setSaveFailure] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    let active = true;
    void load({ workspaceId, connectionKey }).then(result => { if (active) { setCatalog(result); setCatalogFailed(false); } }, () => { if (active) setCatalogFailed(true); });
    return () => { active = false; };
  }, [load, workspaceId, connectionKey, attempt]);
  function update(next: TaskRule) {
    setRule(next);
    onDirtyChange?.(JSON.stringify(next) !== JSON.stringify(initialRule));
  }
  const statuses = catalog && rule.statusCategories.length
    ? catalog.statuses.filter(item => rule.statusCategories.some(category => category === item.category) && (!rule.statuses.length || rule.statuses.includes(item.key))).map(item => item.key)
    : rule.statuses;
  async function persist() {
    setSaving(true);
    try {
      const savedRule = { ...rule, statuses, statusCategories: [] };
      const result = await save({ workspaceId, connectionKey, rule: savedRule });
      if (result.status === "ready") { onDirtyChange?.(false); onSaved(savedRule); }
      else setSaveFailure(result.message ?? "规则同步失败，已保存的规则会在连接恢复后重新核对。");
    } catch { setSaveFailure("规则保存失败，请重试。"); }
    finally { setSaving(false); }
  }
  const muted = { color: theme.colors.foregroundMuted, marginHorizontal: 4 };
  if (!catalog) return <SettingsCard>
    {catalogFailed ? <SettingsAction label="无法读取筛选目录" hint="请检查连接后重试。" actionLabel="重试" onPress={() => setAttempt(value => value + 1)} />
      : <SettingsRow label="正在读取筛选目录…" />}
  </SettingsCard>;
  return <View style={{ gap: 16 }}>
    <Text style={muted}>字段之间同时满足；同一字段多选时任一命中；不选表示不限。</Text>
    <Choices title="状态" theme={theme} values={statuses} disabled={saving}
      choices={catalog.statuses.map(item => ({ id: item.key, name: `${item.name} · ${categories.find(category => category.id === item.category)?.name ?? item.category}` }))}
      onChange={statuses => update({ ...rule, statuses, statusCategories: [] })} />
    <Choices title="负责人" theme={theme} disabled={saving} values={rule.assignees.map(item => `${item.type}:${item.id}`)}
      choices={catalog.assignees.map(item => ({ id: `${item.type}:${item.id}`, name: `${actorName[item.type]} · ${item.name}` }))}
      onChange={values => update({ ...rule, assignees: values.map(value => { const index = value.indexOf(":"); return { type: value.slice(0, index) as TaskRule["assignees"][number]["type"], id: value.slice(index + 1) }; }) })} />
    <Choices title="Multica 项目" theme={theme} choices={catalog.projects} values={rule.projectIds} disabled={saving} onChange={projectIds => update({ ...rule, projectIds })} />
    <Choices title="标签" theme={theme} choices={catalog.labels} values={rule.labelIds} disabled={saving} onChange={labelIds => update({ ...rule, labelIds })} />
    <SettingsCard>
      <SettingsAction label="保存并重新核对" hint="按新条件核对此 Multica 工作区的任务范围；退出范围的任务自动归档。" error={saveFailure}
        actionLabel={saving ? "正在保存…" : "保存筛选规则"} disabled={saving} onPress={() => { void persist(); }} />
      <SettingsAction label="放弃修改" hint="恢复为已保存的条件。" actionLabel="取消" disabled={saving} onPress={() => { onDirtyChange?.(false); onCancel(); }} />
    </SettingsCard>
  </View>;
}
