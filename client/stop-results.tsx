import { useEffect, useState } from "react";
import { useRpc, type PluginSurfaceProps } from "@getpaseo/plugin/client";
import { SettingsAction, SettingsCard, SettingsRow, SettingsSection } from "@getpaseo/plugin/client/ui";
import type { z } from "zod";
import { stopList, stopRetry } from "../shared/stops.js";
import { runStatusLabel } from "./format.js";
import { HeaderAction, Notice } from "./ui-kit.js";

type StopRecord = z.output<typeof stopList.output>["records"][number];
const cleanupLabels = { unknown: "未提供进程清理确认", pending: "进程清理尚待确认", confirmed: "进程清理已确认", unconfirmed: "进程清理未获确认" };
/** Shown only while stop records exist or cannot be read; unconfirmed stops come first. */
export function StopResults({ theme, refreshKey }: { theme: PluginSurfaceProps["theme"]; refreshKey: string }) {
  const list = useRpc(stopList);
  const retry = useRpc(stopRetry);
  const [records, setRecords] = useState<StopRecord[]>([]);
  const [failure, setFailure] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    let active = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    async function update() {
      try { const result = await list({}); if (active) { setRecords(result.records); setFailure(null); } }
      catch { if (active) setFailure("无法读取本地停止记录，请重试。"); }
      if (active) timer = setTimeout(() => { void update(); }, 10_000);
    }
    void update();
    return () => { active = false; if (timer) clearTimeout(timer); };
  }, [list, refreshKey, attempt]);
  async function retryRun(record: StopRecord) {
    setSaving(true);
    try {
      const result = await retry({ connectionKey: record.connectionKey, issueId: record.issueId, rootId: record.rootId, runId: record.runId });
      setRecords((await list({})).records);
      setFailure(result.status === "ready" ? null : result.message ?? "停止重试失败。");
    } catch { setFailure("停止结果尚未确认，请重试。"); }
    finally { setSaving(false); }
  }
  if (!records.length && !failure) return null;
  const sorted = [...records.filter(record => record.retryable), ...records.filter(record => !record.retryable)];
  return <SettingsSection title="停止结果" trailing={<HeaderAction theme={theme} label="刷新" onPress={() => setAttempt(value => value + 1)} />}
    info="原生 Stop 与关闭运行中 tab 会停止该讨论当时归属的未结束 Run。任务终态和远端进程清理分别显示；重试单个未停止项不会恢复隐藏讨论。">
    {failure ? <Notice theme={theme}>{failure}</Notice> : null}
    {sorted.length ? <SettingsCard>
      {sorted.map(record => {
        const key = JSON.stringify([record.connectionKey, record.issueId, record.runId]);
        const hint = `Run ${record.runId} · 最后已知任务状态：${runStatusLabel(record.status)} · ${cleanupLabels[record.cleanup]}`;
        return record.retryable
          ? <SettingsAction key={key} label={record.title} hint={hint} error={record.message ?? "此 Run 尚未确认停止。"} actionLabel="重试此 Run" disabled={saving}
            onPress={() => { void retryRun(record); }} />
          : <SettingsRow key={key} label={record.title} hint={record.message ? `${hint}\n${record.message}` : hint} />;
      })}
    </SettingsCard> : null}
  </SettingsSection>;
}
