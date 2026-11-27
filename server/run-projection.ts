import { createHash } from "node:crypto";
import type { ProviderEvent, ProviderTimelineItem } from "@getpaseo/plugin/server/provider";
import { isActiveRun, type RunMessage } from "../shared/runs.js";
import type { IssueMapping } from "./state.js";
import type { RunDetail } from "./run-details.js";
import type { StoredRun } from "./run-state.js";
import { textSlice } from "./chunked-text.js";
import type { AgentTimelineItem } from "@getpaseo/protocol/agent-types";
import type { NativeHost } from "./native-host.js";

function rowKey(item: AgentTimelineItem | ProviderTimelineItem) {
  return item.type === "tool_call" ? `tool:${item.callId}` : item.type === "notification" ? `notification:${item.level}:${item.message}`
    : item.type === "error" ? `error:${item.message}` : JSON.stringify(item);
}
type NativeRunBaseline = { texts: Map<string, string>; thoughts: string; counts: Map<string, number>; hasRunTools: boolean };
/** Native text rows merge transport fragments, while errors/notifications lose IDs. */
function nativeRunBaseline(existing: readonly AgentTimelineItem[]): NativeRunBaseline {
  const texts = new Map<string, string>();
  const counts = new Map<string, number>();
  let thoughts = "";
  let hasRunTools = false;
  for (const item of existing) {
    if (item.type === "tool_call" && item.callId.startsWith("run-message:")) hasRunTools = true;
    if (item.type === "assistant_message" && item.messageId) texts.set(item.messageId, (texts.get(item.messageId) ?? "") + item.text);
    // Status/metadata notifications can split consecutive source thinking.
    else if (item.type === "reasoning") thoughts += item.text;
    else {
      const key = rowKey(item);
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }
  }
  return { texts, thoughts, counts, hasRunTools };
}
function consumeRunItems(items: ProviderTimelineItem[], previous: NativeRunBaseline): ProviderTimelineItem[] {
  const { texts, counts } = previous;
  return items.flatMap<ProviderTimelineItem>(item => {
    if (item.type === "assistant_message" || item.type === "reasoning") {
      const key = item.type === "assistant_message" ? item.messageId ?? item.id : undefined;
      const prefix = key === undefined ? previous.thoughts : texts.get(key) ?? "";
      if (!prefix) return [item];
      if (prefix.startsWith(item.text)) {
        const rest = prefix.slice(item.text.length);
        if (key === undefined) previous.thoughts = rest;
        else if (rest) texts.set(key, rest); else texts.delete(key);
        return [];
      }
      if (item.text.startsWith(prefix)) {
        if (key === undefined) previous.thoughts = ""; else texts.delete(key);
        return [{ ...item, text: item.text.slice(prefix.length) }];
      }
      // Conflicting cached text is not permission to append it a second time.
      return [];
    }
    const key = rowKey(item);
    const count = counts.get(key) ?? 0;
    if (!count) return [item];
    if (count > 1) counts.set(key, count - 1); else counts.delete(key);
    return [];
  });
}
export function missingRunItems(items: ProviderTimelineItem[], existing: readonly AgentTimelineItem[]): ProviderTimelineItem[] {
  return consumeRunItems(items, nativeRunBaseline(existing));
}

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
function messageItems(runId: string, message: RunMessage, messageId?: string): ProviderTimelineItem[] {
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
    if (message.type === "thinking") return { type: "reasoning", id, text: part };
    return { type: "assistant_message", id, messageId, text: part };
  });
}

