import { asUserId } from '@careerpilot/domain';
import type { JobPostingRepository, Actor } from '../../ports/repositories.js';

export interface SearchJobsFilters {
  remote?: 'remote' | 'hybrid' | 'onsite' | 'unknown' | undefined;
  location?: string | undefined;
  minSalary?: number | undefined;
  postedAfter?: string | undefined; // ISO date
}
export interface SearchJobsInput {
  query?: string | undefined;
  filters?: SearchJobsFilters | undefined;
  limit: number;
}
export interface SearchJobsResultItem {
  id: string;
  title: string;
  company: string | null;
  url: string | null;
  descriptionMd: string;
  location: { raw: string } | null;
  remote: 'remote' | 'hybrid' | 'onsite' | 'unknown';
  salaryMin: number | null;
  embeddingStatus: 'pending' | 'ready' | 'failed';
  ingestedAt: string;
}

/**
 * Task 057's `search_jobs` MCP tool. `JobPostingRepository` (M4) has no
 * full-text search index or server-side filter predicates — this is a
 * deliberately scoped-down implementation: fetches a bounded window of
 * the user's most recent postings (FETCH_WINDOW, well above the tool's
 * own `limit<=50` cap) and applies `query`/`filters` IN-MEMORY before
 * truncating to `limit`. Documented as a real limitation, not silently
 * passed off as full search — a user with more than FETCH_WINDOW postings
 * and an old, unmatched target job could get a false "no results." A
 * proper fix (Postgres full-text index + WHERE-clause filters in the
 * repository) is out of scope for this task per its own file list
 * ("no new business logic... thin wrapper").
 */
const FETCH_WINDOW = 500;

export function makeSearchJobsUseCase(deps: { jobPostings: JobPostingRepository }) {
  return async function searchJobs(actor: Actor, input: SearchJobsInput): Promise<SearchJobsResultItem[]> {
    const { items } = await deps.jobPostings.listForUser(asUserId(actor.userId), { limit: FETCH_WINDOW });

    const q = input.query?.trim().toLowerCase();
    const filters = input.filters;
    const postedAfter = filters?.postedAfter ? new Date(filters.postedAfter) : null;

    const filtered = items.filter((job) => {
      if (q) {
        const haystack = `${job.title} ${job.company ?? ''} ${job.descriptionMd}`.toLowerCase();
        if (!haystack.includes(q)) return false;
      }
      if (filters?.remote && job.remote !== filters.remote) return false;
      if (filters?.location) {
        const loc = job.location?.raw?.toLowerCase() ?? '';
        if (!loc.includes(filters.location.toLowerCase())) return false;
      }
      if (filters?.minSalary !== undefined) {
        const min = job.salary?.min;
        if (min === undefined || min < filters.minSalary) return false;
      }
      if (postedAfter && job.ingestedAt < postedAfter) return false;
      return true;
    });

    return filtered.slice(0, input.limit).map((job) => ({
      id: job.id,
      title: job.title,
      company: job.company,
      url: job.url,
      descriptionMd: job.descriptionMd,
      location: job.location ? { raw: job.location.raw } : null,
      remote: job.remote,
      salaryMin: job.salary?.min ?? null,
      embeddingStatus: job.embeddingStatus,
      ingestedAt: job.ingestedAt.toISOString(),
    }));
  };
}
