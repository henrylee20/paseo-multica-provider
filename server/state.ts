import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import { storedRunSchema } from "./run-state.js";
import { runMessageSchema } from "../shared/runs.js";
import { stopRecordSchema } from "./stop-state.js";
import { threadSchema } from "./thread-state.js";
import { deliveryRecordSchema } from "./delivery-state.js";
import { connectionIdentitySchema, taskRuleSchema } from "../shared/contracts.js";
import { askuserAttachmentSchema, storedAskuserCardSchema } from "./askuser-state.js";
import { issueAccessSchema } from "../shared/access.js";

const projectSchema = z.object({ cwd: z.string(), name: z.string(), projectId: z.string().optional(), removed: z.boolean().optional() });
const issueSchema = z.object({
  remoteWorkspaceId: z.string(), workspaceId: z.string(), cwd: z.string(), title: z.string(),
  projectId: z.string().optional(),
  description: z.string(), updatedAt: z.string().optional(), workspaceCreated: z.boolean().default(false), mainAgentId: z.string().optional(),
  access: issueAccessSchema.optional(),
  archiveReason: z.enum(["rule_disabled", "filter_exit", "inaccessible"]).optional(), ruleArchivedAgentIds: z.array(z.string()).default([]), archivePending: z.boolean().default(false),
  manualHidden: z.object({ workspace: z.boolean(), discussions: z.array(z.string()) }).default({ workspace: false, discussions: [] }),
  threads: z.record(z.string(), threadSchema).default({}),
  runs: z.record(z.string(), storedRunSchema).default({}),
  runDetails: z.record(z.string(), z.object({ messages: z.array(runMessageSchema) })).default({}),
  stopEpochs: z.record(z.string(), z.number().int().nonnegative()).default({}),
  stopRecords: z.record(z.string(), stopRecordSchema).default({}),
  askuserAttachments: z.record(z.string(), askuserAttachmentSchema).optional(),
  askuserCards: z.record(z.string(), storedAskuserCardSchema).optional(),
  deliveries: z.record(z.string(), deliveryRecordSchema).default({}),
  commentSourceTaskIds: z.record(z.string(), z.string()).default({}),
  commentCreatedAt: z.record(z.string(), z.string()).default({}),
  commentRoots: z.record(z.string(), z.string()).default({}),
  unresolvedCommentIds: z.array(z.string()).default([]),
  systemRootIds: z.array(z.string()).default([]),
  mainHistory: threadSchema.default({ title: "主讨论", historyLoaded: false, rows: [], observed: {} }),
});
const connectionSchema = z.object({
  identity: connectionIdentitySchema.optional(),
  rules: z.record(z.string(), taskRuleSchema.extend({ enabled: z.boolean() })),
  projects: z.record(z.string(), projectSchema), issues: z.record(z.string(), issueSchema),
});
const stateSchema = z.object({ version: z.literal(1), connections: z.record(z.string(), connectionSchema) });
export type LocalState = z.infer<typeof stateSchema>;
export type ConnectionState = z.infer<typeof connectionSchema>;
export type IssueMapping = z.infer<typeof issueSchema>;

/** Atomic, daemon-only state. Credentials are deliberately absent from its schema. */
export class StateStore {
  private pending: Promise<unknown> = Promise.resolve();
  constructor(readonly directory: string) {}
  async read(): Promise<LocalState> {
    await this.pending;
    return this.load();
  }
  private async load(): Promise<LocalState> {
    try { return stateSchema.parse(JSON.parse(await readFile(join(this.directory, "state.json"), "utf8"))); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return { version: 1, connections: {} }; throw error; }
  }
  update(change: (state: LocalState) => void): Promise<void> {
    const operation = this.pending.then(async () => {
      const state = await this.load();
      change(state);
      const validated = stateSchema.parse(state);
      await mkdir(this.directory, { recursive: true, mode: 0o700 });
      const temporary = join(this.directory, "state.json.next");
      await writeFile(temporary, JSON.stringify(validated), { mode: 0o600 });
      await rename(temporary, join(this.directory, "state.json"));
    });
    this.pending = operation.catch(() => {});
    return operation;
  }
}

export function connectionState(state: LocalState, key: string): ConnectionState {
  return state.connections[key] ??= { rules: {}, projects: {}, issues: {} };
}
