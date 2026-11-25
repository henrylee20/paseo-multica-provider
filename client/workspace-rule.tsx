import { useState, type ReactNode } from "react";
import { Pressable, Text, View } from "react-native";
import { useRpc, type PluginSurfaceProps } from "@getpaseo/plugin/client";
import { Icon, Modal, ScrollView, TextInput } from "@getpaseo/plugin/client/ui";
import { workspaceCatalog, workspaceEnable, workspaceRule, type TaskRule } from "../shared/contracts.js";
import { RuleButton } from "./ui-kit.js";
import type { z } from "zod";

export type Catalog = z.output<typeof workspaceCatalog.output>;
type Theme = PluginSurfaceProps["theme"];
type Category = TaskRule["statusCategories"][number];
type Choice = { id: string; name: string; group?: string; missing?: boolean };
type StatusSelection = { whole: Set<Category>; picked: Set<string> };
const categories: Array<{ id: Category; name: string }> = [
  { id: "unstarted", name: "未开始" }, { id: "started", name: "进行中" }, { id: "done", name: "已完成" }, { id: "closed", name: "已关闭" }];
const actorNames = { member: "成员", agent: "Agent", squad: "Squad" };
const categoryNames = (ids: string[]) => ids.map(id => categories.find(item => item.id === id)?.name ?? id).join("、");

/** A one-line reading of a saved rule that needs no catalog request. */
export function describeRule(rule: TaskRule) {
  const parts = [rule.statuses.length ? `具体状态 ${rule.statuses.length} 项` : rule.statusCategories.length ? categoryNames(rule.statusCategories) : "状态不限"];
  if (rule.statuses.length && rule.statusCategories.length) parts.push(`类别 ${categoryNames(rule.statusCategories)}`);
  const limited = ([["负责人", rule.assignees.length], ["Multica 项目", rule.projectIds.length], ["标签", rule.labelIds.length]] as const).filter(([, count]) => count > 0);
  parts.push(...limited.map(([name, count]) => `${name} ${count} 项`));
  if (!limited.length) parts.push("其他条件不限");
  return parts.join(" · ");
}

export function describeCatalogRule(rule: TaskRule, catalog: Catalog, userId?: string) {
  const names = (ids: string[], choices: Choice[]) => ids.length ? ids.map(id => choices.find(item => item.id === id)?.name ?? id).join("、") : "不限";
  const statuses = rule.statuses.length ? rule.statuses.filter(key => !rule.statusCategories.length || catalog.statuses.some(status => status.key === key && rule.statusCategories.includes(status.category as Category))) : [];
  return [
    `状态 ${rule.statuses.length ? statuses.length ? names(statuses, catalog.statuses.map(item => ({ id: item.key, name: item.name }))) : "无匹配状态" : rule.statusCategories.length ? categoryNames(rule.statusCategories) : "不限"}`,
    `负责人 ${names(rule.assignees.map(item => `${item.type}:${item.id}`), catalog.assignees.map(item => ({ id: `${item.type}:${item.id}`, name: item.type === "member" && item.id === userId ? "我" : item.name })))}`,
    `标签 ${names(rule.labelIds, catalog.labels)}`, `Multica 项目 ${names(rule.projectIds, catalog.projects)}`,
  ].join(" · ");
}

function promote(selection: StatusSelection, catalog: Catalog) {
  for (const category of categories) {
    const statuses = catalog.statuses.filter(item => item.category === category.id);
    if (statuses.length && statuses.every(item => selection.picked.has(item.key))) {
      selection.whole.add(category.id);
      statuses.forEach(item => selection.picked.delete(item.key));
    }
  }
  return selection;
}

function readStatuses(rule: TaskRule, catalog: Catalog): StatusSelection {
  // Legacy mixed rules are an intersection, never a union of categories and statuses.
  if (rule.statuses.length) return promote({ whole: new Set(), picked: new Set(rule.statuses.filter(key => !rule.statusCategories.length || catalog.statuses.some(item => item.key === key && rule.statusCategories.includes(item.category as Category)))) }, catalog);
  return { whole: new Set(rule.statusCategories), picked: new Set() };
}

