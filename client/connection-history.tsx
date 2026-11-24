import { useEffect, useState } from "react";
import { Text, View } from "react-native";
import { useRpc, type PluginSurfaceProps } from "@getpaseo/plugin/client";
import { SettingsCard, SettingsSection } from "@getpaseo/plugin/client/ui";
import { connectionHistory } from "../shared/contracts.js";
import type { z } from "zod";

type History = z.output<typeof connectionHistory.output>["connections"];

export function ConnectionHistory({ theme, currentKey }: Pick<PluginSurfaceProps, "theme"> & { currentKey?: string }) {
  const read = useRpc(connectionHistory);
  const [connections, setConnections] = useState<History>([]);
  const [failure, setFailure] = useState(false);
  useEffect(() => {
    let active = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    async function update() {
      try { const result = await read({}); if (active) { setConnections(result.connections); setFailure(false); } }
      catch { if (active) setFailure(true); }
      if (active) timer = setTimeout(() => { void update(); }, 10_000);
    }
    void update();
    return () => { active = false; if (timer) clearTimeout(timer); };
  }, [read, currentKey]);
  return <SettingsSection title="历史连接">
    <Text style={{ color: theme.colors.foregroundMuted }}>各服务与账号分别保留规则、项目、讨论和人工隐藏。请通过 CLI 登录及上方 profile 切回原身份，继续使用原映射。</Text>
    {connections.map(connection => <SettingsCard key={connection.connectionKey}>
      <View style={{ gap: 6 }}>
        <Text selectable style={{ color: theme.colors.foreground }}>{connection.connectionKey === currentKey ? "当前连接" : "保留的历史连接"} · {connection.user?.name || connection.user?.id || "早期连接（尚无身份摘要）"}</Text>
        <Text selectable style={{ color: theme.colors.foregroundMuted }}>{connection.apiUrl ?? connection.connectionKey}</Text>
        {connection.user ? <Text selectable style={{ color: theme.colors.foregroundMuted }}>用户 ID：{connection.user.id}</Text> : null}
        <Text style={{ color: theme.colors.foregroundMuted }}>Profiles：{connection.profiles.map(profile => profile || "默认").join("、") || "未知"}</Text>
        <Text style={{ color: theme.colors.foregroundMuted }}>项目 {connection.projectCount} · 任务 {connection.issueCount} · 人工隐藏 {connection.hiddenCount} · 待核实输入 {connection.pendingDeliveryCount} · 停止告警 {connection.stopWarningCount}</Text>
      </View>
    </SettingsCard>)}
    {!connections.length ? <Text style={{ color: theme.colors.foregroundMuted }}>尚无已验证的连接历史。</Text> : null}
    {failure ? <Text accessibilityRole="alert" style={{ color: theme.colors.statusDanger }}>历史连接暂不可读，保留上次已读列表。</Text> : null}
  </SettingsSection>;
}
