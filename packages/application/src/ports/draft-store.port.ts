/**
 * Ephemeral key-value store for resume-import drafts (task 023). A draft is
 * NOT domain state — it's a proposal awaiting human confirmation (ADR-003
 * posture applied to import: "never silently commit"). It doesn't belong in
 * Postgres as a durable aggregate; a TTL'd Redis entry is the honest
 * lifetime for something that either gets confirmed into a real
 * `CareerProfile` within a session or expires unused.
 */
export interface DraftStorePort {
  set(key: string, value: unknown, ttlSeconds: number): Promise<void>;
  get<T>(key: string): Promise<T | null>;
  delete(key: string): Promise<void>;
}
