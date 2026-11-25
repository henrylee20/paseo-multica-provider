import { useEffect, useState } from "react";
import { Text, View } from "react-native";
import { useRpc, useSettings, type PluginSurfaceProps } from "@getpaseo/plugin/client";
import { copyText, ScrollView, SettingsAction, SettingsCard, SettingsInput, SettingsRow, SettingsSection, SettingsSwitch } from "@getpaseo/plugin/client/ui";
import { connectionStatus, multicaSettings, workspaceList, workspaceEnable, type ConnectionStatus, type TaskRule } from "../shared/contracts.js";
import { useSyncStatus } from "./sync-status.js";
import { describeRule, WorkspaceRuleEditor } from "./workspace-rule.js";
import { HiddenObjects } from "./hidden-objects.js";
import { StopResults } from "./stop-results.js";
import { DeliveryManagement, MentionReferences } from "./delivery-status.js";
import { ConnectionHistory } from "./connection-history.js";
import { ReadonlyHistory } from "./readonly-history.js";
import { HeaderAction, Notice } from "./ui-kit.js";

type Workspace = { connectionKey: string; id: string; name: string; enabled: boolean; rule: TaskRule };

const labels: Record<ConnectionStatus["status"], string> = {
  ready: "已连接", missing_config: "未配置 CLI", unreadable_config: "配置无法读取", invalid_config: "配置无效",
  not_logged_in: "未登录", authentication_failed: "登录已失效", offline: "无法连接", isolated_context: "任务上下文受隔离", invalid_settings: "插件设置无效",
};

export interface ConnectionScreenProps extends PluginSurfaceProps {
  /** Settings shows what configures the connection; management adds the records that need handling. */
  scope?: "settings" | "management";
  openManagement?(): void;
  /** Whether this Paseo host draws the composer's agent picker (0.16 and later). */
  mentionPicker?: boolean;
}

