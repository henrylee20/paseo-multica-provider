import type { SyncStatus } from "../shared/contracts.js";
import { formatTime } from "./format.js";

const stages: Record<SyncStatus["stage"], string> = { idle: "", purging: "清理旧 profile 数据", archiving: "本地任务归档", connection: "连接验证", workspaces: "Multica 工作区核对", issues: "任务与筛选核对", history: "讨论与执行摘要核对" };
const labels: Record<SyncStatus["status"], string> = { idle: "等待客户端引导", syncing: "正在同步", ready: "已完成当前可用快照核对", unavailable: "同步失败" };
const shortLabels: Record<SyncStatus["status"], string> = { idle: "等待引导", syncing: "同步中", ready: "已完成", unavailable: "同步失败" };

export interface SyncDescription {
  /** The state for one line in a discussion. */
  label: string;
  /** The state for a settings row's value slot. */
  short: string;
  /** Stage and progress while syncing. */
  progress?: string;
  message?: string;
  lastSuccess?: string;
  tone: "muted" | "warning" | "danger";
}

export function describeSync(status: SyncStatus | null, disconnected: boolean): SyncDescription {
  if (disconnected) return { label: "无法读取 daemon 同步状态；已读历史仍可阅读。", short: "无法读取", message: "已读历史仍可阅读。", tone: "danger" };
  if (!status) return { label: "正在读取同步状态…", short: "读取中", tone: "muted" };
  if (status.stage === "purging" && status.status === "syncing") return {
    label: "清理旧 profile 数据", short: "清理旧 profile 数据", progress: "正在清理旧 profile 本地数据…", tone: "muted",
  };
  const progress = [stages[status.stage],
    status.stage === "archiving" ? `已归档 ${status.completedArchives ?? 0} 项 · 剩余 ${status.pendingArchives ?? 0} 项`
      : status.status === "syncing" ? `Multica 工作区 ${status.completedWorkspaces}/${status.enabledWorkspaces}` : ""
  ].filter(Boolean).join(" · ") || undefined;
  return {
    label: [labels[status.status], progress].filter(Boolean).join(" · "), short: shortLabels[status.status], progress,
    message: status.message || undefined, lastSuccess: formatTime(status.lastSuccessAt),
    tone: status.status === "unavailable" ? "warning" : "muted",
  };
}
