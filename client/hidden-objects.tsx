import { useState } from "react";
import { useRpc, type PluginSurfaceProps } from "@getpaseo/plugin/client";
import { SettingsAction, SettingsCard, SettingsSection } from "@getpaseo/plugin/client/ui";
import { hiddenRestore, type HiddenObject } from "../shared/hiding.js";
import { HeaderAction, Notice } from "./ui-kit.js";

/** Shown only while something is hidden or the list cannot be read. */
export function HiddenObjects({ theme, objects, onRefresh }: { theme: PluginSurfaceProps["theme"]; objects: HiddenObject[]; onRefresh(): void }) {
  const restore = useRpc(hiddenRestore);
  const [failure, setFailure] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  async function restoreObject(object: HiddenObject) {
    setSaving(true);
    try {
      const result = await restore({ connectionKey: object.connectionKey, issueId: object.issueId,
        ...(object.rootId === undefined ? {} : { rootId: object.rootId }) });
      if (result.status !== "ready") { setFailure(result.message ?? "恢复失败，请重试。"); return; }
      onRefresh();
      setFailure(null);
    } catch { setFailure("恢复失败；隐藏选择仍保留，请重试。"); }
    finally { setSaving(false); }
  }
  if (!objects.length && !failure) return null;
  return <SettingsSection title="人工隐藏" trailing={<HeaderAction theme={theme} label="刷新" onPress={onRefresh} />}
    info="恢复 Paseo 工作区后，仍需分别恢复其中的隐藏讨论。">
    {failure ? <Notice theme={theme}>{failure}</Notice> : null}
    {objects.length ? <SettingsCard>
      {objects.map(object => <SettingsAction key={JSON.stringify([object.connectionKey, object.issueId, object.kind, object.rootId])} label={object.title}
        hint={object.kind === "workspace" ? "恢复此 Paseo 工作区，讨论需分别恢复。" : "保留原有历史，其他隐藏讨论保持隐藏。"}
        actionLabel={object.kind === "workspace" ? "恢复 Paseo 工作区" : "恢复讨论"} disabled={saving}
        onPress={() => { void restoreObject(object); }} />)}
    </SettingsCard> : null}
  </SettingsSection>;
}