export function ConnectionScreen({ host, theme, layout, navigation, scope = "management", openManagement, mentionPicker = false }: ConnectionScreenProps) {
  const settings = useSettings(multicaSettings);
  const readStatus = useRpc(connectionStatus);
  const listWorkspaces = useRpc(workspaceList);
  const enableWorkspace = useRpc(workspaceEnable);
  const sync = useSyncStatus();
  const [workspaces, setWorkspaces] = useState<Workspace[]>([]);
  /** Whether the workspace list was read for what is on screen; until then "no workspaces" would be a guess. */
  const [workspacesRead, setWorkspacesRead] = useState(false);
  const [editingWorkspace, setEditingWorkspace] = useState<string | null>(null);
  const [editorDirty, setEditorDirty] = useState(false);
  const [workspaceFailure, setWorkspaceFailure] = useState<string | null>(null);
  const [savingWorkspace, setSavingWorkspace] = useState<string | null>(null);
  const [status, setStatus] = useState<ConnectionStatus | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  const [draft, setDraft] = useState("");
  const [profileError, setProfileError] = useState<string | null>(null);
  const [copied, setCopied] = useState<"done" | "failed" | null>(null);
  const configuredProfile = settings.status === "ready" ? settings.values.profile : undefined;

  useEffect(() => { if (configuredProfile !== undefined) setDraft(configuredProfile); }, [configuredProfile]);
  // Another host or profile may be another identity: never keep showing the previous one's status or rules.
  useEffect(() => { setStatus(null); setWorkspaces([]); setWorkspacesRead(false); setEditingWorkspace(null); setEditorDirty(false); setCopied(null); }, [host.id, configuredProfile]);
  useEffect(() => {
    // Refreshes and rule changes keep the current rows on screen until the next reading replaces them.
    let active = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    async function update() {
      try {
        const next = await readStatus({});
        if (active) { setStatus(next); setFailure(null); }
        if (next.status === "ready") {
          try {
            const result = await listWorkspaces({});
            if (active) { setWorkspaces(result.connectionKey === next.connectionKey ? result.workspaces.map(workspace => ({ ...workspace, connectionKey: result.connectionKey })) : []); setWorkspacesRead(true); setWorkspaceFailure(null); }
          } catch { if (active) setWorkspaceFailure("无法读取 Multica 工作区，请检查连接后刷新。"); }
        } else if (active) setWorkspaces([]);
      } catch {
        if (active) { setStatus(null); setFailure("无法读取此主机的连接状态，请检查 Paseo daemon 连接后重试。"); }
      }
      if (active) timer = setTimeout(() => { void update(); }, 10_000);
    }
    void update();
    return () => { active = false; if (timer) clearTimeout(timer); };
  }, [readStatus, listWorkspaces, attempt, configuredProfile, host.id]);

  async function saveProfile() {
    if (settings.status !== "ready") return;
    const parsed = multicaSettings.schema.safeParse({ profile: draft });
    if (!parsed.success) { setProfileError("Profile 必须是单个名称，不能包含路径分隔符或 .. 路径。"); return; }
    setProfileError(null);
    if (await settings.save(parsed.data, settings.revision)) setAttempt(value => value + 1);
  }

  async function toggleWorkspace(workspace: Workspace) {
    setSavingWorkspace(workspace.id);
    try {
      const result = await enableWorkspace({ connectionKey: workspace.connectionKey, workspaceId: workspace.id, enabled: !workspace.enabled });
      if (result.status !== "ready") { setWorkspaceFailure(result.message ?? "同步暂不可用，请重试。"); return; }
      setWorkspaceFailure(null);
      setWorkspaces(list => list.map(item => item.connectionKey === workspace.connectionKey && item.id === workspace.id ? { ...item, enabled: !workspace.enabled } : item));
      setAttempt(value => value + 1);
    } catch { setWorkspaceFailure("Multica 工作区规则保存或同步失败，请重试。"); }
    finally { setSavingWorkspace(null); }
  }

  async function copyLogin(command: string) {
    try { await copyText(command); setCopied("done"); } catch { setCopied("failed"); }
  }

  const refresh = () => { void settings.reload(); setAttempt(value => value + 1); };
  const refreshKey = `${host.id}:${configuredProfile}:${attempt}`;
  const text = { color: theme.colors.foreground };
  const statusColor = (value: ConnectionStatus["status"]) => value === "ready" ? theme.colors.statusSuccess
    : value === "offline" || value === "isolated_context" ? theme.colors.statusWarning : theme.colors.statusDanger;
  const syncColor = sync.tone === "danger" ? theme.colors.statusDanger : sync.tone === "warning" ? theme.colors.statusWarning : theme.colors.foreground;
  const syncHint = sync.tone !== "muted" ? sync.message || sync.label : undefined;
  const current = workspaces.filter(workspace => workspace.connectionKey === status?.connectionKey);

  const connection = <SettingsSection title="Multica 连接" trailing={<HeaderAction theme={theme} label="刷新" onPress={refresh} />}
    info={`复用 daemon 主机 ${host.label} 上的 Multica CLI 登录。`}>
    <SettingsCard>
      <SettingsRow label={status?.apiUrl ?? "状态"} hint={status?.status !== "ready" ? status?.message : undefined} error={failure}>
        <Text style={{ color: status ? statusColor(status.status) : theme.colors.foregroundMuted }}>{status ? [labels[status.status], status.status === "ready" ? status.user?.name || status.user?.email : undefined].filter(Boolean).join(" · ") : failure ? "无法读取" : "正在验证…"}</Text>
      </SettingsRow>
      {status && status.status !== "ready" ? <SettingsAction label="恢复 CLI 登录" hint={`在 daemon 主机执行 ${status.loginCommand} 后刷新。`}
        actionLabel={copied === "done" ? "已复制" : "复制命令"} error={copied === "failed" ? "无法写入剪贴板，请手动输入上面的命令。" : null}
        onPress={() => { void copyLogin(status.loginCommand); }} /> : null}
      {status && status.status !== "ready" ? <SettingsRow label="CLI 配置" hint={`daemon 主机：${host.label}`}>
        <Text selectable style={text}>{status.configPath ?? "未读取配置"}</Text>
      </SettingsRow> : null}
      <SettingsRow label="同步" hint={syncHint}><Text style={{ color: syncColor }}>{sync.short}</Text></SettingsRow>
    </SettingsCard>
    <SettingsCard>
      {settings.status === "ready" ? [
        <SettingsInput key={`profile:${configuredProfile}`} label="CLI profile" initialValue={draft} placeholder="默认" disabled={settings.saving}
          hint="留空使用 CLI 默认 profile。" error={profileError ?? settings.saveError}
          onChangeText={value => { setDraft(value); setProfileError(null); }} />,
        <SettingsAction key="save" label="应用 profile" hint="保存后以此 profile 重新验证连接。" actionLabel={settings.saving ? "正在保存…" : "保存 profile"}
          disabled={settings.saving || draft.trim() === configuredProfile} onPress={() => { void saveProfile(); }} />,
      ] : settings.status === "invalid" ? <SettingsAction label="CLI profile" hint={`已保存的插件设置无效：${settings.error}`} actionLabel="重置为默认 profile"
        disabled={settings.saving} onPress={() => { void settings.reset().then(saved => { if (saved) setAttempt(value => value + 1); }); }} />
        : <SettingsRow label="CLI profile" hint={settings.status === "loading" ? "正在读取设置…" : "无法读取插件设置，请点击刷新。"}>
          {status ? <Text selectable style={text}>{status.profile || "默认"}</Text> : null}
        </SettingsRow>}
    </SettingsCard>
  </SettingsSection>;

  const rules = <SettingsSection title="Multica 工作区与筛选规则"
    info="启用后同步符合筛选条件的任务。">
    {workspaceFailure ? <Notice theme={theme}>{workspaceFailure}</Notice> : null}
    {current.map(workspace => {
      const editing = editingWorkspace === workspace.id;
      return <View key={`${workspace.connectionKey}:${workspace.id}`} style={{ gap: 12 }}>
        <SettingsCard>
          <SettingsSwitch label={workspace.name} value={workspace.enabled} disabled={savingWorkspace !== null}
            hint={savingWorkspace === workspace.id ? "正在保存…" : workspace.enabled ? "已启用：同步匹配的任务" : "未启用：不导入此 Multica 工作区的任务"}
            onValueChange={() => { void toggleWorkspace(workspace); }} />
          <SettingsAction label="筛选条件" hint={describeRule(workspace.rule)} actionLabel={editing ? editorDirty ? "放弃修改" : "收起" : "配置筛选条件"}
            onPress={() => { setEditorDirty(false); setEditingWorkspace(editing ? null : workspace.id); }} />
        </SettingsCard>
        {editing ? <WorkspaceRuleEditor key={`${workspace.connectionKey}:${workspace.id}`} connectionKey={workspace.connectionKey} workspaceId={workspace.id}
          initialRule={workspace.rule} theme={theme} onDirtyChange={setEditorDirty} onCancel={() => setEditingWorkspace(null)}
          onSaved={rule => {
            setEditingWorkspace(null);
            setWorkspaces(list => list.map(item => item.connectionKey === workspace.connectionKey && item.id === workspace.id ? { ...item, rule } : item));
            setAttempt(value => value + 1);
          }} /> : null}
      </View>;
    })}
    {status?.status === "ready" && !workspacesRead && !workspaceFailure ? <SettingsCard>
      <SettingsRow label="正在读取 Multica 工作区…" />
    </SettingsCard> : null}
    {status?.status === "ready" && workspacesRead && !current.length && !workspaceFailure ? <SettingsCard>
      <SettingsRow label="当前没有可用的 Multica 工作区" hint="在 Multica 加入或创建工作区后点击刷新。" />
    </SettingsCard> : null}
    {status && status.status !== "ready" ? <SettingsCard>
      <SettingsRow label="连接就绪后可配置" hint="恢复 Multica CLI 登录后，这里会列出可启用的 Multica 工作区。" />
    </SettingsCard> : null}
  </SettingsSection>;

  if (scope === "settings") return <View>
    {connection}
    {rules}
    {openManagement ? <SettingsSection title="记录与恢复">
      <SettingsCard>
        <SettingsAction label="Multica 管理页" hint="查看记录或恢复隐藏讨论。" actionLabel="打开管理页" onPress={openManagement} />
      </SettingsCard>
    </SettingsSection> : null}
  </View>;
  // The host hands a plugin screen a bare flex box: it neither scrolls nor pads, so the screen owns both.
  // Settings is a page of the host's own settings view, which already scrolls.
  return <ScrollView style={{ flex: 1 }} contentContainerStyle={{ padding: layout.compact ? 16 : 24 }}>
    {/* Records that need a decision come right after the connection; recovery and tools follow the rules. */}
    {connection}
    <DeliveryManagement theme={theme} navigation={navigation} host={host} refreshKey={refreshKey} />
    <StopResults theme={theme} refreshKey={refreshKey} />
    {rules}
    <HiddenObjects theme={theme} refreshKey={refreshKey} />
    <ReadonlyHistory theme={theme} />
    <ConnectionHistory theme={theme} currentKey={status?.connectionKey} />
    <MentionReferences theme={theme} refreshKey={refreshKey} mentionPicker={mentionPicker} />
  </ScrollView>;
}