/** One projection per opened parent. Children are read-only and restored by their parent. */
export class RunProjection {
  private readonly previous = new Map<string, NativeRunBaseline | null>();
  private readonly children = new Map<string, {
    sessionId: string; status: StoredRun["status"]; compact: boolean; rows: Set<string>; messages: Set<number>;
    textSegment?: { messageId: string; lastSeq: number };
    tools?: { seq: number; timestamp?: string; uses: number; callIds: Set<string>; results: Array<string | undefined> };
    ended?: StoredRun["status"]; changes: number;
  }>();
  constructor(private readonly parentSessionId: string, private readonly rootId: string, private readonly emit: (event: ProviderEvent) => void,
    private readonly detail: (runId: string) => RunDetail | undefined = () => undefined) {}
  async restore(host: NativeHost, agentId: string, issue: IssueMapping) {
    const owned = Object.keys(issue.runs).filter(id => issue.runs[id].ownerRootId === this.rootId);
    // Unknown history suppresses only the initial cached batch; future deltas
    // and status/terminal events remain live even if the host read fails.
    for (const id of owned) this.previous.set(id, null);
    let listed: Awaited<ReturnType<NativeHost["listProviderSubagents"]>> | undefined;
    try { listed = await host.listProviderSubagents(agentId); } catch { return; }
    if (!listed || listed.error || listed.parentAgentId !== agentId) return;
    for (const id of owned) {
      const sessionId = `multica:run:${id}`;
      if (!listed.subagents.some(child => child.id === sessionId)) { this.previous.delete(id); continue; }
      try {
        const rows: AgentTimelineItem[] = [];
        let cursor: { epoch: string; seq: number } | undefined;
        for (;;) {
          const page = await host.fetchProviderSubagentTimeline(agentId, sessionId, { direction: cursor ? "before" : "tail", cursor, limit: 1000 });
          if (page.error || page.parentAgentId !== agentId || page.subagentId !== sessionId || page.gap || page.staleCursor || page.hasNewer ||
            cursor && (page.reset || page.epoch !== cursor.epoch)) throw new Error("Incomplete Run timeline");
          rows.unshift(...page.rows.map(row => row.item));
          if (!page.hasOlder) break;
          const next = page.startCursor;
          if (!next || cursor && next.seq >= cursor.seq) throw new Error("Incomplete Run timeline");
          cursor = next;
        }
        this.previous.set(id, nativeRunBaseline(rows));
      } catch { /* Restore state without replaying unknown history. */ }
    }
  }
  project(issue: IssueMapping, replayMarkers = true, runIds: Iterable<string> = Object.keys(issue.runs)) {
    const markers: string[] = [];
    for (const runId of runIds) {
      const run = issue.runs[runId];
      if (run.ownerRootId !== this.rootId) continue;
      let child = this.children.get(runId);
      const fresh = !child;
      if (!child) {
        const sessionId = `multica:run:${runId}`;
        const callId = `multica:run-marker:${runId}`;
        const title = run.agentName, detail = description(run);
        if (replayMarkers || !run.markerProjected) {
          markers.push(runId);
          this.emit({ type: "timeline.item", sessionId: this.parentSessionId,
            ...(run.createdAt && Number.isFinite(Date.parse(run.createdAt)) ? { timestamp: run.createdAt } : {}),
            item: { type: "tool_call", id: callId, callId, name: title, status: "completed", error: null,
              detail: { type: "sub_agent", subAgentType: title, description: detail, childSessionId: sessionId, log: "" } } });
        }
        // Freeze the mode before reconciliation consumes/deletes the native baseline.
        child = { sessionId, status: run.status, compact: !isActiveRun(run.status) && !this.previous.get(runId)?.hasRunTools, rows: new Set(), messages: new Set(), changes: 0 };
        this.children.set(runId, child);
        this.emit({ type: "session.opened", sessionId, parentSessionId: this.parentSessionId, toolCallId: callId, restoration: "parent", capabilities: [], cwd: issue.cwd, title, description: detail });
        if (isActiveRun(run.status)) this.emit({ type: "session.turn", sessionId, turnId: runId, state: "started" });
      }
      const batch: Array<{ item: ProviderTimelineItem; timestamp?: string }> = [];
      const send = (item: ProviderTimelineItem, timestamp?: string) => {
        if (child!.rows.has(item.id)) return;
        child!.rows.add(item.id);
        batch.push({ item, timestamp });
      };
      const flushTools = () => {
        const tools = child!.tools;
        if (!tools) return;
        const count = tools.uses + tools.results.filter(id => !id || !tools.callIds.has(id)).length;
        send({ type: "notification", id: `run-tools:${runId}:${tools.seq}`, level: "info", message: `进行了 ${count} 次工具调用` }, tools.timestamp);
        child!.tools = undefined;
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
        // Keep incremental text identity across reads; gaps and non-text sources end the segment.
        child.textSegment = message.type === "text" ? {
          messageId: child.textSegment?.lastSeq === message.seq - 1 ? child.textSegment.messageId : `run-text:${runId}:${message.seq}`,
          lastSeq: message.seq,
        } : undefined;
        if (child.compact) {
          if (message.type === "tool_use" || message.type === "tool_result") {
            const tools = child.tools ??= { seq: message.seq, timestamp: message.created_at, uses: 0, callIds: new Set(), results: [] };
            if (message.type === "tool_use") {
              tools.uses++;
              if (message.call_id) tools.callIds.add(message.call_id);
            } else tools.results.push(message.call_id);
            continue;
          }
          flushTools();
        }
        for (const item of messageItems(runId, message, child.textSegment?.messageId)) send(item, message.created_at);
      }
      if (cache?.finalized) flushTools();
      for (const [field, value] of Object.entries(run.metadata ?? {})) {
        if (value == null || value === "") continue;
        const label = ({ error: "任务错误", failure_reason: "失败原因", work_dir: "远端目录", relative_work_dir: "远端相对目录" } as Record<string, string>)[field];
        const revision = createHash("sha256").update(JSON.stringify(value)).digest("hex").slice(0, 16);
        for (const [index, part] of chunks(value).entries()) {
          const id = `run-metadata:${runId}:${field}:${revision}:${index}`;
          send(field === "error" || field === "failure_reason" ? { type: "error", id, message: `${label}：${part}` } : { type: "notification", id, level: "info", message: `${label}：${part}` });
        }
      }
      const previous = this.previous.get(runId);
      const missing = previous === null ? [] : previous ? consumeRunItems(batch.map(row => row.item), previous) : batch.map(row => row.item);
      // A missing cache may arrive on the first remote read after opening.
      // Keep the native baseline until source output and any pending tool summary reconcile.
      if (!(previous && child.tools) && (cache && (cache.messages.length || cache.finalized) || previous && !previous.texts.size && !previous.thoughts && !previous.counts.size)) this.previous.delete(runId);
      const timestamps = new Map(batch.map(row => [row.item.id, row.timestamp]));
      for (const item of missing) {
        const timestamp = timestamps.get(item.id);
        this.emit({ type: "timeline.item", sessionId: child.sessionId, item, ...(timestamp && Number.isFinite(Date.parse(timestamp)) ? { timestamp } : {}) });
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
  closeChild(sessionId: string) {
    for (const [runId, child] of this.children) if (child.sessionId === sessionId) {
      this.children.delete(runId); this.previous.set(runId, null); return true;
    }
    return false;
  }
}
