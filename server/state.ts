import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { z } from "zod";
import { storedRunSchema } from "./run-state.js";
import { threadSchema } from "./thread-state.js";
import { taskRuleSchema } from "../shared/contracts.js";
import { askuserAttachmentSchema, storedAskuserCardSchema } from "./askuser-state.js";

const projectSchema = z.object({ cwd: z.string(), name: z.string(), appliedName: z.string().optional(), slug: z.string().optional(), projectId: z.string().optional(), removed: z.boolean().optional() });
export const issueSchema = z.object({
  remoteWorkspaceId: z.string(), workspaceId: z.string(), cwd: z.string(), title: z.string(),
  projectId: z.string().optional(), appliedTitle: z.string().optional(),
  description: z.string(), updatedAt: z.string().optional(), workspaceCreated: z.boolean().default(false), mainAgentId: z.string().optional(),
  // "inaccessible" is accepted only so states written before OPT-08 remain readable.
  archiveReason: z.enum(["rule_disabled", "filter_exit", "inaccessible"]).optional(), ruleArchivedAgentIds: z.array(z.string()).default([]),
  manualHidden: z.object({ workspace: z.boolean(), discussions: z.array(z.string()) }).default({ workspace: false, discussions: [] }),
  threads: z.record(z.string(), threadSchema).default({}),
  runs: z.record(z.string(), storedRunSchema).default({}),
  askuserAttachments: z.record(z.string(), askuserAttachmentSchema).optional(),
  askuserCards: z.record(z.string(), storedAskuserCardSchema).optional(),
  commentInputs: z.record(z.string(), z.object({ commentId: z.string(), rootId: z.string() })).default({}),
  commentSourceTaskIds: z.record(z.string(), z.string()).default({}),
  commentAuthors: z.record(z.string(), z.object({ id: z.string(), type: z.enum(["member", "agent", "system"]) })).default({}),
  commentCreatedAt: z.record(z.string(), z.string()).default({}),
  commentRoots: z.record(z.string(), z.string()).default({}),
  unresolvedCommentIds: z.array(z.string()).default([]),
  systemRootIds: z.array(z.string()).default([]),
  mainHistory: threadSchema.default({ title: "主讨论", historyLoaded: false, rows: [], observed: {} }),
});
const connectionSchema = z.object({
  rebuildGeneration: z.number().int().nonnegative().optional(),
  rules: z.record(z.string(), taskRuleSchema.extend({ enabled: z.boolean() })),
  projects: z.record(z.string(), projectSchema), issues: z.record(z.string(), issueSchema),
});
const stateSchema = z.object({ version: z.literal(1), owner: z.object({ profile: z.string() }).optional(), connections: z.record(z.string(), connectionSchema) });
export type LocalState = z.infer<typeof stateSchema>;
export type ConnectionState = z.infer<typeof connectionSchema>;
export type IssueMapping = z.infer<typeof issueSchema>;

/** Atomic, daemon-only state. Credentials are deliberately absent from its schema. */
export class StateStore {
  private pending: Promise<unknown> = Promise.resolve();
  private readonly listeners = new Set<(state: LocalState) => void>();
  subscribe(listener: (state: LocalState) => void) { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; }
  private cached?: Promise<LocalState>;
  private profile?: string;
  constructor(readonly directory: string) {}
  runDetailsDirectory(connectionKey: string) {
    return join(this.directory, "run-details", createHash("sha256").update(connectionKey).digest("hex"));
  }
  async removeRunDetails(connectionKey: string) {
    await rm(this.runDetailsDirectory(connectionKey), { recursive: true, force: true });
  }
  /** Legacy data acquires an owner on first observation, without creating an empty file. */
  async observeProfile(profile: string | undefined) {
    this.profile = profile;
    if (profile === undefined) return;
    const state = await this.read();
    if (!state.owner && Object.keys(state.connections).length) await this.update(state => { state.owner ??= { profile }; });
  }
  /** Shared read-only snapshot; all changes must go through update(). */
  async read(): Promise<LocalState> {
    await this.pending;
    return this.cached ??= this.load();
  }
  private async load(): Promise<LocalState> {
    try { return stateSchema.parse(JSON.parse(await readFile(join(this.directory, "state.json"), "utf8"))); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return { version: 1, connections: {} };
      this.cached = undefined;
      throw error;
    }
  }
  update(change: (state: LocalState) => void): Promise<void> {
    const profile = this.profile;
    const operation = this.pending.then(async () => {
      const previous = await (this.cached ??= this.load());
      const state = structuredClone(previous);
      change(state);
      if (profile !== undefined) state.owner ??= { profile };
      const validated = stateSchema.parse(state);
      if (isDeepStrictEqual(previous, validated)) return;
      await mkdir(this.directory, { recursive: true, mode: 0o700 });
      const temporary = join(this.directory, "state.json.next");
      await writeFile(temporary, JSON.stringify(validated), { mode: 0o600 });
      await rename(temporary, join(this.directory, "state.json"));
      this.cached = Promise.resolve(validated);
      for (const listener of this.listeners) listener(validated);
    });
    this.pending = operation.catch(() => {});
    return operation;
  }
}

export function connectionState(state: LocalState, key: string): ConnectionState {
  return state.connections[key] ??= { rules: {}, projects: {}, issues: {} };
}

export function cachedWorkspace(state: LocalState, connectionKey: string, issue: IssueMapping) {
  const project = state.connections[connectionKey]?.projects[issue.remoteWorkspaceId];
  if (!project?.slug) throw new Error("Multica 工作区不可用。");
  return { id: issue.remoteWorkspaceId, name: project.name, slug: project.slug };
}
