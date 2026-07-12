import type { DedupCandidate } from '../ports/repositories.js';

/**
 * Cross-source dedup (task 029, design §2). Pure functions, zero I/O — the
 * ingestion use case (`ingest-job-batch.ts`) supplies the candidate pool
 * (from `JobPostingRepository.listDedupCandidatesForUser`) and applies the
 * decision.
 *
 * Two layers, exact first:
 *   1. Exact — same `urlHash` as an existing posting for this user.
 *   2. Fuzzy — same normalized company AND high title-token overlap. This
 *      is what makes a Class B/C job dedup against the same job from a
 *      Class A source (design §2 / roadmap acceptance): two connectors
 *      publishing the SAME real-world posting essentially always agree on
 *      company name and most of the title's meaningful words, even when
 *      URLs/formatting/whitespace differ completely.
 *
 * Deliberately NOT embedding-similarity (design §2 mentions embedding
 * similarity as one option) — embeddings are computed asynchronously after
 * ingestion (M2's existing pipeline), so they don't exist yet at the moment
 * a batch is being deduped synchronously. Trigram-style token overlap on
 * title+company (also named in design §2) is the same idea without that
 * ordering dependency, and it's what's implemented here.
 */

export interface DedupInput {
  readonly urlHash: string | null;
  readonly title: string;
  readonly company: string | null;
}

export type DedupDecision =
  | { readonly kind: 'exact'; readonly matchId: string; readonly groupId: string }
  | { readonly kind: 'fuzzy'; readonly matchId: string; readonly groupId: string; readonly score: number }
  | { readonly kind: 'unique' };

/**
 * Tuned for HIGH PRECISION over high recall (task 029 acceptance: "dedup
 * precision ≥98%, measured") — company must match and title token overlap
 * must be substantial. Missing a real duplicate (lower recall) is an
 * acceptable cost; wrongly merging two different postings is not.
 */
const FUZZY_TITLE_THRESHOLD = 0.7;

export function findDedupMatch(input: DedupInput, candidates: readonly DedupCandidate[]): DedupDecision {
  if (input.urlHash) {
    const exact = candidates.find((c) => c.urlHash !== null && c.urlHash === input.urlHash);
    if (exact) return { kind: 'exact', matchId: exact.id, groupId: exact.dedupGroupId ?? exact.id };
  }

  let best: { candidate: DedupCandidate; score: number } | null = null;
  for (const candidate of candidates) {
    const score = fuzzyScore(input, candidate);
    if (score >= FUZZY_TITLE_THRESHOLD && (best === null || score > best.score)) {
      best = { candidate, score };
    }
  }
  if (best) {
    return { kind: 'fuzzy', matchId: best.candidate.id, groupId: best.candidate.dedupGroupId ?? best.candidate.id, score: best.score };
  }

  return { kind: 'unique' };
}

function fuzzyScore(a: DedupInput, b: DedupCandidate): number {
  const companyA = normalizeCompany(a.company);
  const companyB = normalizeCompany(b.company);
  // Unknown-vs-unknown company is not evidence of a match — only a
  // confirmed, non-empty agreement counts. This is the primary false-
  // positive guard: two different companies' postings, however similarly
  // titled ("Software Engineer" is everywhere), never fuzzy-match.
  if (companyA === '' || companyB === '' || companyA !== companyB) return 0;

  return titleTokenJaccard(normalizeTitle(a.title), normalizeTitle(b.title));
}

function normalizeCompany(company: string | null): string {
  return (company ?? '').trim().toLowerCase().replace(/[^a-z0-9]+/g, '');
}

function normalizeTitle(title: string): Set<string> {
  const STOPWORDS = new Set(['a', 'an', 'the', 'and', 'or', 'at', 'in', 'for', 'to', 'of']);
  return new Set(
    title
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, ' ')
      .split(' ')
      .filter((t) => t.length > 0 && !STOPWORDS.has(t)),
  );
}

function titleTokenJaccard(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 || b.size === 0) return 0;
  let intersection = 0;
  for (const token of a) if (b.has(token)) intersection++;
  const union = a.size + b.size - intersection;
  return union === 0 ? 0 : intersection / union;
}
