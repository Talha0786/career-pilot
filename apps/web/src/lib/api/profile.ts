import type {
  CareerProfileDto,
  PutProfileRequest,
  AddSectionRequest,
  AddSectionResponse,
  ImportResumeRequest,
  ImportResumeResponse,
  GetResumeImportDraftResponse,
  ConfirmResumeImportRequest,
  ConfirmResumeImportResponse,
} from '@careerpilot/contracts';
import { request } from '../api-client.js';

/** Typed client for task 022/023's profile & resume-import routes (task 025). */
export const profileApi = {
  getProfile: () => request<CareerProfileDto>('/profile'),

  putProfile: (body: PutProfileRequest) =>
    request<{ profileId: string }>('/profile', { method: 'PUT', body: JSON.stringify(body) }),

  addSection: (body: AddSectionRequest) =>
    request<AddSectionResponse>('/profile/sections', { method: 'POST', body: JSON.stringify(body) }),

  importResume: (body: ImportResumeRequest) =>
    request<ImportResumeResponse>('/profile/import', { method: 'POST', body: JSON.stringify(body) }),

  getImportDraft: (draftId: string) =>
    request<GetResumeImportDraftResponse>(`/profile/import/${draftId}`),

  confirmImport: (draftId: string, body: ConfirmResumeImportRequest) =>
    request<ConfirmResumeImportResponse>(`/profile/import/${draftId}/confirm`, {
      method: 'POST',
      body: JSON.stringify(body),
    }),
};

/** Reads a File as base64 (no data: prefix) — what ImportResumeRequestSchema expects. */
export async function fileToBase64(file: File): Promise<string> {
  const buffer = await file.arrayBuffer();
  const bytes = new Uint8Array(buffer);
  let binary = '';
  // Chunked to avoid a stack-overflow from String.fromCharCode(...hugeArray) on large files.
  const CHUNK = 8192;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return btoa(binary);
}