function writeStatuses(selection: StatusSelection, catalog: Catalog) {
  return selection.picked.size
    ? { statusCategories: [], statuses: [...new Set([...selection.picked, ...catalog.statuses.filter(item => selection.whole.has(item.category as Category)).map(item => item.key)])] }
    : { statusCategories: categories.filter(item => selection.whole.has(item.id)).map(item => item.id), statuses: [] };
}

const fingerprint = (rule: TaskRule) => JSON.stringify({ ...rule, statusCategories: [...rule.statusCategories].sort(), statuses: [...rule.statuses].sort(),
  assignees: rule.assignees.map(item => `${item.type}:${item.id}`).sort(), projectIds: [...rule.projectIds].sort(), labelIds: [...rule.labelIds].sort() });

function Chip({ choice, checked, onPress, disabled, theme }: { choice: Choice; checked: boolean; onPress(): void; disabled: boolean; theme: Theme }) {
  return <Pressable accessibilityRole="checkbox" accessibilityLabel={choice.name} accessibilityState={{ checked }} disabled={disabled} onPress={onPress}
    style={{ flexDirection: "row", alignItems: "center", gap: 4, paddingHorizontal: 10, paddingVertical: 5, borderRadius: 20, borderWidth: 1,
      borderStyle: choice.missing ? "dashed" : "solid", borderColor: checked ? theme.colors.accent : theme.colors.border,
      backgroundColor: checked ? theme.colors.surface2 : theme.colors.surface0, opacity: disabled ? 0.5 : 1 }}>
    {checked ? <Icon name="Check" size={12} color={theme.colors.accent} /> : null}
    <Text style={{ color: checked ? theme.colors.accent : theme.colors.foreground, fontSize: 13, flexShrink: 1 }}>{choice.name}</Text>
  </Pressable>;
}

function FieldHeading({ title, theme, children }: { title: string; theme: Theme; children: ReactNode }) {
  return <View style={{ flexDirection: "row", justifyContent: "space-between", alignItems: "center", flexWrap: "wrap", gap: 8 }}>
    <Text style={{ color: theme.colors.foreground, fontSize: 14 }}>{title}</Text>{children}
  </View>;
}

function Search({ title, value, onChange, theme, disabled }: { title: string; value: string; onChange(value: string): void; theme: Theme; disabled: boolean }) {
  return <TextInput accessibilityLabel={`搜索${title}`} placeholder={`搜索${title}`} value={value} onChangeText={onChange} editable={!disabled}
    placeholderTextColor={theme.colors.foregroundMuted} style={{ backgroundColor: theme.colors.surface2, color: theme.colors.foreground, borderRadius: 8, paddingHorizontal: 10, paddingVertical: 8, fontSize: 13 }} />;
}

function Choices({ title, values, choices, onChange, disabled, theme, groups }: { title: string; values: string[]; choices: Choice[]; onChange(values: string[]): void; disabled: boolean; theme: Theme; groups?: string[] }) {
  const [query, setQuery] = useState("");
  const all: Choice[] = [...choices, ...values.filter(id => !choices.some(item => item.id === id)).map(id => ({ id,
    name: `${groups ? id.slice(id.indexOf(":") + 1) : id}（已不在目录）`, missing: true, group: groups ? actorNames[id.slice(0, id.indexOf(":")) as keyof typeof actorNames] : undefined }))];
  const visible = all.filter(item => values.includes(item.id) || item.name.toLocaleLowerCase().includes(query.toLocaleLowerCase()));
  const chips = (items: Choice[]) => <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 6 }}>{items.map(item => <Chip key={item.id} choice={item} checked={values.includes(item.id)} disabled={disabled} theme={theme}
    onPress={() => onChange(values.includes(item.id) ? values.filter(id => id !== item.id) : [...values, item.id])} />)}</View>;
  return <View style={{ gap: 8 }}>
    <FieldHeading title={title} theme={theme}><View style={{ flexDirection: "row", gap: 8, alignItems: "center" }}>
      <Text style={{ color: theme.colors.foregroundMuted, fontSize: 12 }}>{values.length ? `已选 ${values.length} 项` : "不限"}</Text>
      {values.length ? <Pressable accessibilityRole="button" accessibilityLabel={`清除${title}`} disabled={disabled} onPress={() => onChange([])}><Text style={{ color: theme.colors.accent, fontSize: 12 }}>清除</Text></Pressable> : null}
    </View></FieldHeading>
    <View style={{ gap: 10, ...(groups ? { padding: 12, borderWidth: 1, borderColor: theme.colors.border, borderRadius: 12, backgroundColor: theme.colors.surface1 } : {}) }}>
      {all.length > 8 ? <Search title={title} value={query} onChange={setQuery} theme={theme} disabled={disabled} /> : null}
      {groups ? <>
        {groups.map(group => <View key={group} style={{ gap: 6 }}><Text style={{ color: theme.colors.foregroundMuted, fontSize: 12 }}>{group}</Text>{chips(visible.filter(item => item.group === group))}</View>)}
        {chips(visible.filter(item => !item.group))}
      </> : chips(visible)}
      {!visible.length ? <Text style={{ color: theme.colors.foregroundMuted, fontSize: 12 }}>{all.length ? "没有匹配的选项" : "当前没有可选项，不限制此字段。"}</Text> : null}
    </View>
  </View>;
}

