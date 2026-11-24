import type { TaskRule } from "../shared/contracts.js";

/** Normal paged endpoint: AND across fields; each comma-separated value is OR. */
export function issueQuery(rule: TaskRule, offset: number) {
  const query = new URLSearchParams({ limit: "100", offset: String(offset) });
  const fields = { status_categories: rule.statusCategories, statuses: rule.statuses,
    assignee_filters: rule.assignees.map(actor => `${actor.type}:${actor.id}`), project_ids: rule.projectIds, label_ids: rule.labelIds };
  for (const [name, values] of Object.entries(fields)) if (values.length) query.set(name, [...new Set(values)].join(","));
  return query;
}
