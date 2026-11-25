import { useEffect, useRef, useState } from "react";
import { Text, View } from "react-native";
import { useRpc, type PluginSurfaceProps } from "@getpaseo/plugin/client";
import { Modal, SettingsAction, SettingsCard, SettingsRow, SettingsSection, SettingsSwitch } from "@getpaseo/plugin/client/ui";
import { workspaceCatalog, workspaceEnable, type ConnectionStatus, type TaskRule, type SyncStatus } from "../shared/contracts.js";
import { describeCatalogRule, describeRule, WorkspaceRuleEditor, type Catalog } from "./workspace-rule.js";
import { Notice, RuleButton, SubHeading } from "./ui-kit.js";

export type Workspace = { connectionKey: string; id: string; name: string; enabled: boolean; rule: TaskRule; importedCount: number };
type CatalogEntry = { data?: Catalog; failed?: boolean };

export function WorkspaceList({ workspaces, read, failure, status, syncStatus, theme, onRuleSaved, onEnabled, onSync }: {
  workspaces: Workspace[]; read: boolean; failure: string | null; status: ConnectionStatus | null; syncStatus: SyncStatus | null; theme: PluginSurfaceProps["theme"];
  onRuleSaved(workspace: Workspace, rule: TaskRule): void; onEnabled(workspace: Workspace, enabled: boolean): void; onSync(sync?: SyncStatus): void;
}) {
  const load = useRpc(workspaceCatalog), enable = useRpc(workspaceEnable);
  const [catalogs, setCatalogs] = useState<Record<string, CatalogEntry>>({});
  const requests = useRef(new Map<string, symbol>());
  const [editor, setEditor] = useState<Workspace | null>(null);
  const [disabling, setDisabling] = useState<Workspace | null>(null);
  const [saving, setSaving] = useState<string[]>([]);
  const [receipt, setReceipt] = useState<{ saved: string; syncing: string } | null>(null);
  const [disableFailure, setDisableFailure] = useState<string | null>(null);
  function savingWorkspace(id: string, value: boolean) { setSaving(ids => value ? [...new Set([...ids, id])] : ids.filter(item => item !== id)); }
  function requestCatalog(workspace: Workspace, force = false) {
    if (!force && requests.current.has(workspace.id)) return;
    const ticket = Symbol();
    requests.current.set(workspace.id, ticket);
    setCatalogs(entries => ({ ...entries, [workspace.id]: {} }));
    void load({ connectionKey: workspace.connectionKey, workspaceId: workspace.id }).then(data => {
      if (requests.current.get(workspace.id) !== ticket) return;
      setCatalogs(entries => ({ ...entries, [workspace.id]: { data } }));
    }, () => {
      if (requests.current.get(workspace.id) === ticket) setCatalogs(entries => ({ ...entries, [workspace.id]: { failed: true } }));
    });
  }
  useEffect(() => { workspaces.filter(item => item.enabled).forEach(workspace => requestCatalog(workspace)); }, [load, workspaces]);
  useEffect(() => () => { requests.current.clear(); }, []);
  function edit(workspace: Workspace) {
    setEditor(workspace);
    requestCatalog(workspace);
  }
  async function disable(workspace: Workspace) {
    savingWorkspace(workspace.id, true); setDisableFailure(null);
    try {
      const result = await enable({ connectionKey: workspace.connectionKey, workspaceId: workspace.id, enabled: false });
      if (result.status !== "saved") { setDisableFailure(result.message ?? "停用失败，请重试。"); return; }
      onEnabled(workspace, false); onSync(result.sync); setDisabling(null);
      setReceipt({ saved: "已关闭同步。", syncing: workspace.importedCount ? "已关闭同步，本地任务正在后台归档。" : "已关闭同步。" });
    } catch { setDisableFailure("停用失败，请检查连接后重试。"); }
    finally { savingWorkspace(workspace.id, false); }
  }
  const enabled = workspaces.filter(item => item.enabled), disabled = workspaces.filter(item => !item.enabled);
  return <SettingsSection title="Multica 工作区与筛选规则" trailing={enabled.length ? <Text style={{ color: theme.colors.foregroundMuted, fontSize: 13 }}>已启用 {enabled.length} 个</Text> : undefined}
    info="显式启用后才导入任务，默认只导入“未开始”和“进行中”状态类别，可再组合负责人、具体状态、Multica 项目与标签。Multica 项目只限制任务范围，任务仍归入此 Multica 工作区对应的 Paseo 项目。每项任务使用独立的非 Git 占位目录，原生文件与终端打开的是占位目录。">
    {receipt ? <Text style={{ color: theme.colors.statusSuccess, marginHorizontal: 4 }}>{syncStatus?.status === "syncing" ? receipt.syncing : receipt.saved}</Text> : null}
    {failure ? <Notice theme={theme}>{failure}</Notice> : null}
    {enabled.map(workspace => <SettingsCard key={workspace.id}>
      <SettingsSwitch label={workspace.name} hint={`已导入 ${workspace.importedCount} 项任务`} value disabled={saving.includes(workspace.id)}
        onValueChange={value => { if (!value) { setDisabling(workspace); setDisableFailure(null); } }} />
      <SettingsAction label={catalogs[workspace.id]?.data ? describeCatalogRule(workspace.rule, catalogs[workspace.id].data!, status?.user?.id) : describeRule(workspace.rule)}
        actionLabel="编辑筛选" disabled={saving.includes(workspace.id)} onPress={() => edit(workspace)} />
    </SettingsCard>)}
    {disabled.length ? <View style={{ gap: 8 }}>
      <SubHeading theme={theme}>未启用 · 不导入任务</SubHeading>
      <SettingsCard>{disabled.map(workspace => <SettingsAction key={workspace.id} label={workspace.name}
        hint={workspace.importedCount > 0 ? syncStatus?.status === "syncing"
          ? `已关闭同步 · 正在归档本地任务（剩余 ${workspace.importedCount} 项）`
          : `已关闭同步 · 待归档 ${workspace.importedCount} 项，后台将重试${syncStatus?.status === "unavailable" ? "；同步失败详情见上方" : ""}` : undefined}
        actionLabel="启用…" disabled={saving.includes(workspace.id)} onPress={() => edit(workspace)} />)}</SettingsCard>
    </View> : null}
    {status?.status === "ready" && !read && !failure ? <SettingsCard><SettingsRow label="正在读取 Multica 工作区…" /></SettingsCard> : null}
    {status?.status === "ready" && read && !workspaces.length && !failure ? <SettingsCard><SettingsRow label="当前没有可用的 Multica 工作区" hint="在 Multica 加入或创建工作区后点击刷新。" /></SettingsCard> : null}
    {status && status.status !== "ready" ? <SettingsCard><SettingsRow label="连接就绪后可配置" hint="恢复 Multica CLI 登录后，这里会列出可启用的 Multica 工作区。" /></SettingsCard> : null}
    {editor ? <WorkspaceRuleEditor key={editor.id} workspaceId={editor.id} workspaceName={editor.name} connectionKey={editor.connectionKey}
      initialRule={editor.rule} enabling={!editor.enabled} theme={theme} userId={status?.user?.id}
      catalog={catalogs[editor.id]?.data} catalogFailed={catalogs[editor.id]?.failed} onRetry={() => requestCatalog(editor, true)}
      onSavingChange={value => savingWorkspace(editor.id, value)} onRuleSaved={rule => onRuleSaved(editor, rule)} onSync={onSync} onCancel={() => setEditor(null)}
      onSaved={() => {
        if (!editor.enabled) onEnabled(editor, true);
        setReceipt(editor.enabled ? { saved: "筛选规则已保存。", syncing: "筛选规则已保存，后台同步进行中。" } : { saved: "已启用。", syncing: "已启用，后台正在同步任务。" });
        setEditor(null);
      }} /> : null}
    {disabling ? <Modal title={`停用 ${disabling.name}？`} open onOpenChange={open => { if (!open && !saving.includes(disabling.id)) setDisabling(null); }}>
      <Modal.Content>
        <Text style={{ color: theme.colors.foreground }}>此 Multica 工作区已导入的 {disabling.importedCount} 项任务会归档，空的 Paseo 项目会移除。</Text>
        <Text style={{ color: theme.colors.foregroundMuted }}>评论、执行记录、讨论身份和人工隐藏都会保留，重新启用后恢复。不会取消远端 Run。</Text>
        {disableFailure ? <Notice theme={theme}>{disableFailure}</Notice> : null}
        <View style={{ flexDirection: "row", justifyContent: "flex-end", gap: 8 }}>
          <RuleButton theme={theme} disabled={saving.includes(disabling.id)} onPress={() => setDisabling(null)}>取消</RuleButton>
          <RuleButton theme={theme} tone="danger" disabled={saving.includes(disabling.id)} onPress={() => { void disable(disabling); }}>{saving.includes(disabling.id) ? "正在停用…" : "停用"}</RuleButton>
        </View>
      </Modal.Content>
    </Modal> : null}
  </SettingsSection>;
}
