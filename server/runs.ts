import { z } from "zod";
import type { AuthenticatedConnection } from "./connection.js";
import { StateStore, type IssueMapping } from "./state.js";
import type { StoredRun } from "./run-state.js";
import { remoteJson, workspaceAgents, workspaceMembers, type RemoteWorkspace } from "./sync.js";
import { isActiveRun, runMetadataSchema, runStatusSchema } from "../shared/runs.js";

export type RunAddress = { connectionKey: string; issueId: string; rootId: string };
const key = (address: RunAddress) => JSON.stringify([address.connectionKey, address.issueId, address.rootId]);
const remoteRunSchema = z.object({
  ...runMetadataSchema.shape,
  id: z.string().min(1).max(256), issue_id: z.string().max(256), agent_id: z.string().max(256), status: runStatusSchema,
  trigger_comment_id: z.string().nullish(), coalesced_comment_ids: z.array(z.string()).nullish(),
  delivered_comment_ids: z.array(z.string()).nullish(), supplement_comment_ids: z.array(z.string()).nullish(),
  created_at: z.string().max(128).optional(), started_at: z.string().max(128).nullish(), completed_at: z.string().max(128).nullish(),
});

export function sourceTime(value: string | undefined): bigint | undefined {
  if (!value) return undefined;
  // RFC3339Nano source times can distinguish comments within one millisecond.
  const match = /^(.*T\d{2}:\d{2}:\d{2})(?:\.(\d{1,9}))?(Z|[+-]\d{2}:\d{2})$/.exec(value);
  if (!match) return undefined;
  const seconds = Date.parse(`${match[1]}${match[3]}`);
  if (!Number.isFinite(seconds)) return undefined;
  return BigInt(seconds) * 1_000_000n + BigInt((match[2] ?? "").padEnd(9, "0"));
}

function owner(issue: IssueMapping, run: z.infer<typeof remoteRunSchema>, generatedCommentIds: string[]): string | undefined {
  if (run.trigger_comment_id) return issue.commentRoots[run.trigger_comment_id];
  const associations = [...new Set([...(run.coalesced_comment_ids ?? []), ...(run.delivered_comment_ids ?? []), ...(run.supplement_comment_ids ?? []), ...generatedCommentIds])];
  if (!associations.length) return "main";
  if (associations.some(id => !issue.commentRoots[id])) return undefined;
  const roots = new Set(associations.map(id => issue.commentRoots[id]));
  if (roots.size === 1) return [...roots][0];
  const times = new Map(associations.map(id => [id, sourceTime(issue.commentCreatedAt[id])]));
  if (associations.some(id => times.get(id) === undefined)) return undefined;
  associations.sort((a, b) => times.get(a)! < times.get(b)! ? -1 : times.get(a)! > times.get(b)! ? 1 : a.localeCompare(b));
  return issue.commentRoots[associations[0]];
}

