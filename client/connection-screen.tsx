import { DataRebuild } from "./data-rebuild.js";
import { useEffect, useState } from "react";
import { Text, View } from "react-native";
import { useRpc, useSettings, type PluginSurfaceProps } from "@getpaseo/plugin/client";
import { copyText, Modal, SettingsAction, SettingsCard, SettingsRow, SettingsSection, SettingsSelect } from "@getpaseo/plugin/client/ui";
import { connectionStatus, multicaSettings, profileList, workspaceList, type ConnectionStatus, type ProfileList, type SyncStatus } from "../shared/contracts.js";
import { describeSync } from "./sync-status.js";
import { WorkspaceList, type Workspace } from "./workspace-list.js";
import type { HiddenObject } from "../shared/hiding.js";
import { HiddenObjects } from "./hidden-objects.js";
import { HeaderAction, RuleButton } from "./ui-kit.js";

const labels: Record<ConnectionStatus["status"], string> = {
  ready: "已连接", missing_config: "未配置 CLI", unreadable_config: "配置无法读取", invalid_config: "配置无效",
  not_logged_in: "未登录", authentication_failed: "登录已失效", offline: "无法连接", isolated_context: "任务上下文受隔离", invalid_settings: "插件设置无效",
};

export function ConnectionScreen({ host, theme }: PluginSurfaceProps) {
  const settings = useSettings(multicaSettings);
  const readStatus = useRpc(connectionStatus);
  const readProfiles = useRpc(profileList);
  const listWorkspaces = useRpc(workspaceList);
  const [syncStatus, setSyncStatus] = useState<SyncStatus | null>(null);
  const [hidden, setHidden] = useState<HiddenObject[]>([]);
  const [workspaces, setWorkspaces] = useState<Workspace[]>([]);
  /** A list belongs to the host, profile and identity that read it, including before reset effects run. */
  const [workspaceScope, setWorkspaceScope] = useState<string | null>(null);
  const [workspaceFailure, setWorkspaceFailure] = useState<string | null>(null);
  const [status, setStatus] = useState<ConnectionStatus | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  const [profileRefresh, setProfileRefresh] = useState(0);
  const [profileState, setProfileState] = useState<{ key: string; value?: ProfileList; error?: string } | null>(null);
  const [profileError, setProfileError] = useState<string | null>(null);
  const [pendingProfile, setPendingProfile] = useState<string | null>(null);
  const [confirming, setConfirming] = useState(false);
  const [copied, setCopied] = useState<"done" | "failed" | null>(null);
  const configuredProfile = settings.status === "ready" ? settings.values.profile : undefined;
  const profileKey = JSON.stringify([host.id, profileRefresh]);
  const profiles = profileState?.key === profileKey ? profileState : null;

  useEffect(() => {
    let active = true;
    void readProfiles({}).then(value => { if (active) setProfileState({ key: profileKey, value }); },
      () => { if (active) setProfileState({ key: profileKey, error: "无法读取此主机的 CLI profile，请点击刷新重试。" }); });
    return () => { active = false; };
  }, [readProfiles, profileKey]);
  // Another host or profile may be another identity: never keep showing the previous one's status or rules.
  useEffect(() => {
    setPendingProfile(null);
    setStatus(null);
    setHidden([]);
    setWorkspaces([]);
    setWorkspaceScope(null);
    setCopied(null);
  }, [host.id, configuredProfile]);
  useEffect(() => {
    // Refreshes and rule changes keep the current rows on screen until the next reading replaces them.
    let active = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    async function update() {
      let syncing = false;
      try {
        const next = await readStatus({});
        syncing = next.sync.status === "syncing";
        if (active) { setStatus(next); setSyncStatus(next.sync); setHidden(next.hidden); setFailure(null); }
        if (next.status === "ready") {
          try {
            const result = await listWorkspaces({});
            if (active) {
              setWorkspaces(result.connectionKey === next.connectionKey
                ? result.workspaces.map(workspace => ({ ...workspace, connectionKey: result.connectionKey })) : []);
              setWorkspaceScope(JSON.stringify([host.id, configuredProfile, next.connectionKey]));
              setWorkspaceFailure(null);
            }
          } catch { if (active) setWorkspaceFailure("无法读取 Multica 工作区，请检查连接后刷新。"); }
        } else if (active) setWorkspaces([]);
      } catch {
        if (active) { setStatus(null); setFailure("无法读取此主机的连接状态，请检查 Paseo daemon 连接后重试。"); }
      }
      if (active) timer = setTimeout(() => { void update(); }, syncing ? 2_000 : 10_000);
    }
    void update();
    return () => { active = false; if (timer) clearTimeout(timer); };
  }, [readStatus, listWorkspaces, attempt, configuredProfile, host.id]);

  const purging = syncStatus?.stage === "purging" && syncStatus.status === "syncing";
  function selectProfile(profile: string) {
    if (settings.status !== "ready" || settings.saving || purging || !profiles || profiles.value?.isolated || profile === configuredProfile) return;
    const parsed = multicaSettings.schema.safeParse({ profile });
    if (!parsed.success) { setProfileError("Profile 必须是单个名称，不能包含路径分隔符或 .. 路径。"); return; }
    setProfileError(null);
    setPendingProfile(parsed.data.profile);
  }
  async function confirmProfile() {
    if (pendingProfile === null || settings.status !== "ready" || settings.saving || confirming || purging) return;
    setConfirming(true);
    setProfileError(null);
    try {
      if (await settings.save({ profile: pendingProfile }, settings.revision)) {
        setPendingProfile(null);
        setAttempt(value => value + 1);
      } else setProfileError("无法保存 profile，请重试。");
    } catch { setProfileError("无法保存 profile，请重试。"); }
    finally { setConfirming(false); }
  }

  async function copyLogin(command: string) {
    try { await copyText(command); setCopied("done"); } catch { setCopied("failed"); }
  }

  const refresh = () => { void settings.reload(); setAttempt(value => value + 1); setProfileRefresh(value => value + 1); };
  const text = { color: theme.colors.foreground };
  const statusColor = (value: ConnectionStatus["status"]) => value === "ready" ? theme.colors.statusSuccess
    : value === "offline" || value === "isolated_context" ? theme.colors.statusWarning : theme.colors.statusDanger;
  const sync = describeSync(syncStatus, failure !== null);
  const syncColor = sync.tone === "danger" ? theme.colors.statusDanger : sync.tone === "warning" ? theme.colors.statusWarning : theme.colors.foreground;
  const syncHint = sync.tone !== "muted" ? sync.message || sync.label : syncStatus?.status === "syncing" ? sync.progress : undefined;
  const scopeKey = JSON.stringify([host.id, configuredProfile, status?.connectionKey]);
  const workspacesRead = workspaceScope === scopeKey;
  const current = workspacesRead ? workspaces.filter(workspace => workspace.connectionKey === status?.connectionKey) : [];
  const availableProfiles = profiles?.value?.profiles.filter(profile => profile.loggedIn || profile.name === configuredProfile) ?? [];
  if (configuredProfile !== undefined && !availableProfiles.some(profile => profile.name === configuredProfile)) availableProfiles.push({ name: configuredProfile, loggedIn: false });
  const profileOptions = availableProfiles.map(profile => ({ value: profile.name,
    label: `${profile.name || "默认"}${profile.apiHost ? ` · ${profile.apiHost}` : ""}${profile.loggedIn ? "" : "（未登录）"}` }));
  const profileHint = [profiles?.value?.isolated ? "任务上下文不能使用拥有者的 profile。" : "",
    profiles?.value?.overridden ? "环境变量覆盖 CLI 凭据，切换 profile 不会改变账号。" : ""].filter(Boolean).join(" ") || "仅列出已在 daemon 主机登录的 profile。";

  const connection = <SettingsSection title="Multica 连接" trailing={<HeaderAction theme={theme} label="刷新" onPress={refresh} />}
    info={`复用 daemon 主机 ${host.label} 上的 Multica CLI 登录。`}>
    <SettingsCard>
      <SettingsRow label={status?.apiUrl ?? "状态"} hint={status?.status !== "ready" ? status?.message : undefined} error={failure}>
        <Text style={{ color: status ? statusColor(status.status) : theme.colors.foregroundMuted }}>{status
          ? [labels[status.status], status.status === "ready" ? status.user?.name || status.user?.email : undefined].filter(Boolean).join(" · ")
          : failure ? "无法读取" : "正在验证…"}</Text>
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
      {settings.status === "ready" ? <SettingsSelect label="CLI profile" value={settings.values.profile} options={profileOptions}
        disabled={settings.saving || purging || !profiles || profiles.value?.isolated} hint={profileHint} error={settings.saveError ?? profileError ?? profiles?.error}
        onValueChange={selectProfile} />
        : settings.status === "invalid" ? <SettingsAction label="CLI profile" hint={`已保存的插件设置无效：${settings.error}`} actionLabel="重置为默认 profile"
        disabled={settings.saving} onPress={() => { void settings.reset().then(saved => { if (saved) setAttempt(value => value + 1); }); }} />
        : <SettingsRow label="CLI profile" hint={settings.status === "loading" ? "正在读取设置…" : "无法读取插件设置，请点击刷新。"}>
          {status ? <Text selectable style={text}>{status.profile || "默认"}</Text> : null}
        </SettingsRow>}
    </SettingsCard>
  </SettingsSection>;

  const rules = <WorkspaceList key={scopeKey} workspaces={current} read={workspacesRead} failure={workspaceFailure} status={status} syncStatus={syncStatus} theme={theme}
    onSync={sync => { if (sync) setSyncStatus(sync); setAttempt(value => value + 1); }}
    onRuleSaved={(workspace, rule) => {
      setWorkspaces(list => list.map(item => item.connectionKey === workspace.connectionKey && item.id === workspace.id ? { ...item, rule } : item));
      setAttempt(value => value + 1);
    }}
    onEnabled={(workspace, enabled) => {
      setWorkspaces(list => list.map(item => item.connectionKey === workspace.connectionKey && item.id === workspace.id ? { ...item, enabled } : item));
      setAttempt(value => value + 1);
    }} />;

  return <View>
    {connection}
    {syncStatus?.retainedProjects?.length ? <SettingsSection title="保留的 Project" info="以下 Project 包含用户自建工作区，已保留 Project 和占位目录；插件工作区已归档，插件讨论已删除。">
      <SettingsCard>{syncStatus.retainedProjects.map(project => <SettingsRow key={project.cwd} label={project.name}><Text selectable style={text}>{project.cwd}</Text></SettingsRow>)}</SettingsCard>
    </SettingsSection> : null}
    {pendingProfile !== null ? <Modal title="确认切换 CLI profile" open onOpenChange={open => { if (!open && !confirming && !settings.saving) setPendingProfile(null); }}>
      <Modal.Content>
        <Text style={text}>切换到 profile：{pendingProfile || "默认"}</Text>
        <Text style={text}>当前本地数据：Project {status?.localData?.projects ?? 0} · 任务 {status?.localData?.issues ?? 0} · 讨论 {status?.localData?.discussions ?? 0}</Text>
        <Text style={text}>将清理上一 profile 的全部本地规则、映射、缓存、讨论、插件 Project 和占位目录。含用户自建工作区的 Project 将保留。</Text>
        <Text style={text}>不影响 Multica 远端数据（不会取消远端 Run 或删除评论）</Text>
        {settings.saveError ?? profileError ? <Text style={{ color: theme.colors.statusDanger }}>{settings.saveError ?? profileError}</Text> : null}
        <View style={{ flexDirection: "row", justifyContent: "flex-end", gap: 8 }}>
          <RuleButton theme={theme} disabled={confirming || settings.saving} onPress={() => setPendingProfile(null)}>取消</RuleButton>
          <RuleButton theme={theme} tone="danger" disabled={confirming || settings.saving || purging} onPress={() => { void confirmProfile(); }}>{confirming ? "正在保存…" : "确认切换"}</RuleButton>
        </View>
      </Modal.Content>
    </Modal> : null}
    {rules}
    <DataRebuild key={scopeKey} connectionKey={status?.connectionKey} ready={status?.status === "ready" && syncStatus?.stage !== "purging"} disabledReason={syncStatus?.stage === "purging" ? "请等待旧 profile 本地数据清理完成后重建。" : undefined} theme={theme} onRefresh={refresh} />
    <HiddenObjects theme={theme} objects={hidden} onRefresh={refresh} />
  </View>;
}
