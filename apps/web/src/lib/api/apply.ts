import { request } from '../api-client.js';

/**
 * Task 052 — typed client for `apps/api/src/routes/apply.ts`. Plain local
 * interfaces (not `@careerpilot/contracts` DTOs) — pragmatic scope
 * decision given this milestone's time budget; the shapes mirror exactly
 * what the route handlers return (see apply.ts's `reply.send(...)` calls).
 * Promoting these to real zod contracts is a reasonable follow-up.
 */
export interface ApplyTaskListItem {
  id: string;
  applicationId: string;
  jobPostingId: string;
  stage: string;
  atsAdapter: string | null;
  updatedAt: string;
}

export interface StartApplyTaskResponse {
  applyTaskId: string;
  stage: string;
}

export interface ApproveResponse {
  stage: string;
  token: string;
  expiresAt: string;
}

/** Task 052 — the field-level review diff (ADR-003). Mirrors `packages/contracts/src/field-mapping.ts`'s `ApplyTaskFieldDiffEntrySchema`. */
export interface ApplyTaskFieldDiffEntry {
  taxonomyKey: string;
  label: string;
  selector: string;
  mappedValue: string | null;
  neverAutoFill: boolean;
  confidence: number;
  source: 'known_ats' | 'heuristic' | 'llm';
}

export const applyApi = {
  list: (stage?: string) =>
    request<{ tasks: ApplyTaskListItem[] }>(`/apply-tasks${stage ? `?stage=${encodeURIComponent(stage)}` : ''}`),

  start: (body: { applicationId: string; documentId: string; documentVersionId: string }) =>
    request<StartApplyTaskResponse>('/apply-tasks', { method: 'POST', body: JSON.stringify(body) }),

  fields: (id: string) =>
    request<{ fields: ApplyTaskFieldDiffEntry[] }>(`/apply-tasks/${id}/fields`),

  approve: (id: string) =>
    request<ApproveResponse>(`/apply-tasks/${id}/approve`, { method: 'POST' }),

  reject: (id: string) =>
    request<{ stage: string }>(`/apply-tasks/${id}/reject`, { method: 'POST' }),

  submit: (id: string, token: string) =>
    request<{ stage: string }>(`/apply-tasks/${id}/submit`, { method: 'POST', body: JSON.stringify({ token }) }),
};
