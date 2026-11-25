import { z } from "zod";
import { isActiveRun, runMessageSchema } from "../shared/runs.js";
import type { RunAddress } from "./runs.js";
import type { AuthenticatedConnection } from "./connection.js";
import { StateStore, cachedWorkspace } from "./state.js";
import { remoteJson } from "./sync.js";

type Address = RunAddress & { runId: string };
const key = (address: Address) => JSON.stringify([address.connectionKey, address.issueId, address.rootId, address.runId]);

/** Only discussions actually opened in this process refresh remote output. */
export class RunDetails {
  private readonly pending = new Map<string, Promise<void>>();
  private readonly opened = new Map<string, RunAddress>();
  private readonly terminal = new Set<string>();
  private readonly timer: ReturnType<typeof setInterval>;
  private paused = false;
  constructor(private readonly store: StateStore, private readonly connection: () => Promise<AuthenticatedConnection>) {
    this.timer = setInterval(() => { void this.refreshOpened().catch(() => {}); }, 2000);
    this.timer.unref?.();
  }
  openDiscussion(address: RunAddress) {
    this.opened.set(JSON.stringify(address), address);
    void this.refreshOpened().catch(() => {});
  }
  async refreshOpened() {
    if (this.paused || !this.opened.size) return;
    const state = await this.store.read();
    if (this.paused) return;
    await Promise.all([...this.opened.values()].flatMap(address => {
      const issue = state.connections[address.connectionKey]?.issues[address.issueId];
      return Object.entries(issue?.runs ?? {}).filter(([, run]) => run.ownerRootId === address.rootId).map(async ([runId, run]) => {
        const target = { ...address, runId }, id = key(target);
        if (this.terminal.has(id)) return;
        let operation = this.pending.get(id);
        if (!operation) {
          operation = this.refresh(target).then(() => { if (!isActiveRun(run.status)) this.terminal.add(id); }).finally(() => this.pending.delete(id));
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
      for (const id of this.terminal) if (JSON.parse(id)[0] === connectionKey) this.terminal.delete(id);
    }
    this.paused = false;
  }
  private async cached(address: Address) {
    const issue = (await this.store.read()).connections[address.connectionKey]?.issues[address.issueId];
    if (!issue || issue.runs[address.runId]?.ownerRootId !== address.rootId) throw new Error("Run does not belong to this discussion");
    return { issue, cache: issue.runDetails[address.runId] };
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
    if (cache && unique.size === cache.messages.length) return;
    await this.store.update(state => {
      state.connections[address.connectionKey].issues[address.issueId].runDetails[address.runId] = { messages: [...unique.values()].sort((a, b) => a.seq - b.seq) };
    });
  }
  async close() { clearInterval(this.timer); await this.pause(); this.opened.clear(); }
}
