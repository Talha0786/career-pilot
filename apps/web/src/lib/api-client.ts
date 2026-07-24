import type {
  RegisterRequest, RegisterResponse, LoginRequest, MeResponse,
  CreateManualJobRequest, CreateManualJobResponse, ListJobsResponse, JobPostingDto,
  BoardResponse,
} from '@careerpilot/contracts';
import type { Problem } from '@careerpilot/contracts';

export class ApiError extends Error {
  constructor(
    public readonly status: number,
    public readonly problem: Problem,
  ) {
    super(problem.message);
  }
}

/** Exported for apps/web/src/lib/api/{profile,documents}.ts (task 025) — same fetch wrapper, one source of truth. */
export async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`/api${path}`, {
    ...init,
    headers: { 'content-type': 'application/json', ...init?.headers },
  });

  if (res.status === 204) return undefined as T;

  const body = await res.json().catch(() => ({ code: 'internal_error', message: 'Invalid response' }));

  if (!res.ok) throw new ApiError(res.status, body as Problem);
  return body as T;
}

export const api = {
  register: (body: RegisterRequest) =>
    request<RegisterResponse>('/auth/register', { method: 'POST', body: JSON.stringify(body) }),

  login: (body: LoginRequest) =>
    request<{ userId: string }>('/auth/login', { method: 'POST', body: JSON.stringify(body) }),

  logout: () => request<void>('/auth/logout', { method: 'POST' }),

  me: () => request<MeResponse>('/auth/me'),

  createJob: (body: CreateManualJobRequest) =>
    request<CreateManualJobResponse>('/jobs', { method: 'POST', body: JSON.stringify(body) }),

  listJobs: () => request<ListJobsResponse>('/jobs'),

  getJob: (id: string) => request<JobPostingDto>(`/jobs/${id}`),

  createApplication: (jobPostingId: string) =>
    request<{ applicationId: string }>('/applications', { method: 'POST', body: JSON.stringify({ jobPostingId }) }),

  updateStage: (applicationId: string, toStage: string) =>
    request<{ application: { applicationId: string; stage: string; updatedAt: string } }>(
      `/applications/${applicationId}/stage`,
      { method: 'PATCH', body: JSON.stringify({ toStage }) },
    ),

  getBoard: () => request<BoardResponse>('/board'),
};
