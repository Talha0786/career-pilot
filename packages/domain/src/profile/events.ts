/**
 * Task 035: the embedding pipeline needs ONE stable event to subscribe to
 * that fires whenever a CareerProfile's `factsHash` may have changed —
 * distinct from the finer-grained `profile.section_added` /
 * `profile.section_updated` / `profile.section_removed` events (task 019),
 * which describe WHAT changed for audit/UI purposes but aren't a
 * convenient single subscription point for "go re-embed this profile".
 * Mirrors `discovery/events.ts`'s `DISCOVERY_EVENTS` shape.
 */
export const PROFILE_EVENTS = {
  FACTS_CHANGED: 'profile.facts_changed',
} as const;

export type ProfileEventType = (typeof PROFILE_EVENTS)[keyof typeof PROFILE_EVENTS];
