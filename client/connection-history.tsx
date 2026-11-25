import { useEffect, useState } from "react";
import { useRpc, type PluginSurfaceProps } from "@getpaseo/plugin/client";
import { SettingsCard, SettingsRow, SettingsSection } from "@getpaseo/plugin/client/ui";
import { connectionHistory } from "../shared/contracts.js";
import { Notice } from "./ui-kit.js";
import type { z } from "zod";

type History = z.output<typeof connectionHistory.output>["connections"];

/** Shown only when another identity was used; the current one is already in the connection card. */
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
  if (!connections.some(connection => connection.connectionKey !== currentKey) && !failure) return null;
  const ordered = [...connections.filter(connection => connection.connectionKey === currentKey), ...connections.filter(connection => connection.connectionKey !== currentKey)];
  return <SettingsSection title="历史连接" info="各服务与账号分别保留规则、项目、讨论和人工隐藏。通过 CLI 登录及上方 profile 切回原身份后，继续使用原映射。">
    {failure ? <Notice theme={theme}>历史连接暂不可读，保留上次已读列表。</Notice> : null}
    {ordered.length ? <SettingsCard>
      {ordered.map(connection => <SettingsRow key={connection.connectionKey}
        label={`${connection.user?.name || connection.user?.id || "早期连接（尚无身份摘要）"}${connection.connectionKey === currentKey ? " · 当前连接" : ""}`}
        hint={[
          connection.apiUrl ?? connection.connectionKey,
          [connection.user ? `用户 ID ${connection.user.id}` : "", `Profiles：${connection.profiles.map(profile => profile || "默认").join("、") || "未知"}`].filter(Boolean).join(" · "),
          `项目 ${connection.projectCount} · 任务 ${connection.issueCount} · 人工隐藏 ${connection.hiddenCount} · 待核实输入 ${connection.pendingDeliveryCount}`,
        ].join("\n")} />)}
    </SettingsCard> : null}
  </SettingsSection>;
}
