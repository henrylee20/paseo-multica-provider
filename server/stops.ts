import { z } from "zod";
import { runMetadataSchema, runStatusSchema } from "../shared/runs.js";
import { remoteFetch, type AuthenticatedConnection } from "./connection.js";
import { isActiveRun, type RunAddress, type RunSynchronizer } from "./runs.js";
import { StateStore, cachedWorkspace } from "./state.js";

const cancelledRunSchema = z.object({ id: z.string(), issue_id: z.string(), status: runStatusSchema,
  ...runMetadataSchema.shape, completed_at: z.string().nullish(),
});

/** Native interrupt is the sole automatic cancellation boundary. */
export class StopCoordinator {
  private readonly inFlight = new Set<Promise<void>>();
  constructor(private readonly store: StateStore, private readonly connection: () => Promise<AuthenticatedConnection>, private readonly runs: RunSynchronizer) {}

  interrupt(address: RunAddress): Promise<void> {
    const operation = this.cancel(address);
    this.inFlight.add(operation);
    void operation.finally(() => this.inFlight.delete(operation)).catch(() => {});
    return operation;
  }
  async close() { await Promise.allSettled(this.inFlight); }
  private async cancel(address: RunAddress) {
    const issue = (await this.store.read()).connections[address.connectionKey]?.issues[address.issueId];
    if (!issue) throw new Error("Discussion unavailable");
    const runIds = Object.entries(issue.runs).filter(([, run]) => run.ownerRootId === address.rootId && isActiveRun(run.status)).map(([id]) => id);
    if (!runIds.length) return;
    const connection = await this.connection();
    if (connection.connectionKey !== address.connectionKey) throw new Error("请切回此讨论所属的 Multica 连接后重试停止。");
    const workspace = cachedWorkspace(await this.store.read(), address.connectionKey, issue);
    let failure: unknown;
    for (const runId of runIds) {
      try {
        const response = await remoteFetch(connection, `/api/issues/${encodeURIComponent(address.issueId)}/tasks/${encodeURIComponent(runId)}/cancel`, {
          method: "POST", headers: { "X-Workspace-Slug": workspace.slug },
        });
        if (!response.ok) { await response.body?.cancel(); throw new Error(`HTTP ${response.status}`); }
        const result = cancelledRunSchema.parse(await response.json());
        if (result.id !== runId || result.issue_id !== address.issueId) throw new Error("Invalid cancellation response");
        await this.store.update(state => {
          const issue = state.connections[address.connectionKey].issues[address.issueId];
          const run = issue.runs[runId];
          if (run?.ownerRootId === address.rootId && (isActiveRun(run.status) || !isActiveRun(result.status))) {
            run.status = result.status;
            run.metadata = { ...run.metadata, ...runMetadataSchema.parse(result) };
            if (result.completed_at) run.completedAt = result.completed_at;
          }
        });
        await this.runs.observe(address);
        if (isActiveRun(result.status)) throw new Error("服务器仍报告 Run 未结束，请重试停止。");
      } catch (error) { failure = error; }
    }
    if (failure) throw failure;
  }
}
