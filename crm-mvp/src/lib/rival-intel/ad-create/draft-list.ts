export interface DraftWithDomainCreatedAt {
  domain: string;
  created_at: Date;
}

export function selectRecentDistinctDomainDrafts<T extends DraftWithDomainCreatedAt>(
  drafts: T[],
  limit: number,
): T[] {
  const seenDomains = new Set<string>();
  const selected: T[] = [];

  for (const draft of [...drafts].sort((a, b) => b.created_at.getTime() - a.created_at.getTime())) {
    const domainKey = draft.domain.trim().toLowerCase();
    if (seenDomains.has(domainKey)) continue;

    seenDomains.add(domainKey);
    selected.push(draft);
    if (selected.length >= limit) break;
  }

  return selected;
}
