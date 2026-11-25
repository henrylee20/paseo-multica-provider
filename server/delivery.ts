import { createHash } from "node:crypto";
import { setTimeout } from "node:timers/promises";
import { z } from "zod";
import { remoteFetch, type AuthenticatedConnection } from "./connection.js";
import type { RunAddress } from "./runs.js";
import { StateStore } from "./state.js";
import { remoteJson, workspaceSchema, type RemoteWorkspace } from "./sync.js";
import type { DiscussionLifecycle } from "./discussion-lifecycle.js";
import { assertAskuserWritable } from "./askuser-policy.js";

const receiptSchema = z.object({ id: z.string(), issue_id: z.string(), parent_id: z.string().nullish(), askuser_answer_to: z.string().nullish(), content: z.string(), author_id: z.string() });

/** Ordinary comments use one key for a bounded retry; only successful echo IDs persist. */
export class CommentDelivery {
  private readonly posts = new Map<string, Promise<string>>();
  constructor(private readonly store: StateStore, private readonly connection: () => Promise<AuthenticatedConnection>, private readonly onSaved: () => Promise<void>, private readonly lifecycle?: DiscussionLifecycle) {}
  send(address: RunAddress, clientMessageId: string, body: string, target: { parent_id?: string; askuser_answer_to?: string } = {}): Promise<string> {
    const key = JSON.stringify([address.connectionKey, address.issueId, address.rootId, clientMessageId, target.parent_id, target.askuser_answer_to]);
    const pending = this.posts.get(key);
    if (pending) return pending;
    const operation = (async () => {
      const issue = (await this.store.read()).connections[address.connectionKey].issues[address.issueId];
      const connection = await this.connection();
      if (connection.connectionKey !== address.connectionKey) throw new Error("登录身份已变化；请切回此讨论所属的 Multica 连接。");
      const saved = issue.commentInputs[clientMessageId];
      if (saved?.rootId === address.rootId) return saved.commentId;
      const workspace = (await remoteJson(connection, "/api/workspaces", z.array(workspaceSchema)) as RemoteWorkspace[]).find(item => item.id === issue.remoteWorkspaceId);
      if (!workspace) throw new Error("Multica 工作区不可用。");
      const idempotencyKey = createHash("sha256").update(key).digest("hex");
      for (let attempt = 0; attempt < 3; attempt++) {
        const current = (await this.store.read()).connections[address.connectionKey]?.issues[address.issueId];
        if (target.askuser_answer_to) assertAskuserWritable(current, address, this.lifecycle);
        let response: Response | undefined;
        try {
          response = await remoteFetch(connection, `/api/issues/${encodeURIComponent(address.issueId)}/comments`, {
            method: "POST", headers: { "Content-Type": "application/json", "X-Workspace-Slug": workspace.slug, "Idempotency-Key": idempotencyKey },
            body: JSON.stringify({ content: body, type: "comment", ...((target.parent_id ?? (address.rootId === "main" ? undefined : address.rootId)) ? { parent_id: target.parent_id ?? address.rootId } : {}), ...(target.askuser_answer_to ? { askuser_answer_to: target.askuser_answer_to } : {}) }),
          });
        } catch (error) { if (attempt === 2) throw error; }
        if (response?.ok) {
          const comment = receiptSchema.parse(await response.json());
          if (comment.issue_id !== address.issueId || (comment.parent_id ?? null) !== (target.parent_id ?? (address.rootId === "main" ? null : address.rootId)) || (comment.askuser_answer_to ?? null) !== (target.askuser_answer_to ?? null) || comment.content !== body || comment.author_id !== connection.userId) throw new Error("评论回执与原输入不匹配。");
          await this.store.update(state => { state.connections[address.connectionKey].issues[address.issueId].commentInputs[clientMessageId] = { commentId: comment.id, rootId: address.rootId }; });
          return comment.id;
        }
        if (response && (response.status < 500 || attempt === 2)) {
          const error = await response.json().catch(() => ({})) as { error?: string };
          throw new Error(error.error || `Multica comment failed (HTTP ${response.status})`);
        }
        await response?.body?.cancel();
        await setTimeout(100 * (attempt + 1));
      }
      throw new Error("评论发送失败，请重试。");
    })();
    this.posts.set(key, operation);
    void operation.finally(() => this.posts.delete(key)).then(() => this.onSaved()).catch(() => {});
    return operation;
  }
  async waitForPosts() { await Promise.allSettled(this.posts.values()); }
  async mentions(address: { connectionKey: string; issueId: string }) {
    const issue = (await this.store.read()).connections[address.connectionKey]?.issues[address.issueId];
    if (!issue) throw new Error("任务缓存不可用。");
    const connection = await this.connection();
    if (!issue || connection.connectionKey !== address.connectionKey) throw new Error("请连接此讨论的原 Multica 身份。");
    const workspaces = await remoteJson(connection, "/api/workspaces", z.array(workspaceSchema)) as z.infer<typeof workspaceSchema>[];
    const workspace = workspaces.find(workspace => workspace.id === issue.remoteWorkspaceId);
    if (!workspace) throw new Error("Multica 工作区不可用。");
    const agents = await remoteJson(connection, `/api/agents?workspace_id=${encodeURIComponent(workspace.id)}&include_archived=true`, z.array(z.object({ id: z.string(), name: z.string(), archived_at: z.string().nullish() })), workspace) as Array<{ id: string; name: string; archived_at?: string | null }>;
    return { agents: agents.filter(agent => !agent.archived_at && z.uuid().safeParse(agent.id).success).map(agent => ({ id: agent.id, name: agent.name, reference: `[@${agent.name.replace(/[\\\[\]]/g, "\\$&")}](mention://agent/${agent.id})` })) };
  }
  async close() { await this.waitForPosts(); }
}
