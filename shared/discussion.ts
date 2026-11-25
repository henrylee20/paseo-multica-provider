/**
 * Label keys naming the Multica discussion an agent tab projects. The daemon copies the task keys
 * into agent metadata, which is the only per-agent data a composer exposes to a plugin.
 */
export const discussionKeys = {
  connection: "multica.connection",
  issue: "multica.issue",
  discussion: "multica.discussion",
} as const;
