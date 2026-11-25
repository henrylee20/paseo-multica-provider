import { useEffect, useState } from "react";
import { Text, View } from "react-native";
import { useRpc, type PluginSurfaceProps } from "@getpaseo/plugin/client";
import { Modal, SettingsAction, SettingsCard } from "@getpaseo/plugin/client/ui";
import { rebuildPreflight, rebuildStart, rebuildStatus, type RebuildBlocker, type RebuildProgress } from "../shared/rebuild.js";
import { RuleButton } from "./ui-kit.js";

type Preflight = { projects: number; workspaces: number; discussions: number; blockers: RebuildBlocker[] };
export function DataRebuild({ connectionKey, ready, theme, onRefresh }: { connectionKey?: string; ready: boolean; theme: PluginSurfaceProps["theme"]; onRefresh(): void }) {
  const preflight = useRpc(rebuildPreflight), start = useRpc(rebuildStart), read = useRpc(rebuildStatus);
  const [confirmation, setConfirmation] = useState<Preflight | null>(null);
  const [progress, setProgress] = useState<RebuildProgress | null>(null);
  const [visible, setVisible] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const running = progress?.status === "running";
  useEffect(() => {
    if (!connectionKey) return;
    let active = true, timer: ReturnType<typeof setTimeout> | undefined;
    let previous: string | undefined;
    const update = async () => {
      try {
        const result = await read({ connectionKey });
        if (!active) return;
        setProgress(result);
        if (result.status !== "idle" && previous === undefined) setVisible(true);
        if (previous === "running" && result.status !== "running") onRefresh();
        previous = result.status;
      } catch { if (active) setError("无法读取重建进度，请刷新重试。"); }
      if (active) timer = setTimeout(() => { void update(); }, 2000);
    };
    void update();
    return () => { active = false; if (timer) clearTimeout(timer); };
  }, [connectionKey, read]);
  async function inspect() {
    if (!connectionKey || !ready || busy) return;
    if (running) { setVisible(true); return; }
    setBusy(true); setError(null);
    try { setConfirmation(await preflight({ connectionKey })); }
    catch (error) { setError(error instanceof Error ? error.message : "预检失败，请重试。"); }
    finally { setBusy(false); }
  }
  async function confirm() {
    if (!connectionKey || busy) return;
    setBusy(true); setError(null);
    try {
      const result = await start({ connectionKey });
      if (!result.started) { setConfirmation(previous => previous && { ...previous, blockers: result.blockers }); return; }
      setConfirmation(null); setProgress(result.progress); setVisible(true);
    } catch (error) { setError(error instanceof Error ? error.message : "重建启动失败，请重试。"); }
    finally { setBusy(false); }
  }
  const text = { color: theme.colors.foreground };
  return <>
    <SettingsCard><SettingsAction label="重建数据" actionLabel={running ? "查看重建进度" : busy ? "正在预检…" : "重建数据"} disabled={!ready || busy}
      hint={!ready ? "仅连接就绪时可重建数据，请先恢复 CLI 连接。" : "清理当前连接的 Paseo 数据并按保留的筛选规则重新导入。"} error={error} onPress={() => { void inspect(); }} /></SettingsCard>
    {confirmation ? <Modal open title="确认重建数据" onOpenChange={open => { if (!open && !busy) setConfirmation(null); }}>
      <Modal.Content>
        {confirmation.blockers.length ? <><Text style={text}>存在活跃 Run，请等待结束或先手动 Stop：</Text>{confirmation.blockers.map(group => <Text key={`${group.issueId}:${group.rootId}`} style={text}>{group.title} · {group.discussion}{"\n"}{group.runs.map(run => `${run.agentName} · ${run.runId} · ${run.status}`).join("\n")}</Text>)}</>
          : <><Text style={text}>将删除 {confirmation.projects} 个 Paseo 项目、归档 {confirmation.workspaces} 个插件工作区，并彻底删除 {confirmation.discussions} 个插件讨论及其历史。</Text>
            <Text style={text}>保留筛选规则与启用状态，清除人工隐藏和其余缓存，再从 Multica 重新导入。含用户自建活跃工作区的项目保留。</Text></>}
        {error ? <Text accessibilityRole="alert" style={{ color: theme.colors.statusDanger }}>{error}</Text> : null}
        <View style={{ flexDirection: "row", justifyContent: "flex-end", gap: 8 }}>
          <RuleButton theme={theme} disabled={busy} onPress={() => setConfirmation(null)}>返回</RuleButton>
          {!confirmation.blockers.length ? <RuleButton theme={theme} tone="danger" disabled={busy} onPress={() => { void confirm(); }}>{busy ? "正在启动…" : "确认重建"}</RuleButton> : null}
        </View>
      </Modal.Content>
    </Modal> : null}
    {visible && progress ? <Modal open title="数据重建进度" onOpenChange={open => { if (!open && !running) setVisible(false); }}>
      <Modal.Content>
        <Text style={text}>{progress.stage === "deleting" ? "删除" : "删除完成"} · {progress.stage === "deleting" ? progress.step : "已完成"}</Text>
        <Text style={text}>导入（已完成 {progress.completed} / 共 {progress.total} 个任务）{progress.stage === "deleting" ? " · 等待删除完成" : ""}</Text>
        {running ? <Text style={text}>可离开设置页，daemon 会继续完成重建。</Text> : <><Text accessibilityRole={progress.status === "failed" ? "alert" : undefined} style={text}>{progress.message}</Text>
          <RuleButton theme={theme} onPress={() => { setVisible(false); onRefresh(); }}>关闭</RuleButton></>}
      </Modal.Content>
    </Modal> : null}
  </>;
}