/** Fixed display ownership and activity projection. Never reads detailed run output. */
export class RunSynchronizer {
  private readonly listeners = new Map<string, Set<(runs: Record<string, StoredRun>) => void>>();
  constructor(private readonly store: StateStore) {}
  subscribe(address: RunAddress, listener: (runs: Record<string, StoredRun>) => void) {
    const id = key(address);
    const listeners = this.listeners.get(id) ?? new Set();
    listeners.add(listener); this.listeners.set(id, listeners);
    return () => { listeners.delete(listener); if (!listeners.size) this.listeners.delete(id); };
  }
  async discover(connection: AuthenticatedConnection, workspace: RemoteWorkspace, issueId: string) {
    const records = await remoteJson(connection, `/api/issues/${encodeURIComponent(issueId)}/task-runs?view=timeline`, z.array(remoteRunSchema), workspace) as Array<z.infer<typeof remoteRunSchema>>;
    if (records.some(run => run.issue_id !== issueId) || new Set(records.map(run => run.id)).size !== records.length)
      throw new Error("Invalid issue run snapshot");
    const agents = records.length ? await workspaceAgents(connection, workspace) : [];
    const snapshot = (await this.store.read()).connections[connection.connectionKey].issues[issueId];
    const source = (run: z.infer<typeof remoteRunSchema>) => run.trigger_comment_id ??
      [...(run.coalesced_comment_ids ?? []), ...(run.delivered_comment_ids ?? []), ...(run.supplement_comment_ids ?? [])]
        .sort((a, b) => {
          const first = sourceTime(snapshot.commentCreatedAt[a]) ?? 0n, second = sourceTime(snapshot.commentCreatedAt[b]) ?? 0n;
          return first < second ? -1 : first > second ? 1 : a.localeCompare(b);
        })[0];
    const generated = new Map<string, string[]>();
    for (const [commentId, runId] of Object.entries(snapshot.commentSourceTaskIds)) {
      const ids = generated.get(runId) ?? []; ids.push(commentId); generated.set(runId, ids);
    }
    const triggerAuthors = new Map(records.map(run => [run.id, snapshot.commentAuthors[source(run)]]));
    const members = records.some(run => {
      const author = triggerAuthors.get(run.id);
      return author?.type === "member" && author.id !== connection.userId;
    }) ? await workspaceMembers(connection, workspace) : [];

    await this.store.update(state => {
      const issue = state.connections[connection.connectionKey].issues[issueId];
      for (const run of records) {
        const previous = issue.runs[run.id];
        // A Run ID is one execution: a stale read must not reopen its terminal cycle.
        const staleActive = previous && !isActiveRun(previous.status) && isActiveRun(run.status);
        const generatedCommentIds = generated.get(run.id) ?? [];
        issue.runs[run.id] = { agentId: run.agent_id, agentName: agents.find(agent => agent.id === run.agent_id)?.name ?? `Agent ${run.agent_id}`,
          markerProjected: previous?.markerProjected,
          status: staleActive ? previous.status : run.status,
          triggerAuthor: (() => {
            const author = triggerAuthors.get(run.id);
            return author?.type === "member" ? members.find(member => member.user_id === author.id)?.name ?? (author.id === connection.userId ? connection.identity?.user.name || "我" : `成员 ${author.id}`)
              : author?.type === "system" ? "系统" : author ? agents.find(agent => agent.id === author.id)?.name ?? `Agent ${author.id}` : undefined;
          })(),
          ownerRootId: previous?.ownerRootId ?? owner(issue, run, generatedCommentIds), generatedCommentIds, triggerCommentId: run.trigger_comment_id,
          coalescedCommentIds: run.coalesced_comment_ids ?? [], deliveredCommentIds: run.delivered_comment_ids ?? undefined,
          supplementCommentIds: run.supplement_comment_ids ?? [],
          createdAt: run.created_at, startedAt: run.started_at ?? undefined, completedAt: staleActive ? previous.completedAt : run.completed_at ?? undefined,
          // Omission is no new evidence; explicit null/empty values are. A
          // stale active snapshot must not replace terminal failure metadata.
          metadata: staleActive ? previous.metadata : { ...previous?.metadata, ...runMetadataSchema.parse(run) } };
      }
    });
    const issue = (await this.store.read()).connections[connection.connectionKey].issues[issueId];
    for (const rootId of ["main", ...Object.keys(issue.threads)]) await this.observe({ connectionKey: connection.connectionKey, issueId, rootId });
  }
  async observe(address: RunAddress): Promise<void> {
    const issue = (await this.store.read()).connections[address.connectionKey]?.issues[address.issueId];
    if (!issue || (address.rootId !== "main" && !issue.threads[address.rootId])) return;
    const owned = Object.fromEntries(Object.entries(issue.runs).filter(([, run]) => run.ownerRootId === address.rootId));
    for (const listener of this.listeners.get(key(address)) ?? []) listener(owned);
  }
  close() { this.listeners.clear(); }
}