function StatusChoices({ value, onChange, catalog, disabled, theme }: { value: StatusSelection; onChange(value: StatusSelection): void; catalog: Catalog; disabled: boolean; theme: Theme }) {
  const [query, setQuery] = useState("");
  const missing = [...value.picked].filter(key => !catalog.statuses.some(item => item.key === key)).map(key => ({ id: key, name: `${key}（已不在目录）`, missing: true }));
  function toggleStatus(key: string) {
    const next = { whole: new Set(value.whole), picked: new Set(value.picked) };
    const category = catalog.statuses.find(item => item.key === key)?.category as Category | undefined;
    if (category && next.whole.has(category)) {
      next.whole.delete(category);
      catalog.statuses.filter(item => item.category === category && item.key !== key).forEach(item => next.picked.add(item.key));
    } else if (next.picked.has(key)) next.picked.delete(key);
    else next.picked.add(key);
    onChange(promote(next, catalog));
  }
  const chip = (item: Choice, checked: boolean) => checked || item.name.toLocaleLowerCase().includes(query.toLocaleLowerCase())
    ? <Chip key={item.id} choice={item} checked={checked} onPress={() => toggleStatus(item.id)} disabled={disabled} theme={theme} /> : null;
  return <View style={{ gap: 8 }}>
    <FieldHeading title="状态" theme={theme}><Text style={{ color: value.picked.size ? theme.colors.statusWarning : theme.colors.foregroundMuted, fontSize: 12 }}>
      {value.picked.size ? "部分选择 · 按具体状态保存" : "按类别 · 今后新增的状态自动纳入"}
    </Text></FieldHeading>
    {catalog.statuses.length + missing.length > 8 ? <Search title="状态" value={query} onChange={setQuery} theme={theme} disabled={disabled} /> : null}
    <View style={{ borderWidth: 1, borderColor: theme.colors.border, borderRadius: 12, paddingHorizontal: 12, backgroundColor: theme.colors.surface1 }}>
      {categories.map((category, index) => {
        const statuses = catalog.statuses.filter(item => item.category === category.id);
        const checked = value.whole.has(category.id) ? true : statuses.some(item => value.picked.has(item.key)) ? "mixed" : false;
        return <View key={category.id} style={{ flexDirection: "row", alignItems: "center", gap: 12, paddingVertical: 8, borderTopWidth: index ? 1 : 0, borderColor: theme.colors.border }}>
          <Pressable accessibilityRole="checkbox" accessibilityLabel={category.name} accessibilityState={{ checked }} disabled={disabled}
            onPress={() => { const whole = new Set(value.whole), picked = new Set(value.picked); if (checked === true) whole.delete(category.id); else whole.add(category.id); statuses.forEach(item => picked.delete(item.key)); onChange({ whole, picked }); }}
            style={{ flexDirection: "row", alignItems: "center", gap: 7, width: 84, opacity: disabled ? 0.5 : 1 }}>
            <View style={{ width: 15, height: 15, borderRadius: 4, borderWidth: 1, borderColor: checked ? theme.colors.accent : theme.colors.foregroundMuted, backgroundColor: checked ? theme.colors.accent : theme.colors.surface0, alignItems: "center", justifyContent: "center" }}>
              {checked ? <Icon name={checked === "mixed" ? "Minus" : "Check"} size={12} color={theme.colors.accentForeground} /> : null}
            </View><Text style={{ color: theme.colors.foreground, fontSize: 13 }}>{category.name}</Text>
          </Pressable>
          <View style={{ flexDirection: "row", flexWrap: "wrap", flex: 1, gap: 6 }}>{statuses.map(item => chip({ id: item.key, name: item.name }, value.whole.has(category.id) || value.picked.has(item.key)))}</View>
        </View>;
      })}
    </View>
    <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 6 }}>
      {catalog.statuses.filter(item => !categories.some(category => category.id === item.category)).map(item => chip({ id: item.key, name: item.name }, value.picked.has(item.key)))}
      {missing.map(item => chip(item, true))}
    </View>
    {value.picked.size ? <Text style={{ color: theme.colors.statusWarning, fontSize: 12 }}>只选了部分状态，规则将按具体状态保存；今后新增的状态不会自动纳入。</Text> : null}
  </View>;
}

