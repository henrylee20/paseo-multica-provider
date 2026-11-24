import { useEffect, useState } from "react";
import { Text, View } from "react-native";
import { useRpc, useSettings, type PluginSurfaceProps } from "@getpaseo/plugin/client";
import { ExternalLink, SettingsAction, SettingsCard, SettingsInput, SettingsRow, SettingsSection } from "@getpaseo/plugin/client/ui";
import { connectionStatus, multicaSettings, workspaceList, workspaceEnable, type ConnectionStatus, type TaskRule } from "../shared/contracts.js";

import { WorkspaceRuleEditor } from "./workspace-rule.js";
import { HiddenObjects } from "./hidden-objects.js";

const labels: Record<ConnectionStatus["status"], string> = {
  ready: "已连接", missing_config: "未配置 CLI", unreadable_config: "配置无法读取", invalid_config: "配置无效",
  not_logged_in: "未登录", authentication_failed: "登录已失效", offline: "无法连接", isolated_context: "任务上下文受隔离", invalid_settings: "插件设置无效",
};
const sourceLabel = { config: "CLI 配置", environment: "daemon 环境变量", none: "未配置" };

export function ConnectionScreen({ host, theme }: PluginSurfaceProps) {
  const settings = useSettings(multicaSettings);
  const readStatus = useRpc(connectionStatus);
  const listWorkspaces = useRpc(workspaceList);
  const enableWorkspace = useRpc(workspaceEnable);
  const [workspaces, setWorkspaces] = useState<Array<{ id: string; name: string; enabled: boolean; rule: TaskRule }>>([]);
  const [editingWorkspace, setEditingWorkspace] = useState<string | null>(null);
  const [workspaceFailure, setWorkspaceFailure] = useState<string | null>(null);
  const [savingWorkspace, setSavingWorkspace] = useState<string | null>(null);
  const [status, setStatus] = useState<ConnectionStatus | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  const [draft, setDraft] = useState("");
  const [profileError, setProfileError] = useState<string | null>(null);
  const configuredProfile = settings.status === "ready" ? settings.values.profile : undefined;

  useEffect(() => { if (configuredProfile !== undefined) setDraft(configuredProfile); }, [configuredProfile]);
  useEffect(() => {
    let active = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    setStatus(null);
    async function update() {
      try {
        const next = await readStatus({});
        if (active) { setStatus(next); setFailure(null); }
        if (next.status === "ready") {
          try {
            const result = await listWorkspaces({});
            if (active) { setWorkspaces(result.workspaces); setWorkspaceFailure(null); }
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

  async function toggleWorkspace(workspace: { id: string; enabled: boolean }) {
    setSavingWorkspace(workspace.id);
    try {
      const result = await enableWorkspace({ workspaceId: workspace.id, enabled: !workspace.enabled });
      if (result.status !== "ready") { setWorkspaceFailure(result.message ?? "同步暂不可用，请重试。"); return; }
      setWorkspaceFailure(null);
      setAttempt(value => value + 1);
    } catch { setWorkspaceFailure("工作区规则保存或同步失败，请重试。"); }
    finally { setSavingWorkspace(null); }
  }

  const text = { color: theme.colors.foreground };
  const muted = { color: theme.colors.foregroundMuted };
  return <View style={{ gap: 24 }}>
    <Text style={muted}>连接来自 Paseo daemon 主机 {host.label} 的 Multica CLI 登录。请在这台主机上使用同一运行用户管理 CLI 登录。</Text>
    <SettingsSection title="CLI profile">
      {settings.status === "ready" ? <SettingsCard>
        <SettingsInput key={configuredProfile} label="Profile 名称" initialValue={draft} onChangeText={setDraft}
          hint="留空使用 CLI 默认 profile；命名 profile 需显式填写，不会根据修改时间切换。" disabled={settings.saving} />
        <SettingsAction label="选择 daemon 使用的 CLI profile" actionLabel="保存 profile" disabled={settings.saving}
          onPress={() => { void saveProfile(); }} />
      </SettingsCard> : <Text style={muted}>{settings.status === "loading" ? "正在读取设置…" : "无法读取插件设置，请重新读取。"}</Text>}
      {profileError || settings.saveError ? <Text accessibilityRole="alert" style={{ color: theme.colors.statusDanger }}>{profileError ?? settings.saveError}</Text> : null}
      <SettingsAction label="重新读取主机设置与连接" actionLabel="刷新" onPress={() => { void settings.reload(); setAttempt(value => value + 1); }} />
    </SettingsSection>
    <SettingsSection title="连接状态">
      {failure ? <Text accessibilityRole="alert" style={{ color: theme.colors.statusDanger }}>{failure}</Text> : null}
      {status ? <>
        <SettingsCard>
          <SettingsRow label="状态" hint={status.message}><Text style={text}>{labels[status.status]}</Text></SettingsRow>
          <SettingsRow label="Profile"><Text selectable style={text}>{status.profile || "默认"}</Text></SettingsRow>
          <SettingsRow label="CLI 配置来源"><Text selectable style={text}>{status.configPath ?? "隔离上下文，未读取配置"}</Text></SettingsRow>
          <SettingsRow label="API 服务" hint={sourceLabel[status.source.api]}><Text selectable style={text}>{status.apiUrl ?? "未就绪"}</Text></SettingsRow>
          <SettingsRow label="凭据来源"><Text style={text}>{sourceLabel[status.source.credentials]}</Text></SettingsRow>
          <SettingsRow label="已验证用户"><Text selectable style={text}>{status.user ? `${status.user.name} (${status.user.email}) · ${status.user.id}` : "尚未验证"}</Text></SettingsRow>
          <SettingsRow label="前端地址" hint={sourceLabel[status.source.app]}>
            {status.appUrl ? <ExternalLink href={status.appUrl}>{status.appUrl}</ExternalLink> : <Text style={muted}>未配置</Text>}
          </SettingsRow>
        </SettingsCard>
        {status.status !== "ready" ? <Text selectable style={muted}>在 daemon 主机恢复 CLI 登录后刷新：{status.loginCommand}</Text> : null}
      </> : !failure ? <Text style={muted}>正在验证 CLI 连接…</Text> : null}
      <Text style={muted}>连接凭据仅在 daemon 内使用。</Text>
    </SettingsSection>
    <SettingsSection title="工作区与筛选规则">
      <Text style={muted}>显式启用后导入“未开始”和“进行中”状态类别的任务；初始不限制具体状态、负责人、Multica 项目和标签，可配置组合条件。未启用的工作区不会导入。</Text>
      {workspaceFailure ? <Text accessibilityRole="alert" style={{ color: theme.colors.statusDanger }}>{workspaceFailure}</Text> : null}
      {workspaces.map(workspace => <SettingsCard key={workspace.id}>
        <SettingsAction label={workspace.name} hint={workspace.enabled ? "已启用：按已保存的筛选规则同步" : "尚未启用"}
          actionLabel={workspace.enabled ? "停用规则" : "启用规则"} disabled={savingWorkspace !== null}
          onPress={() => { void toggleWorkspace(workspace); }} />
        <SettingsAction label="负责人、状态、标签与 Multica 项目" actionLabel={editingWorkspace === workspace.id ? "收起筛选条件" : "配置筛选条件"}
          onPress={() => setEditingWorkspace(value => value === workspace.id ? null : workspace.id)} />
        {editingWorkspace === workspace.id ? <WorkspaceRuleEditor key={`${status?.connectionKey}:${workspace.id}`} workspaceId={workspace.id} initialRule={workspace.rule} theme={theme}
          onSaved={() => { setEditingWorkspace(null); setAttempt(value => value + 1); }} /> : null}
      </SettingsCard>)}
      {status?.status === "ready" && !workspaces.length && !workspaceFailure ? <Text style={muted}>当前没有可用的 Multica 工作区。</Text> : null}
      <Text style={muted}>每项任务使用独立的非 Git 占位目录，主讨论中可读任务描述。原生文件与终端打开的是占位目录。</Text>
    </SettingsSection>
    <HiddenObjects theme={theme} refreshKey={`${host.id}:${configuredProfile}:${attempt}`} />
  </View>;
}
