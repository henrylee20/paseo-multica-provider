import type { IssueMapping } from "./state.js";
import type { DiscussionLifecycle } from "./discussion-lifecycle.js";

/** Askuser actions have stricter local availability than ordinary comments. */
export function askuserUnavailableReason(issue: IssueMapping | undefined, rootId: string, lifecycle?: DiscussionLifecycle, connectionKey?: string, issueId?: string) {
  if (!issue) return "提问卡片缓存不可用。";
  if (issue.archiveReason || issue.manualHidden.workspace || issue.manualHidden.discussions.includes(rootId)
    || connectionKey && issueId && lifecycle?.unavailable({ connectionKey, issueId, rootId })) return "讨论已归档或正在归档，仅显示缓存。";
  return undefined;
}
export function assertAskuserWritable(issue: IssueMapping | undefined, address: { connectionKey: string; issueId: string; rootId: string }, lifecycle?: DiscussionLifecycle) {
  const reason = askuserUnavailableReason(issue, address.rootId, lifecycle, address.connectionKey, address.issueId);
  if (reason) throw new Error(reason);
}