type EditorProps = {
  workspaceId: string; workspaceName: string; connectionKey: string; initialRule: TaskRule; theme: Theme; userId?: string; enabling: boolean;
  onRuleSaved(rule: TaskRule): void; onSaved(rule: TaskRule): void; onCancel(): void; onSavingChange(value: boolean): void;
};

export function WorkspaceRuleEditor(props: EditorProps & { catalog?: Catalog; catalogFailed?: boolean; onRetry(): void }) {
  if (props.catalog) return <RuleEditor {...props} catalog={props.catalog} />;
  return <Modal title={`${props.enabling ? "启用" : "筛选条件"} · ${props.workspaceName}`} open onOpenChange={open => { if (!open) props.onCancel(); }}>
    <Modal.Content>
      <Text style={{ color: props.theme.colors.foregroundMuted }}>{props.catalogFailed ? "无法读取筛选目录，请检查连接后重试。" : "正在读取筛选目录…"}</Text>
      {props.catalogFailed ? <RuleButton theme={props.theme} onPress={props.onRetry}>重试</RuleButton> : null}
      <RuleButton theme={props.theme} onPress={props.onCancel}>取消</RuleButton>
    </Modal.Content>
  </Modal>;
}

function RuleEditor({ workspaceId, workspaceName, connectionKey, initialRule, catalog, theme, userId, enabling, onRuleSaved, onSaved, onCancel, onSavingChange }: EditorProps & { catalog: Catalog }) {
  const save = useRpc(workspaceRule), enable = useRpc(workspaceEnable);
  const [rule, setRule] = useState(initialRule);
  const [selection, setSelection] = useState(() => readStatuses(initialRule, catalog));
  const [saved, setSaved] = useState<TaskRule | null>(null);
  const [saveFailure, setSaveFailure] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [discard, setDiscard] = useState(false);
  const current = { ...rule, ...writeStatuses(selection, catalog) };
  const baseline = saved ?? { ...initialRule, ...writeStatuses(readStatuses(initialRule, catalog), catalog) };
  const dirty = fingerprint(current) !== fingerprint(baseline);
  function close() { if (!saving) { if (dirty) setDiscard(true); else onCancel(); } }
  async function persist() {
    setSaving(true); onSavingChange(true); setSaveFailure(null); setDiscard(false);
    try {
      // An enable failure can retry only that step while the saved rule is unchanged.
      if (!saved || fingerprint(current) !== fingerprint(saved)) {
        const result = await save({ workspaceId, connectionKey, rule: current });
        if (result.status !== "ready") { setSaveFailure(result.message ?? "规则保存或同步失败，请重试。"); return; }
        setSaved(current); onRuleSaved(current);
      }
      if (enabling) {
        const result = await enable({ workspaceId, connectionKey, enabled: true });
        if (result.status !== "ready") { setSaveFailure(result.message ?? "规则已保存，启用失败，请重试启用。"); return; }
      }
      onSaved(current);
    } catch { setSaveFailure("保存或启用失败，请重试。"); }
    finally { setSaving(false); onSavingChange(false); }
  }
  const members = catalog.assignees.filter(item => item.type === "member");
  const actors = [...members.filter(item => item.id === userId), ...members.filter(item => item.id !== userId), ...catalog.assignees.filter(item => item.type !== "member")];
  const and = <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}><View style={{ flex: 1, borderTopWidth: 1, borderStyle: "dashed", borderColor: theme.colors.border }} /><Text style={{ color: theme.colors.foregroundMuted, fontSize: 12 }}>且</Text><View style={{ flex: 1, borderTopWidth: 1, borderStyle: "dashed", borderColor: theme.colors.border }} /></View>;
  return <Modal title={`${enabling ? "启用" : "筛选条件"} · ${workspaceName}`} open onOpenChange={open => { if (!open) close(); }}>
    <Modal.Content scrollable={false} contentContainerStyle={{ padding: 0, gap: 0 }} style={{ flexShrink: 1 }}>
      <ScrollView style={{ flexShrink: 1 }} contentContainerStyle={{ padding: 24, gap: 16 }}>
        {enabling ? <Text style={{ color: theme.colors.foregroundMuted, fontSize: 13 }}>启用后，按下面的条件把任务导入 Paseo。默认只导入“未开始”和“进行中”，其他条件不限；可以先缩小范围再导入。</Text> : null}
        <Text style={{ color: theme.colors.foregroundMuted, fontSize: 13 }}>各字段需同时满足，同一字段内任一命中即可，不选表示不限。</Text>
        <StatusChoices value={selection} onChange={value => { setSelection(value); setDiscard(false); }} catalog={catalog} disabled={saving} theme={theme} />
        {and}
        <Choices title="负责人" theme={theme} disabled={saving} values={rule.assignees.map(item => `${item.type}:${item.id}`)} groups={["成员", "Agent", "Squad"]}
          choices={actors.map(item => ({ id: `${item.type}:${item.id}`, name: item.type === "member" && item.id === userId ? `我 · ${item.name}` : item.name, group: actorNames[item.type] }))}
          onChange={values => { setRule({ ...rule, assignees: values.map(value => { const index = value.indexOf(":"); return { type: value.slice(0, index) as TaskRule["assignees"][number]["type"], id: value.slice(index + 1) }; }) }); setDiscard(false); }} />
        <Text style={{ color: theme.colors.foregroundMuted, fontSize: 12 }}>直接分配给成员，与分配给其 Agent／Squad 是不同条件，需分别选择。</Text>
        {and}
        <Choices title="Multica 项目" theme={theme} choices={catalog.projects} values={rule.projectIds} disabled={saving} onChange={projectIds => { setRule({ ...rule, projectIds }); setDiscard(false); }} />
        {and}
        <Choices title="标签" theme={theme} choices={catalog.labels} values={rule.labelIds} disabled={saving} onChange={labelIds => { setRule({ ...rule, labelIds }); setDiscard(false); }} />
      </ScrollView>
      <View style={{ paddingHorizontal: 24, paddingVertical: 16, borderTopWidth: 1, borderColor: theme.colors.border, gap: 8, backgroundColor: theme.colors.surface0 }}>
        {saveFailure ? <Text accessibilityRole="alert" style={{ color: theme.colors.statusDanger, fontSize: 13 }}>{saveFailure}</Text> : null}
        <View style={{ flexDirection: "row", alignItems: "center", flexWrap: "wrap", gap: 8 }}>
          <Text style={{ flexGrow: 1, flexShrink: 1, color: discard ? theme.colors.statusWarning : theme.colors.foregroundMuted, fontSize: 12 }}>{discard ? "放弃未保存的修改？" : dirty ? "有未保存的修改" : ""}</Text>
          {discard ? <><RuleButton theme={theme} onPress={() => setDiscard(false)}>继续编辑</RuleButton><RuleButton theme={theme} tone="danger" onPress={onCancel}>放弃修改</RuleButton></>
            : <><RuleButton theme={theme} disabled={saving} onPress={close}>取消</RuleButton><RuleButton theme={theme} tone="primary" disabled={saving} onPress={() => { void persist(); }}>{saving ? "正在保存…" : enabling ? "启用并导入" : "保存"}</RuleButton></>}
        </View>
      </View>
    </Modal.Content>
  </Modal>;
}
