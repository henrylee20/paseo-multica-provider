import { useEffect } from "react";
import { Text, View } from "react-native";
import { useRpc, type PluginTimelineItemProps } from "@getpaseo/plugin/client";
import type { z } from "zod";
import { runObserve, runSummarySchema } from "../shared/runs.js";

export function RunSummary({ item, theme }: PluginTimelineItemProps<z.infer<typeof runSummarySchema>>) {
  const observe = useRpc(runObserve);
  const { connectionKey, issueId, rootId, agentName, agentId, runId, status } = item.data;
  useEffect(() => {
    // Import replay precedes native session registration. A mounted timeline is
    // an additional safe opportunity to reflect cached active work to the host.
    void observe({ connectionKey, issueId, rootId }).catch(() => {});
  }, [observe, connectionKey, issueId, rootId]);
  return <View style={{ gap: 4 }}>
    <Text style={{ color: theme.colors.foreground }}>{agentName} · {status}</Text>
    <Text selectable style={{ color: theme.colors.foregroundMuted }}>Run {runId} · Agent {agentId}</Text>
  </View>;
}
