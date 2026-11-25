import type { PaseoApi } from "@getpaseo/client";

/**
 * The Paseo 0.16+ API the composer's agent picker relies on: an agent directory that carries
 * metadata, and handles whose `setMetadata` merges a patch. `legacy` is a 0.15 host with neither.
 */
export function metadataHost(agents: readonly { id: string; labels: Record<string, string> }[], options: { pageSize?: number; repeatingCursor?: boolean; legacy?: boolean } = {}) {
  const stored = new Map<string, Record<string, string>>();
  const writes: Array<{ agentId: string; patch: Record<string, string> }> = [];
  const listings: Array<{ labels?: Record<string, string>; includeArchived?: boolean } | undefined> = [];
  const control = { failNextListing: false, holdWrites: undefined as Promise<void> | undefined };
  let attempts = 0;
  const setMetadata = async (agentId: string, patch: Record<string, string>) => {
    await control.holdWrites;
    writes.push({ agentId, patch });
    stored.set(agentId, { ...stored.get(agentId), ...patch });
  };
  const paseo = {
    hosts: { list: async () => ({ self: { serverId: "owning-daemon" } }) },
    agents: {
      list: async ({ filter, page }: { filter?: { labels?: Record<string, string>; includeArchived?: boolean }; page?: { cursor?: string } }) => {
        attempts++;
        if (control.failNextListing) { control.failNextListing = false; throw new Error("Plugin Paseo API is unavailable"); }
        listings.push(filter);
        const matching = agents.filter(agent => Object.entries(filter?.labels ?? {}).every(([key, value]) => agent.labels[key] === value));
        const offset = Number(page?.cursor ?? 0), end = Math.min(offset + (options.pageSize ?? matching.length), matching.length);
        const hasMore = end < matching.length;
        return { entries: matching.slice(offset, end).map(agent => ({ agent: { provider: "multica", ...agent, metadata: stored.get(agent.id) } })),
          pageInfo: { hasMore, nextCursor: hasMore ? String(options.repeatingCursor ? offset : end) : null } };
      },
      ref: (agentId: string) => (options.legacy ? {} : { setMetadata: (patch: Record<string, string>) => setMetadata(agentId, patch) }),
    },
  } as unknown as PaseoApi;
  return { paseo, writes, listings, stored, control, attempts: () => attempts };
}
