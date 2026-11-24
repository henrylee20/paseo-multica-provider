import { useEffect, useState } from "react";
import { Text, View } from "react-native";
import { useRpc, type PluginSurfaceProps } from "@getpaseo/plugin/client";
import { SettingsAction, SettingsSection, SettingsSwitch } from "@getpaseo/plugin/client/ui";
import { workspaceCatalog, workspaceRule, type TaskRule } from "../shared/contracts.js";
import type { z } from "zod";

type Catalog = z.output<typeof workspaceCatalog.output>;
const categories = [{ id: "unstarted", name: "未开始" }, { id: "started", name: "进行中" }, { id: "done", name: "已完成" }, { id: "closed", name: "已关闭" }];
const actorName = { member: "成员", agent: "Agent", squad: "Squad" };

function Choices({ title, values, choices, onChange, disabled }: { title: string; values: string[]; choices: Array<{ id: string; name: string }>; onChange(values: string[]): void; disabled: boolean }) {
  const all = [...choices, ...values.filter(id => !choices.some(item => item.id === id)).map(id => ({ id, name: `${id}（当前目录不可用）` }))];
  return <SettingsSection title={title}>
    {all.map(item => <SettingsSwitch key={item.id} label={item.name} value={values.includes(item.id)} disabled={disabled}
      onValueChange={checked => onChange(checked ? [...values, item.id] : values.filter(value => value !== item.id))} />)}
    {!all.length ? <Text>当前没有可选项；不限制此字段。</Text> : null}
  </SettingsSection>;
}

export function WorkspaceRuleEditor({ workspaceId, connectionKey, initialRule, theme, onSaved }: { workspaceId: string; connectionKey?: string; initialRule: TaskRule; theme: PluginSurfaceProps["theme"]; onSaved(): void }) {
  const load = useRpc(workspaceCatalog);
  const save = useRpc(workspaceRule);
  const [catalog, setCatalog] = useState<Catalog | null>(null);
  const [rule, setRule] = useState(initialRule);
  const [failure, setFailure] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    let active = true;
    void load({ workspaceId, connectionKey }).then(result => { if (active) { setCatalog(result); setFailure(null); } }, () => { if (active) setFailure("无法读取筛选目录，请检查连接后重试。"); });
    return () => { active = false; };
  }, [load, workspaceId, connectionKey, attempt]);
  async function persist() {
    setSaving(true);
    try {
      const result = await save({ workspaceId, connectionKey, rule });
      if (result.status === "ready") onSaved();
      else setFailure(result.message ?? "规则同步失败，已保存的规则会在连接恢复后重新核对。");
    } catch { setFailure("规则保存失败，请重试。"); }
    finally { setSaving(false); }
  }
  return <View style={{ gap: 16 }}>
    <Text style={{ color: theme.colors.foregroundMuted }}>字段之间同时满足；同字段可选多项，命中任一即可。标签也是任一命中；不选表示不限。选择具体状态会先清除类别限制；之后仍可组合类别。</Text>
    <Text style={{ color: theme.colors.foregroundMuted }}>直接分配给成员与分配给 Agent / Squad 分别选择。Multica 项目只限制任务范围，任务仍归入此工作区对应的 Paseo 项目。</Text>
    {failure ? <Text accessibilityRole="alert" style={{ color: theme.colors.statusDanger }}>{failure}</Text> : null}
    {!catalog ? <SettingsAction label="读取工作区筛选目录" actionLabel="重试" onPress={() => setAttempt(value => value + 1)} /> : <>
      <Choices title="状态类别" choices={categories} values={rule.statusCategories} disabled={saving} onChange={statusCategories => setRule({ ...rule, statusCategories: statusCategories as TaskRule["statusCategories"] })} />
      <Choices title="具体状态" choices={catalog.statuses.map(item => ({ id: item.key, name: `${item.name} · ${item.category}` }))} values={rule.statuses} disabled={saving} onChange={statuses => setRule({ ...rule, statuses, statusCategories: [] })} />
      <Choices title="负责人" choices={catalog.assignees.map(item => ({ id: `${item.type}:${item.id}`, name: `${actorName[item.type]} · ${item.name}` }))} values={rule.assignees.map(item => `${item.type}:${item.id}`)} disabled={saving}
        onChange={values => setRule({ ...rule, assignees: values.map(value => { const index = value.indexOf(":"); return { type: value.slice(0, index) as TaskRule["assignees"][number]["type"], id: value.slice(index + 1) }; }) })} />
      <Choices title="Multica 项目" choices={catalog.projects} values={rule.projectIds} disabled={saving} onChange={projectIds => setRule({ ...rule, projectIds })} />
      <Choices title="标签" choices={catalog.labels} values={rule.labelIds} disabled={saving} onChange={labelIds => setRule({ ...rule, labelIds })} />
      <SettingsAction label="重新核对任务范围" actionLabel={saving ? "正在保存…" : "保存筛选规则"} disabled={saving} onPress={() => { void persist(); }} />
    </>}
  </View>;
}
