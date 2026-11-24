import { useEffect, useState } from "react";
import { Text, View } from "react-native";
import { useRpc, type PluginTimelineItemProps } from "@getpaseo/plugin/client";
import { syncStatus, type SyncStatus } from "../shared/contracts.js";

const stages: Record<SyncStatus["stage"], string> = { idle: "", connection: "连接验证", workspaces: "工作区核对", issues: "任务与筛选核对", history: "讨论与执行摘要核对" };
const labels: Record<SyncStatus["status"], string> = { idle: "等待客户端引导", syncing: "正在同步", ready: "已完成当前可用快照核对", unavailable: "同步未完成" };

/** One daemon-owned status is visible from management and every discussion. */
export function SyncState({ theme }: Pick<PluginTimelineItemProps, "theme">) {
  const read = useRpc(syncStatus);
  const [status, setStatus] = useState<SyncStatus | null>(null);
  const [disconnected, setDisconnected] = useState(false);
  useEffect(() => {
    let active = true;
    let pending = false;
    async function update() {
      if (pending) return;
      pending = true;
      try { const value = await read({}); if (active) { setStatus(value); setDisconnected(false); } }
      catch { if (active) setDisconnected(true); }
      finally { pending = false; }
    }
    void update();
    const timer = setInterval(() => { void update(); }, 5_000);
    return () => { active = false; clearInterval(timer); };
  }, [read]);
  return <View style={{ gap: 4 }}>
    <Text style={{ color: theme.colors.foregroundMuted }}>{disconnected ? "无法读取 daemon 同步状态；已读历史仍可阅读。" : status ? `${labels[status.status]}${stages[status.stage] ? ` · ${stages[status.stage]}` : ""}${status.status === "syncing" ? ` · 工作区 ${status.completedWorkspaces}/${status.enabledWorkspaces}` : ""}` : "正在读取同步状态…"}</Text>
    {status?.message ? <Text style={{ color: theme.colors.foregroundMuted }}>{status.message}</Text> : null}
    {status?.lastSuccessAt ? <Text style={{ color: theme.colors.foregroundMuted }}>上次完成核对：{status.lastSuccessAt}</Text> : null}
  </View>;
}
