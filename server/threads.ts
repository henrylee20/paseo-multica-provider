import { assertWritableIssue } from "./access.js";
import { nativeOriginals, hasNativeOriginal } from "./projection-recovery.js";
import { createHash } from "node:crypto";
import { z } from "zod";
import type { ProviderTimelineItem } from "@getpaseo/plugin/server/provider";
import { remoteFetch, type AuthenticatedConnection } from "./connection.js";
import { findNativeDiscussion, type NativeHost } from "./native-host.js";
import { StateStore } from "./state.js";
import type { IssueMapping } from "./state.js";
import type { StoredRow } from "./thread-state.js";
import { remoteJson, workspaceSchema, type RemoteWorkspace } from "./sync.js";
import { discussionKeys } from "../shared/discussion.js";
import type { threadAddress } from "../shared/threads.js";
import type { AskUsers } from "./askuser.js";

type Address = z.infer<typeof threadAddress>;
const attachmentSchema = z.object({ id: z.string().optional().catch(undefined), filename: z.string().optional().catch(undefined), content_type: z.unknown().optional(), file_name: z.string().optional().catch(undefined), name: z.string().optional().catch(undefined), url: z.string().optional().catch(undefined), download_url: z.string().optional().catch(undefined) }).catch({});
const commentSchema = z.object({
  id: z.string(), issue_id: z.string(), parent_id: z.string().nullish(), content: z.string(),
  author_id: z.string(), author_type: z.enum(["member", "agent", "system"]), type: z.enum(["comment", "status_change", "progress_update", "system"]),
  created_at: z.string().optional(), updated_at: z.string().optional(), revision: z.number().optional(),
  source_task_id: z.string().nullish(), deleted_at: z.string().nullish(), attachments: z.array(attachmentSchema).nullish(), content_truncated: z.boolean().optional(),
});
type Comment = z.infer<typeof commentSchema>;
const hash = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const key = (address: Address) => JSON.stringify([address.connectionKey, address.issueId, address.rootId]);
export const projectionHistory = (issue: IssueMapping, rootId: string) => rootId === "main" ? issue.mainHistory : issue.threads[rootId];
export function threadPersistence(connectionKey: string, issueId: string, rootId: string) {
  return { version: 1, data: { connectionKey, issueId, discussion: "thread", rootId } } as const;
}

/** Resolve arbitrary descendant depth. Broken links and cycles remain unknown. */
function rootsOf(comments: Map<string, Comment>): Map<string, string | undefined> {
  const roots = new Map<string, string | undefined>();
  for (const id of comments.keys()) {
    let current = comments.get(id);
    const path = new Set<string>();
    let rootId: string | undefined;
    while (current) {
      if (roots.has(current.id)) { rootId = roots.get(current.id); break; }
      if (path.has(current.id)) break;
      path.add(current.id);
      if (!current.parent_id) { rootId = current.id; break; }
      current = comments.get(current.parent_id);
    }
    for (const commentId of path) roots.set(commentId, rootId);
  }
  return roots;
}
function body(comment: Comment, apiUrl: string): string {
  const links = (comment.attachments ?? []).map(attachment => {
    const url = attachment.url ?? attachment.download_url;
    if (!url) return `[附件 ${attachment.filename ?? attachment.file_name ?? attachment.name ?? attachment.id ?? ""}：链接不可用]`;
    let href: URL;
    try { href = new URL(url, `${apiUrl}/`); } catch { return "[附件：链接不可用]"; }
    if (!/^https?:$/.test(href.protocol)) return "[附件：链接不可用]";
    const label = (attachment.filename ?? attachment.file_name ?? attachment.name ?? attachment.id ?? "附件").replace(/[\\\[\]]/g, "\\$&");
    return `[${label}](${href.href.replace(/\(/g, "%28").replace(/\)/g, "%29")})`;
  });
  return [comment.content, ...links].filter(Boolean).join("\n\n");
}

