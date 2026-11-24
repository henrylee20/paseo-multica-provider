import { useEffect, useState } from "react";
import { Pressable, Text, View } from "react-native";
import { useRpc, type PluginTimelineItemProps } from "@getpaseo/plugin/client";
import type { z } from "zod";
import { runObserve, runOpen, runRead, runMetadataRead, runMetadataSchema, runMessageSchema, runSummarySchema, type RunMessage, type RunMetadata } from "../shared/runs.js";
import { collectText } from "./chunked-text.js";
import { RunMetadataView } from "./run-metadata.js";

type Props = PluginTimelineItemProps<z.infer<typeof runSummarySchema>>;
export function RunSummary(props: Props) {
  const { connectionKey, issueId, rootId, runId } = props.item.data;
  return <RunSummaryBody key={JSON.stringify([connectionKey, issueId, rootId, runId])} {...props} />;
}

function RunSummaryBody({ item, theme }: Props) {
  const observe = useRpc(runObserve);
  const open = useRpc(runOpen);
  const read = useRpc(runRead);
  const readMetadata = useRpc(runMetadataRead);
  const [expanded, setExpanded] = useState(false);
  const [messages, setMessages] = useState<RunMessage[]>([]);
  const [metadata, setMetadata] = useState<RunMetadata>();
  const [notice, setNotice] = useState("");
  const [attempt, setAttempt] = useState(0);
  const { connectionKey, issueId, rootId, agentName, agentId, runId, status } = item.data;
  useEffect(() => {
    // Import replay precedes native session registration. A mounted timeline is
    // an additional safe opportunity to reflect cached active work to the host.
    void observe({ connectionKey, issueId, rootId }).catch(() => {});
  }, [observe, connectionKey, issueId, rootId]);
  useEffect(() => {
    if (!expanded) return;
    let active = true;
    let reading = false;
    let revision: string | undefined;
    let metadataRevision: string | undefined;
    const refresh = async () => {
      if (reading) return;
      reading = true;
      try {
        const address = { connectionKey, issueId, rootId, runId };
        const result = await open(address);
        if (!active) return;
        if (result.metadataRevision && result.metadataRevision !== metadataRevision) {
          const text = await collectText(offset => readMetadata({ ...address, revision: result.metadataRevision!, offset }), () => active);
          if (text === undefined) return;
          setMetadata(runMetadataSchema.parse(JSON.parse(text)));
          metadataRevision = result.metadataRevision;
        }
        if (!result.revision) { setNotice(result.message ?? "无法读取执行明细；已读内容仍保留。"); return; }
        if (result.revision !== revision) {
          const text = await collectText(offset => read({ ...address, revision: result.revision!, offset }), () => active);
          if (text === undefined) return;
          const records = runMessageSchema.array().parse(JSON.parse(text));
          setMessages(records);
          revision = result.revision;
        }
        setNotice(result.status === "cached" ? result.message ?? "正在显示已读缓存。" : "");
      } catch { if (active) setNotice("执行明细暂不可用，保留已读内容；将自动重试。"); }
      finally { reading = false; }
    };
    setNotice("正在读取执行明细…");
    void refresh();
    const timer = setInterval(() => { void refresh(); }, 2000);
    return () => { active = false; clearInterval(timer); };
  }, [expanded, open, read, readMetadata, connectionKey, issueId, rootId, runId, attempt]);

  const color = { color: theme.colors.foreground };
  const muted = { color: theme.colors.foregroundMuted };
  const calls = new Map<string, { inputs: number[]; results: number[] }>();
  for (const message of messages) {
    if (!message.call_id?.trim() || (message.type !== "tool_use" && message.type !== "tool_result")) continue;
    const key = JSON.stringify([message.task_id, message.call_id]);
    const call = calls.get(key) ?? { inputs: [], results: [] };
    (message.type === "tool_use" ? call.inputs : call.results).push(message.seq);
    calls.set(key, call);
  }
  return <View style={{ gap: 4 }}>
    <Text style={color}>{agentName} · {status}</Text>
    <Text selectable style={muted}>Run {runId} · Agent {agentId}</Text>
    <Pressable accessibilityRole="button" onPress={() => setExpanded(value => !value)}><Text style={color}>{expanded ? "收起执行明细" : "展开执行明细"}</Text></Pressable>
    {expanded ? <View style={{ gap: 10 }}>
      {notice ? <Text style={muted}>{notice}</Text> : null}
      <RunMetadataView metadata={metadata} theme={theme} />
      {!messages.length && !notice ? <Text style={muted}>暂无可用执行消息。</Text> : null}
      {messages.map(message => <View key={`${message.task_id}:${message.seq}`} style={{ gap: 4 }}>
        <Text style={muted}>#{message.seq} · {({ text: "运行文本", thinking: "思考记录", tool_use: "工具调用", tool_result: "工具结果", error: "执行错误" })[message.type]}{message.created_at ? ` · ${message.created_at}` : ""}</Text>
        {message.type === "tool_use" || message.type === "tool_result" ? <>
          <Text selectable style={muted}>{toolRelation(message, calls)}</Text>
          {message.type === "tool_use" ? <>
            <Text selectable style={muted}>{message.tool || "工具名称缺失"}</Text>
            <Text selectable style={color}>{message.input === undefined ? "工具输入缺失" : JSON.stringify(message.input, null, 2)}</Text>
          </> : <>
            <Text style={muted}>{message.output_truncated === true ? "源端已截断：缺失内容无法恢复。" : message.output_truncated === false ? "来源标记输出完整。" : "输出完整性未知：来源未提供截断标记。"}</Text>
            <Text selectable style={color}>{message.output === undefined ? "输出缺失" : message.output || "（空输出）"}</Text>
          </>}
        </> : <Text selectable style={color}>{message.content === undefined ? "内容缺失" : message.content || "（空文本）"}</Text>}
      </View>)}
      <Pressable accessibilityRole="button" onPress={() => setAttempt(value => value + 1)}><Text style={color}>重新读取执行明细</Text></Pressable>
    </View> : null}
  </View>;
}

function toolRelation(message: RunMessage, calls: Map<string, { inputs: number[]; results: number[] }>) {
  if (!message.call_id?.trim()) return "调用关联未知（缺少可靠调用 ID）";
  const { inputs, results } = calls.get(JSON.stringify([message.task_id, message.call_id]))!;
  const id = `调用 ID：${message.call_id}`;
  if (inputs.length > 1 || results.length > 1) return `${id} · 调用关联未知（调用 ID 不唯一）`;
  if (message.type === "tool_use") return `${id} · ${results.length === 1 ? `结果序号 #${results[0]}` : "结果缺失"}`;
  return `${id} · ${inputs.length === 1 ? `输入序号 #${inputs[0]}` : "输入缺失"}`;
}
