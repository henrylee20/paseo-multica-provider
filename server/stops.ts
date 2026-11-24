import { randomUUID } from "node:crypto";
import { z } from "zod";
import { runStatusSchema } from "../shared/runs.js";
import { remoteFetch, type AuthenticatedConnection } from "./connection.js";
import { isActiveRun, type RunAddress, type RunSynchronizer } from "./runs.js";
import { StateStore, type LocalState } from "./state.js";
import { remoteJson, workspaceSchema, type RemoteWorkspace } from "./sync.js";

const cancelledRunSchema = z.object({ id: z.string(), issue_id: z.string(), status: runStatusSchema,
  completed_at: z.string().nullish(), failure_reason: z.string().nullish(),
  result: z.unknown().optional(),
});

/** Native interrupt is the sole automatic cancellation boundary. */
export class StopCoordinator {
  private readonly inFlight = new Set<Promise<void>>();
  constructor(private readonly store: StateStore, private readonly connection: () => Promise<AuthenticatedConnection>, private readonly runs: RunSynchronizer) {}

  async epoch(address: RunAddress): Promise<number> {
    const issue = (await this.store.read()).connections[address.connectionKey]?.issues[address.issueId];
    if (!issue) throw new Error("Discussion unavailable");
    return issue.stopEpochs[address.rootId] ?? 0;
  }
  /** Future delivery workers must claim durable work through this fence before POST. */
  guardDelivery(address: RunAddress, epoch: number, change: (state: LocalState) => void): Promise<void> {
    return this.store.update(state => {
      const issue = state.connections[address.connectionKey]?.issues[address.issueId];
      if (!issue || (issue.stopEpochs[address.rootId] ?? 0) !== epoch) throw new Error("Delivery was stopped");
      change(state);
    });
  }
  private track(operation: () => Promise<void>) {
    const result = operation();
    this.inFlight.add(result);
    void result.finally(() => this.inFlight.delete(result)).catch(() => {});
    return result;
  }
  interrupt(address: RunAddress): Promise<void> { return this.track(() => this.performInterrupt(address)); }
  private async performInterrupt(address: RunAddress): Promise<void> {
    const stopId = randomUUID();
    const runIds: string[] = [];
    // Snapshot and fence advance are one durable transaction, before any network wait.
    await this.store.update(state => {
      const issue = state.connections[address.connectionKey]?.issues[address.issueId];
      if (!issue) throw new Error("Discussion unavailable");
      const epoch = (issue.stopEpochs[address.rootId] ?? 0) + 1;
      issue.stopEpochs[address.rootId] = epoch;
      for (const [runId, run] of Object.entries(issue.runs)) if (run.ownerRootId === address.rootId && isActiveRun(run.status)) {
        runIds.push(runId);
        issue.stopRecords[runId] = { rootId: address.rootId, stopId, epoch, attemptedAt: new Date().toISOString(), status: run.status,
          cleanup: "unknown", retryable: true, message: "停止结果尚未确认，请重试核对。" };
      }
    });
    await this.cancel(address, runIds, stopId);
  }
  async list() {
    const state = await this.store.read();
    return { records: Object.entries(state.connections).flatMap(([connectionKey, connection]) =>
      Object.entries(connection.issues).flatMap(([issueId, issue]) => Object.entries(issue.stopRecords).map(([runId, record]) => ({
        connectionKey, issueId, runId, rootId: record.rootId, title: `${issue.title} · ${record.rootId === "main" ? "主讨论" : issue.threads[record.rootId]?.title ?? record.rootId}`,
        status: record.status, cleanup: record.cleanup, retryable: record.retryable, message: record.message,
      })))) };
  }
  retry(address: RunAddress & { runId: string }): Promise<void> {
    return this.track(async () => {
      const record = (await this.store.read()).connections[address.connectionKey]?.issues[address.issueId]?.stopRecords[address.runId];
      if (!record || record.rootId !== address.rootId) throw new Error("停止记录不可用。");
      if (!record.retryable) return;
      await this.cancel(address, [address.runId], record.stopId);
    });
  }
  async close() { await Promise.allSettled([...this.inFlight]); }
  private async cancel(address: RunAddress, runIds: string[], stopId: string) {
    if (!runIds.length) return;
    let connection: AuthenticatedConnection;
    let workspace: RemoteWorkspace;
    try {
      connection = await this.connection();
      if (connection.connectionKey !== address.connectionKey) throw new Error("请先切换回此停止记录所属的 Multica 连接。");
      const issue = (await this.store.read()).connections[address.connectionKey].issues[address.issueId];
      const workspaces = await remoteJson(connection, "/api/workspaces", z.array(workspaceSchema)) as RemoteWorkspace[];
      const found = workspaces.find(item => item.id === issue.remoteWorkspaceId);
      if (!found) throw new Error("Multica 工作区不可用。");
      workspace = found;
    } catch {
      throw new Error("无法连接此停止记录所属的 Multica 连接；未停止项已保留，可在管理页重试。");
    }
    let failed = false;
    for (const runId of runIds) {
      try {
        const response = await remoteFetch(connection, `/api/issues/${encodeURIComponent(address.issueId)}/tasks/${encodeURIComponent(runId)}/cancel`, {
          method: "POST", headers: { "X-Workspace-Slug": workspace.slug },
        });
        if (!response.ok) { await response.body?.cancel(); throw new Error(`HTTP ${response.status}`); }
        const result = cancelledRunSchema.parse(await response.json());
        if (result.id !== runId || result.issue_id !== address.issueId) throw new Error("Invalid cancellation response");
        const retryable = isActiveRun(result.status);
        failed ||= retryable;
        const evidence = result.result && typeof result.result === "object" && !Array.isArray(result.result) ? result.result as Record<string, unknown> : {};
        const cleanup = result.failure_reason === "process_cleanup_unconfirmed" ? "unconfirmed"
          : evidence.process_cleanup_pending === true ? "pending"
          : evidence.process_cleanup_confirmed === true ? "confirmed" : "unknown";
        await this.store.update(state => {
          const issue = state.connections[address.connectionKey].issues[address.issueId];
          if (issue.stopRecords[runId]?.stopId !== stopId) return;
          Object.assign(issue.stopRecords[runId], { status: result.status, cleanup, retryable,
            message: retryable ? "服务器仍报告未结束状态，请重试。" : undefined });
          // Persist the receipt and its native activity projection together.
          const run = issue.runs[runId];
          if (run?.ownerRootId === address.rootId && (isActiveRun(run.status) || !isActiveRun(result.status))) {
            run.status = result.status;
            if (result.completed_at) run.completedAt = result.completed_at;
          }
        });
        await this.runs.observe(address);
      } catch {
        failed = true;
        await this.store.update(state => {
          const record = state.connections[address.connectionKey].issues[address.issueId].stopRecords[runId];
          if (record?.stopId === stopId) { record.retryable = true; record.message = "取消请求失败或结果未知，请重试核对。"; }
        });
      }
    }
    if (failed) throw new Error("部分 Run 未确认停止；请在管理页重试未停止项。");
  }
}