export function projectRow(address: Address, row: StoredRow): ProviderTimelineItem {
  if (row.role === "user") return { type: "user_message", id: row.id, messageId: row.commentId, text: row.text, ...(row.clientMessageId ? { clientMessageId: row.clientMessageId } : {}) };
  if (row.role === "assistant") return { type: "assistant_message", id: row.id, messageId: row.commentId, text: row.text };
  // Row payloads stay below the host's 64 KiB limit; full correction text stays available via RPC.
  const preview = [...row.text].slice(0, 6000).join("");
  return { type: "plugin", id: row.id, pluginId: "multica", kind: "comment-event", version: 1, data: {
    ...address, recordId: row.id, commentId: row.commentId, category: row.category ?? "system", text: preview,
    truncated: preview !== row.text, ...(row.sourceCreatedAt ? { sourceCreatedAt: row.sourceCreatedAt } : {}),
    ...(row.sourceUpdatedAt ? { sourceUpdatedAt: row.sourceUpdatedAt } : {}),
  } };
}

export class ThreadSynchronizer {
  private readonly listeners = new Map<string, Set<{ deliver(row: StoredRow, includeOriginal?: boolean): void; recovery: boolean }>>();
  private readonly opened = new Set<string>();
  private readonly pending = new Map<string, Promise<void>>();
  private waitForDeliveries: () => Promise<void> = async () => {};
  constructor(private readonly store: StateStore, private readonly connection: () => Promise<AuthenticatedConnection>, private readonly askusers: AskUsers) {}
  coordinateDeliveries(wait: () => Promise<void>) { this.waitForDeliveries = wait; }
  subscribe(address: Address, deliver: (row: StoredRow, includeOriginal?: boolean) => void, recovery = false) {
    const listener = { deliver, recovery };
    const id = key(address);
    const listeners = this.listeners.get(id) ?? new Set();
    listeners.add(listener); this.listeners.set(id, listeners);
    return () => { listeners.delete(listener); if (!listeners.size) this.listeners.delete(id); };
  }
  async reconcile(host: NativeHost) {
    for (const [id, listeners] of this.listeners) {
      const recovering = [...listeners].filter(listener => listener.recovery);
      if (!recovering.length) continue;
      const [connectionKey, issueId, rootId] = JSON.parse(id) as string[];
      const issue = (await this.store.read()).connections[connectionKey]?.issues[issueId];
      const history = issue && projectionHistory(issue, rootId);
      const agentId = rootId === "main" ? issue?.mainAgentId : history?.agentId;
      if (!history || !agentId) continue;
      const entries = history.rows.some(row => row.role !== "event") ? await nativeOriginals(host, agentId) : [];
      // Validate every original before publishing any missing row.
      const rows = history.rows.map(row => ({ row, includeOriginal: row.role === "event" || !hasNativeOriginal(entries, row) }));
      for (const listener of recovering) {
        for (const { row, includeOriginal } of rows) listener.deliver(row, includeOriginal);
        listener.recovery = false;
      }
    }
  }
  private async pages(connection: AuthenticatedConnection, workspace: RemoteWorkspace, issueId: string, mode: Record<string, string>) {
    const comments = new Map<string, Comment>();
    const seen = new Set<string>();
    let cursor: { before: string; before_id: string } | undefined;
    for (;;) {
      const query = new URLSearchParams({ ...mode, ...cursor });
      const response = await remoteFetch(connection, `/api/issues/${encodeURIComponent(issueId)}/comments?${query}`, { headers: { "X-Workspace-Slug": workspace.slug } });
      if (!response.ok) { await response.body?.cancel(); throw new Error("Comment history unavailable"); }
      if (response.headers.get("X-Comments-Truncated")?.toLowerCase() === "true") { await response.body?.cancel(); throw new Error("Remote comments were truncated"); }
      const page = z.array(commentSchema).parse(await response.json());
      await connection.assertCurrent?.();
      for (const comment of page) {
        if (comment.issue_id !== issueId) throw new Error("Comment belongs to another issue");
        comments.set(comment.id, comment);
      }
      const before = response.headers.get("X-Multica-Next-Before");
      const before_id = response.headers.get("X-Multica-Next-Before-Id");
      if (!before && !before_id) break;
      if (!before || !before_id || seen.has(`${before}/${before_id}`)) throw new Error("Incomplete comment cursor");
      seen.add(`${before}/${before_id}`); cursor = { before, before_id };
    }
    return comments;
  }
  async discover(connection: AuthenticatedConnection, workspace: RemoteWorkspace, issueId: string, host: NativeHost) {
    const comments = await this.pages(connection, workspace, issueId, { recent: "100", summary: "true" });
    const roots = rootsOf(comments);
    await this.store.update(state => {
      const issue = state.connections[connection.connectionKey].issues[issueId];
      issue.unresolvedCommentIds = [];
      issue.systemRootIds = [...comments.values()].filter(comment => !comment.parent_id && (comment.type !== "comment" || comment.author_type === "system")).map(comment => comment.id);
      for (const comment of comments.values()) {
        const rootId = roots.get(comment.id);
        if (comment.created_at) issue.commentCreatedAt[comment.id] = comment.created_at;
        if (comment.source_task_id) issue.commentSourceTaskIds[comment.id] = comment.source_task_id;
        if (rootId) issue.commentRoots[comment.id] = issue.systemRootIds.includes(rootId) ? "main" : rootId;
        else issue.unresolvedCommentIds.push(comment.id);
      }
    });
    await this.askusers.discover(connection, workspace, issueId, [...comments.values()], roots);
    // A completely removed root cannot be fetched via ?thread any more. The
    // complete activity sweep still proves missing IDs, unless ancestry broke.
    if (![...roots.values()].some(rootId => rootId === undefined)) {
      const deletions: Array<{ address: Address; row: StoredRow }> = [];
      await this.store.update(state => {
        const issue = state.connections[connection.connectionKey].issues[issueId];
        for (const [rootId, history] of [["main", issue.mainHistory] as const, ...Object.entries(issue.threads)]) {
          for (const [commentId, previous] of Object.entries(history.observed)) {
            if (comments.has(commentId) || previous.deleted) continue;
            const row: StoredRow = { id: `multica:deletion:${commentId}:missing`, commentId, role: "event", category: "deletion", text: "此评论已不在完整远端快照中；保留先前读到的原始记录。" };
            if (!history.rows.some(existing => existing.id === row.id)) {
              history.rows.push(row);
              deletions.push({ address: { connectionKey: connection.connectionKey, issueId, rootId }, row });
            }
            previous.deleted = true;
          }
        }
      });
      for (const { address, row } of deletions) for (const listener of this.listeners.get(key(address)) ?? []) listener.deliver(row);
    }
    for (const root of [...comments.values()].filter(comment => !comment.parent_id && comment.type === "comment" && comment.author_type !== "system")) {
      await this.store.update(state => {
        const threads = state.connections[connection.connectionKey].issues[issueId].threads;
        threads[root.id] ??= { title: root.deleted_at ? "已删除的 Thread" : root.content.slice(0, 100) || "Thread", historyLoaded: false, rows: [], observed: {} };
      });
      const issue = (await this.store.read()).connections[connection.connectionKey].issues[issueId];
      const mapping = issue.threads[root.id];
      if (issue.manualHidden.workspace || issue.manualHidden.discussions.includes(root.id)) continue;
      let agentId = mapping.agentId;
      if (!agentId) {
        const labels = { [discussionKeys.connection]: connection.connectionKey, [discussionKeys.issue]: issueId, [discussionKeys.discussion]: root.id };
        agentId = (await findNativeDiscussion(host, { workspaceId: issue.workspaceId, provider: "multica", labels }))?.id;
        agentId ??= (await host.importAgent({ providerId: "multica", providerHandleId: `plugin:${JSON.stringify(threadPersistence(connection.connectionKey, issueId, root.id))}`,
          cwd: issue.cwd, workspaceId: issue.workspaceId, labels })).id;
        await this.store.update(state => { state.connections[connection.connectionKey].issues[issueId].threads[root.id].agentId = agentId; });
      }
      await host.updateAgent(agentId, { name: mapping.title });
      const address = { connectionKey: connection.connectionKey, issueId, rootId: root.id };
      if (mapping.historyLoaded && this.opened.has(key(address))) await this.refresh(connection, workspace, address, false);
    }
    if (this.opened.has(key({ connectionKey: connection.connectionKey, issueId, rootId: "main" })) && (await this.store.read()).connections[connection.connectionKey].issues[issueId].mainHistory.historyLoaded) {
      await this.refresh(connection, workspace, { connectionKey: connection.connectionKey, issueId, rootId: "main" }, false);
    }
  }
  async open(address: Address): Promise<{ status: "ready" | "cached" | "unavailable"; message?: string }> {
    const issue = (await this.store.read()).connections[address.connectionKey]?.issues[address.issueId];
    const thread = issue ? projectionHistory(issue, address.rootId) : undefined;
    if (!thread) return { status: "unavailable", message: "此 Thread 尚未映射。" };
    if (issue?.access?.status === "inaccessible") return { status: thread.historyLoaded ? "cached" : "unavailable",
      message: `此任务已不可访问，仅显示只读缓存。最后完整同步：${issue.access.lastSuccessAt ?? "未知"}。` };
    this.opened.add(key(address));
    try {
      assertWritableIssue(issue);
      const connection = await this.connection();
      if (connection.connectionKey !== address.connectionKey) throw new Error("Connection identity changed");
      const workspaces = await remoteJson(connection, "/api/workspaces", z.array(workspaceSchema)) as RemoteWorkspace[];
      const workspace = workspaces.find(value => value.id === issue.remoteWorkspaceId);
      if (!workspace) throw new Error("Workspace unavailable");
      await this.refresh(connection, workspace, address);
      return { status: "ready" };
    } catch { return { status: thread.historyLoaded ? "cached" : "unavailable", message: "无法完整读取远端 Thread；保留已读的本地历史。" }; }
  }
  private refresh(connection: AuthenticatedConnection, workspace: RemoteWorkspace, address: Address, discoverCards = true) {
    const id = key(address);
    const operation = (this.pending.get(id) ?? Promise.resolve()).catch(() => {}).then(async () => {
      const issue = (await this.store.read()).connections[address.connectionKey].issues[address.issueId];
      assertWritableIssue(issue);
      const rootIds = address.rootId === "main" ? issue.systemRootIds : [address.rootId];
      const comments = new Map<string, Comment>();
      for (const rootId of rootIds) for (const [id, comment] of await this.pages(connection, workspace, address.issueId, { thread: rootId, tail: "100" })) comments.set(id, comment);
      const roots = rootsOf(comments);
      if (rootIds.some(rootId => !comments.has(rootId)) || [...comments.values()].some(comment => comment.content_truncated || !rootIds.includes(roots.get(comment.id) ?? ""))) {
        throw new Error("Thread snapshot is incomplete");
      }
      const [members, agents] = await Promise.all([
        [...comments.values()].some(comment => comment.type === "comment" && comment.author_type === "member" && comment.author_id !== connection.userId)
          ? remoteJson(connection, `/api/workspaces/${encodeURIComponent(workspace.id)}/members`, z.array(z.object({ user_id: z.string(), name: z.string() })), workspace) : [],
        [...comments.values()].some(comment => comment.type === "comment" && comment.author_type === "agent")
          ? remoteJson(connection, `/api/agents?workspace_id=${encodeURIComponent(workspace.id)}&include_archived=true`, z.array(z.object({ id: z.string(), name: z.string() })), workspace) : [],
      ]) as [Array<{ user_id: string; name: string }>, Array<{ id: string; name: string }>];
      const newRows: StoredRow[] = [];
      // A WS invalidation can beat the HTTP receipt. Wait for active POSTs so
      // their source IDs can reconcile the host's optimistic input safely.
      await this.waitForDeliveries();
      await this.store.update(state => {
        const issue = state.connections[address.connectionKey].issues[address.issueId];
        const thread = projectionHistory(issue, address.rootId);
        const append = (row: StoredRow) => { if (!thread.rows.some(existing => existing.id === row.id)) { thread.rows.push(row); newRows.push(row); } };
        const sorted = [...comments.values()].sort((a, b) => (a.created_at ?? "").localeCompare(b.created_at ?? "") || a.id.localeCompare(b.id));
        // A parent's reply can share its timestamp; order ancestors before their descendants.
        const ordered: Comment[] = [];
        const visited = new Set<string>();
        for (const comment of sorted) {
          const ancestors: Comment[] = [];
          let current: Comment | undefined = comment;
          while (current && !visited.has(current.id)) { ancestors.push(current); current = current.parent_id ? comments.get(current.parent_id) : undefined; }
          for (const ancestor of ancestors.reverse()) { visited.add(ancestor.id); ordered.push(ancestor); }
        }
        for (const comment of ordered) {
          const previous = thread.observed[comment.id];
          if (previous?.revision !== undefined && comment.revision !== undefined && comment.revision < previous.revision) continue;
          const deleted = !!comment.deleted_at;
          const text = body(comment, connection.apiUrl);
          const fingerprint = hash([comment.content, comment.type, comment.author_id, comment.author_type, comment.attachments ?? [], deleted]);
          if (previous?.fingerprint === fingerprint && previous.deleted === deleted) continue;
          const source = { commentId: comment.id, sourceCreatedAt: comment.created_at, sourceUpdatedAt: comment.updated_at };
          if (deleted || previous) {
            const category = deleted ? "deletion" : "correction";
            const revision = comment.revision ?? hash([fingerprint, comment.updated_at]);
            append({ ...source, id: `multica:${category}:${comment.id}:${revision}`, role: "event", category, text: deleted ? "此评论已在 Multica 删除；保留先前读到的原始记录（如有）。" : text });
          } else if (comment.author_type === "system" || comment.type !== "comment") {
            append({ ...source, id: `multica:comment:${comment.id}`, role: "event", category: "system", text });
          } else {
            const own = comment.author_type === "member" && comment.author_id === connection.userId;
            const outgoing = own ? Object.values(issue.deliveries).find(record => record.rootId === address.rootId && record.commentId === comment.id) : undefined;
            // Unknown receipts cannot be identified by body alone. Keep a
            // potentially matching echo unprojected until receipt recovery.
            if (own && !outgoing && Object.values(issue.deliveries).some(record => record.rootId === address.rootId && record.claimedAt && (record.status === "received" || record.status === "pending_verification") && record.body === comment.content)) continue;
            const name = comment.author_type === "member" ? members.find(member => member.user_id === comment.author_id)?.name ?? `成员 ${comment.author_id}`
              : agents.find(agent => agent.id === comment.author_id)?.name ?? `Agent ${comment.author_id}`;
            append({ ...source, id: `multica:comment:${comment.id}`, role: own ? "user" : "assistant", text: own ? text : `${name}: \n\n${text}`, ...(outgoing ? { clientMessageId: outgoing.clientMessageId } : {}) });
          }
          thread.observed[comment.id] = { fingerprint, deleted, revision: comment.revision, updatedAt: comment.updated_at };
        }
        for (const [commentId, previous] of Object.entries(thread.observed)) {
          if (comments.has(commentId) || previous.deleted) continue;
          append({ id: `multica:deletion:${commentId}:missing`, commentId, role: "event", category: "deletion", text: "此评论已不在完整远端快照中；保留先前读到的原始记录。" });
          previous.deleted = true;
        }
        thread.historyLoaded = true;
      });
      for (const row of newRows) for (const listener of this.listeners.get(id) ?? []) listener.deliver(row);
      if (discoverCards) await this.askusers.discover(connection, workspace, address.issueId, [...comments.values()], roots, address.rootId);
    });
    this.pending.set(id, operation);
    return operation.finally(() => { if (this.pending.get(id) === operation) this.pending.delete(id); });
  }
  async close() { this.opened.clear(); this.listeners.clear(); await Promise.allSettled(this.pending.values()); }
}
