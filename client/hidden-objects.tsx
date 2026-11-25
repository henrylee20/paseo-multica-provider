import { useEffect, useState } from "react";
import { useRpc, type PluginSurfaceProps } from "@getpaseo/plugin/client";
import { SettingsAction, SettingsCard, SettingsSection } from "@getpaseo/plugin/client/ui";
import type { z } from "zod";
import { hiddenList, hiddenRestore } from "../shared/hiding.js";
import { HeaderAction, Notice } from "./ui-kit.js";

type HiddenObject = z.output<typeof hiddenList.output>["objects"][number];
/** Shown only while something is hidden or the list cannot be read. */
export function HiddenObjects({ theme, refreshKey }: { theme: PluginSurfaceProps["theme"]; refreshKey: string }) {
  const list = useRpc(hiddenList);
  const restore = useRpc(hiddenRestore);
  const [objects, setObjects] = useState<HiddenObject[]>([]);
  const [failure, setFailure] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    let active = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    async function update() {
      try { const result = await list({}); if (active) { setObjects(result.objects); setFailure(null); } }
      catch { if (active) setFailure("无法读取此 daemon 的隐藏对象，请重试。"); }
      if (active) timer = setTimeout(() => { void update(); }, 10_000);
    }
    void update();
    return () => { active = false; if (timer) clearTimeout(timer); };
  }, [list, refreshKey, attempt]);
  async function restoreObject(object: HiddenObject) {
    setSaving(true);
    try {
      const result = await restore({ connectionKey: object.connectionKey, issueId: object.issueId,
        ...(object.rootId === undefined ? {} : { rootId: object.rootId }) });
      if (result.status !== "ready") { setFailure(result.message ?? "恢复失败，请重试。"); return; }
      setObjects((await list({})).objects);
      setFailure(null);
    } catch { setFailure("恢复失败；隐藏选择仍保留，请重试。"); }
    finally { setSaving(false); }
  }
  if (!objects.length && !failure) return null;
  return <SettingsSection title="人工隐藏" trailing={<HeaderAction theme={theme} label="刷新" onPress={() => setAttempt(value => value + 1)} />}
    info="关闭讨论 tab 或归档 Paseo 工作区后持续隐藏，同一 daemon 的客户端共享此选择。恢复 Paseo 工作区不会恢复其中隐藏的讨论；恢复某个讨论会先恢复其原 Paseo 工作区。恢复后仍遵循 Multica 工作区筛选规则。">
    {failure ? <Notice theme={theme}>{failure}</Notice> : null}
    {objects.length ? <SettingsCard>
      {objects.map(object => <SettingsAction key={JSON.stringify([object.connectionKey, object.issueId, object.kind, object.rootId])} label={object.title}
        hint={object.kind === "workspace" ? "Paseo 工作区 · 保留原目录；其中的讨论 tab 需分别恢复。" : "讨论 · 恢复原身份与已有历史；其他隐藏讨论保持隐藏。"}
        actionLabel={object.kind === "workspace" ? "仅恢复 Paseo 工作区" : "恢复此讨论"} disabled={saving}
        onPress={() => { void restoreObject(object); }} />)}
    </SettingsCard> : null}
  </SettingsSection>;
}
