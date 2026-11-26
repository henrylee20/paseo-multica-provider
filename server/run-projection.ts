import { createHash } from "node:crypto";
import type { ProviderEvent, ProviderTimelineItem } from "@getpaseo/plugin/server/provider";
import { isActiveRun, type RunMessage } from "../shared/runs.js";
import type { IssueMapping } from "./state.js";
import type { RunDetail } from "./run-details.js";
import type { StoredRun } from "./run-state.js";
import { textSlice } from "./chunked-text.js";

const statusLabels = { queued: "排队中", dispatched: "已分派", running: "执行中", waiting_local_directory: "等待远端目录", deferred: "延后执行" };
function description(run: StoredRun) {
  const time = run.createdAt && new Date(run.createdAt);
  const stamp = time && Number.isFinite(time.getTime()) ? ` · ${String(time.getMonth() + 1).padStart(2, "0")}-${String(time.getDate()).padStart(2, "0")} ${String(time.getHours()).padStart(2, "0")}:${String(time.getMinutes()).padStart(2, "0")}` : "";
  if (!run.triggerCommentId && !run.coalescedCommentIds.length && !run.deliveredCommentIds?.length && !run.supplementCommentIds.length) return `任务级执行${stamp}`;
  return run.triggerAuthor ? `由 ${run.triggerAuthor} 的评论触发${stamp}` : `由关联评论触发${stamp}`;
}

// Bound individual native transport items, including long errors and tool output.
function chunks(text: string) {
  const result: string[] = [];
  for (let offset = 0; offset < text.length;) {
    const part = textSlice(text, offset, 8192);
    result.push(part); offset += part.length;
  }
  return result.length ? result : [""];
}
function messageItems(runId: string, message: RunMessage): ProviderTimelineItem[] {
  const tool = message.type === "tool_use" || message.type === "tool_result";
  const text = message.type === "tool_use" ? message.input === undefined ? "工具输入缺失" : JSON.stringify(message.input, null, 2)
    : message.type === "tool_result" ? (message.output ?? "输出缺失") + (message.output_truncated === true ? "\n源端已截断：缺失内容无法恢复。" : "")
    : message.content ?? "内容缺失";
  return chunks(text).map((part, index) => {
    const id = `run-message:${runId}:${message.seq}:${index}`;
    // Input and result retain their own source positions, even with absent or reused call_id.
    if (tool) return { type: "tool_call", id, callId: id, name: message.tool || (message.type === "tool_result" ? "工具结果" : "工具调用"), status: "completed", error: null,
      detail: { type: "plain_text", label: message.type === "tool_use" ? "工具调用" : "工具结果", text: part },
      ...(message.call_id ? { metadata: { sourceCallId: message.call_id } } : {}) };
    if (message.type === "error") return { type: "error", id, message: part };
    return { type: message.type === "thinking" ? "reasoning" : "assistant_message", id, text: part };
  });
}

/** One projection per opened parent. Children are read-only and restored by their parent. */
export class RunProjection {
  private readonly children = new Map<string, { sessionId: string; status: StoredRun["status"]; rows: Set<string>; messages: Set<number>; ended?: StoredRun["status"]; changes: number }>();
  constructor(private readonly parentSessionId: string, private readonly rootId: string, private readonly emit: (event: ProviderEvent) => void,
    private readonly detail: (runId: string) => RunDetail | undefined = () => undefined) {}
  project(issue: IssueMapping, replayMarkers = true, runIds: Iterable<string> = Object.keys(issue.runs)) {
    const markers: string[] = [];
    for (const runId of runIds) {
      const run = issue.runs[runId];
      if (run.ownerRootId !== this.rootId) continue;
      let child = this.children.get(runId);
      const fresh = !child;
      if (!child) {
        const sessionId = `${this.parentSessionId}:run:${runId}`;
        const callId = `multica:run-marker:${runId}`;
        const title = run.agentName, detail = description(run);
        if (replayMarkers || !run.markerProjected) {
          markers.push(runId);
          this.emit({ type: "timeline.item", sessionId: this.parentSessionId,
            ...(run.createdAt && Number.isFinite(Date.parse(run.createdAt)) ? { timestamp: run.createdAt } : {}),
            item: { type: "tool_call", id: callId, callId, name: title, status: "completed", error: null,
              detail: { type: "sub_agent", subAgentType: title, description: detail, childSessionId: sessionId, log: "" } } });
        }
        child = { sessionId, status: run.status, rows: new Set(), messages: new Set(), changes: 0 };
        this.children.set(runId, child);
        this.emit({ type: "session.opened", sessionId, parentSessionId: this.parentSessionId, toolCallId: callId, restoration: "parent", capabilities: [], cwd: issue.cwd, title, description: detail });
        this.emit({ type: "session.turn", sessionId, turnId: runId, state: "started" });
      }
      const send = (item: ProviderTimelineItem, timestamp?: string) => {
        if (child!.rows.has(item.id)) return;
        child!.rows.add(item.id);
        this.emit({ type: "timeline.item", sessionId: child!.sessionId, item, ...(timestamp && Number.isFinite(Date.parse(timestamp)) ? { timestamp } : {}) });
      };
      if ((fresh || child.status !== run.status) && isActiveRun(run.status)) send({ type: "notification", id: `run-status:${runId}:${child.changes++}`, level: "info", message: statusLabels[run.status as keyof typeof statusLabels] });
      const cache = this.detail(runId);
      const messages = cache?.messages ?? [];
      let expected = messages[0]?.seq === 0 ? 0 : 1;
      for (const message of messages) {
        if ((isActiveRun(run.status) || !cache?.finalized) && message.seq !== expected) break;
        expected++;
        if (child.messages.has(message.seq)) continue;
        child.messages.add(message.seq);
        for (const item of messageItems(runId, message)) send(item, message.created_at);
      }
      for (const [field, value] of Object.entries(run.metadata ?? {})) {
        if (value == null || value === "") continue;
        const label = ({ error: "任务错误", failure_reason: "失败原因", work_dir: "远端目录", relative_work_dir: "远端相对目录" } as Record<string, string>)[field];
        const revision = createHash("sha256").update(JSON.stringify(value)).digest("hex").slice(0, 16);
        for (const [index, part] of chunks(value).entries()) {
          const id = `run-metadata:${runId}:${field}:${revision}:${index}`;
          send(field === "error" || field === "failure_reason" ? { type: "error", id, message: `${label}：${part}` } : { type: "notification", id, level: "info", message: `${label}：${part}` });
        }
      }
      if (!isActiveRun(run.status) && child.ended !== run.status) {
        this.emit({ type: "session.turn", sessionId: child.sessionId, turnId: runId, state: run.status === "cancelled" ? "canceled" : run.status as "completed" | "failed" });
        child.ended = run.status;
      }
      if (fresh) this.emit({ type: "session.ready", sessionId: child.sessionId });
      child.status = run.status;
    }
    return markers;
  }
  // The host closes parent-restored children and cancels running projections.
  // An explicit child session.closed would incorrectly turn them into completed.
  close() { this.children.clear(); }
}
