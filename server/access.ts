import { createHash } from "node:crypto";
import { StateStore, type IssueMapping } from "./state.js";

export function assertWritableIssue(issue: IssueMapping | undefined): asserts issue is IssueMapping {
  if (!issue) throw new Error("任务缓存不可用。");
  if (issue.access?.status === "inaccessible") throw new Error("此任务已不可访问；仅可读取保留的历史，不会发送远端请求。");
}

function snapshot(issue: IssueMapping) {
  return JSON.stringify({ title: issue.title, description: issue.description,
    discussions: [{ rootId: "main", ...issue.mainHistory }, ...Object.entries(issue.threads).map(([rootId, thread]) => ({ rootId, ...thread }))],
    runs: Object.entries(issue.runs).map(([id, run]) => ({ id, ...run, messages: issue.runDetails[id]?.messages })),
    deliveries: Object.values(issue.deliveries), stops: Object.entries(issue.stopRecords).map(([runId, record]) => ({ runId, ...record })),
  });
}
const revision = (text: string) => createHash("sha256").update(text).digest("hex");

/** Host-authenticated cache reads never resolve CLI credentials or restore native work. */
export class IssueHistory {
  constructor(private readonly store: StateStore) {}
  async list() {
    return { issues: Object.entries((await this.store.read()).connections).flatMap(([connectionKey, connection]) =>
      Object.entries(connection.issues).map(([issueId, issue]) => ({ connectionKey, issueId, title: issue.title, workspaceId: issue.workspaceId,
        status: "available" as const, ...issue.access, revision: revision(snapshot(issue)) }))) };
  }
  async read(address: { connectionKey: string; issueId: string; revision: string; offset: number }) {
    const issue = (await this.store.read()).connections[address.connectionKey]?.issues[address.issueId];
    if (!issue) throw new Error("任务缓存不可用。");
    const text = snapshot(issue);
    if (revision(text) !== address.revision || address.offset > text.length) throw new Error("缓存已更新，请重新打开历史。");
    const end = Math.min(text.length, address.offset + 8192);
    return { text: text.slice(address.offset, end), nextOffset: end < text.length ? end : null };
  }
}
