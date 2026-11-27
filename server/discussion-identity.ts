import { discussionKeys } from "../shared/discussion.js";

export const providerId = "multica";
export function mainPersistence(connectionKey: string, issueId: string) {
  return { version: 1, data: { connectionKey, issueId, discussion: "main" } } as const;
}
export function issueLabels(connectionKey: string, issueId: string) {
  return { [discussionKeys.connection]: connectionKey, [discussionKeys.issue]: issueId, [discussionKeys.discussion]: "main" };
}
export function threadPersistence(connectionKey: string, issueId: string, rootId: string) {
  return { version: 1, data: { connectionKey, issueId, discussion: "thread", rootId } } as const;
}
