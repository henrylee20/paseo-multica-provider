import { createHash } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import { isActiveRun, runMessageSchema } from "../shared/runs.js";
import type { RunAddress } from "./runs.js";
import type { AuthenticatedConnection } from "./connection.js";
import { StateStore, cachedWorkspace } from "./state.js";
import { remoteJson } from "./sync.js";

const detailSchema = z.object({ messages: z.array(runMessageSchema), finalized: z.boolean().optional() });
export type RunDetail = z.infer<typeof detailSchema>;

type Address = RunAddress & { runId: string };
const key = (address: RunAddress, runId?: string) => JSON.stringify([address.connectionKey, address.issueId, address.rootId, ...(runId === undefined ? [] : [runId])]);

/** Only discussions actually opened in this process refresh remote output. */
export class RunDetails {
  private readonly pending = new Map<string, Promise<void>>();
  private readonly details = new Map<string, RunDetail | undefined>();
  private readonly listeners = new Set<(address: RunAddress) => void>();
  subscribe(listener: (address: RunAddress) => void) { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; }
  get(address: RunAddress, runId: string) { return this.details.get(key(address, runId)); }
  private async load(address: Address) {
    const id = key(address, address.runId);
    if (this.details.has(id)) return;
    let detail: RunDetail | undefined;
    try {
      detail = detailSchema.parse(JSON.parse(await readFile(this.file(address), "utf8")));
      if (detail.messages.some(message => message.task_id !== address.runId || message.issue_id !== address.issueId)) throw new Error("Run message identity mismatch");
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    this.details.set(id, detail);
    for (const listener of this.listeners) listener(address);
  }
  private file(address: Address) {
    return join(this.store.runDetailsDirectory(address.connectionKey), createHash("sha256").update(address.runId).digest("hex") + ".json");
  }
  private readonly opened = new Map<string, RunAddress>();
  private readonly timer: ReturnType<typeof setInterval>;
  private paused = false;
  constructor(private readonly store: StateStore, private readonly connection: () => Promise<AuthenticatedConnection>) {
    this.timer = setInterval(() => { void this.refreshOpened().catch(() => {}); }, 2000);
    this.timer.unref?.();
  }
  async openDiscussion(address: RunAddress) {
    if (this.paused) return;
    const id = key(address);
    let operation = this.pending.get(id);
    if (!operation) {
      operation = (async () => {
        const issue = (await this.store.read()).connections[address.connectionKey]?.issues[address.issueId];
        await Promise.all(Object.entries(issue?.runs ?? {}).filter(([, run]) => run.ownerRootId === address.rootId)
          .map(([runId]) => this.load({ ...address, runId }).catch(() => {})));
        if (!this.paused) this.opened.set(id, address);
      })().finally(() => this.pending.delete(id));
      this.pending.set(id, operation);
    }
    await operation;
    void this.refreshOpened().catch(() => {});
  }
  async refreshOpened() {
    if (this.paused || !this.opened.size) return;
    const state = await this.store.read();
    if (this.paused) return;
    await Promise.all([...this.opened.values()].flatMap(address => {
      const issue = state.connections[address.connectionKey]?.issues[address.issueId];
      return Object.entries(issue?.runs ?? {}).filter(([, run]) => run.ownerRootId === address.rootId).map(async ([runId, run]) => {
        const target = { ...address, runId }, id = key(address, runId);
        let operation = this.pending.get(id);
        if (!operation) {
          operation = (async () => {
            await this.load(target);
            if (!isActiveRun(run.status) && this.get(address, runId)?.finalized) return;
            await this.refresh(target);
          })().finally(() => this.pending.delete(id));
          this.pending.set(id, operation);
        }
        await operation.catch(() => {}); // Keep the cache; retry unsuccessful terminal reads too.
      });
    }));
  }
  async pause() { this.paused = true; await Promise.allSettled(this.pending.values()); }
  resume(connectionKey?: string) {
    if (connectionKey) {
      for (const [id, address] of this.opened) if (address.connectionKey === connectionKey) this.opened.delete(id);
      for (const id of this.details.keys()) if (JSON.parse(id)[0] === connectionKey) this.details.delete(id);
    }
    this.paused = false;
  }
  private async cached(address: Address) {
    const issue = (await this.store.read()).connections[address.connectionKey]?.issues[address.issueId];
    if (!issue || issue.runs[address.runId]?.ownerRootId !== address.rootId) throw new Error("Run does not belong to this discussion");
    return { issue, cache: this.get(address, address.runId) };
  }
  private async refresh(address: Address) {
    const { issue, cache } = await this.cached(address);
    // Resolve the current CLI context; cached history cannot authorize another login.
    const connection = await this.connection();
    if (connection.connectionKey !== address.connectionKey) throw new Error("Connection identity changed");
    const workspace = cachedWorkspace(await this.store.read(), address.connectionKey, issue);
    const known = new Set(cache?.messages.map(message => message.seq));
    // Strict seq > since. Never advance across a missing sequence, including
    // the first message; old/partial sources are safe to reread in full.
    let contiguous = known.has(0) ? 0 : known.has(1) ? 1 : undefined;
    if (contiguous !== undefined) while (known.has(contiguous + 1)) contiguous++;
    const query = contiguous === undefined ? "" : `?since=${contiguous}`;
    const messages = await remoteJson(connection, `/api/tasks/${encodeURIComponent(address.runId)}/messages${query}`, z.array(runMessageSchema), workspace) as Array<z.infer<typeof runMessageSchema>>;
    if (messages.some(message => message.task_id !== address.runId || message.issue_id !== address.issueId)) throw new Error("Run message identity mismatch");
    const unique = new Map(cache?.messages.map(message => [message.seq, message]));
    for (const message of messages) if (!unique.has(message.seq)) unique.set(message.seq, message);
    const finalized = !isActiveRun(issue.runs[address.runId].status);
    if (cache && unique.size === cache.messages.length && (!finalized || cache.finalized)) return;
    const detail: RunDetail = { messages: [...unique.values()].sort((a, b) => a.seq - b.seq), ...(finalized ? { finalized: true } : {}) };
    await this.cached(address);
    if (this.paused) return;
    await mkdir(this.store.runDetailsDirectory(address.connectionKey), { recursive: true, mode: 0o700 });
    const file = this.file(address);
    await writeFile(file + ".next", JSON.stringify(detail), { mode: 0o600 });
    await rename(file + ".next", file);
    this.details.set(key(address, address.runId), detail);
    for (const listener of this.listeners) listener(address);
  }
  async reset() { await this.pause(); this.opened.clear(); this.details.clear(); this.resume(); }
  async close() { clearInterval(this.timer); await this.pause(); this.opened.clear(); this.details.clear(); }
}
