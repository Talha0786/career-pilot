import type {
  ListDocumentsResponse,
  DocumentDto,
  DocumentVersionDto,
  CreateDocumentRequest,
  CreateDocumentResponse,
  AddDocumentVersionRequest,
  AddDocumentVersionResponse,
  RenderDocumentRequest,
  RenderDocumentResponse,
  TailoringRequest,
  TailorDocumentResponse,
  ReviewDocumentVersionRequest,
  ReviewDocumentVersionResponse,
} from '@careerpilot/contracts';
import { request } from '../api-client.js';

/** Typed client for task 022/024's document routes (task 025). */
export const documentsApi = {
  list: () => request<ListDocumentsResponse>('/documents'),

  create: (body: CreateDocumentRequest) =>
    request<CreateDocumentResponse>('/documents', { method: 'POST', body: JSON.stringify(body) }),

  get: (id: string) => request<DocumentDto>(`/documents/${id}`),

  addVersion: (id: string, body: AddDocumentVersionRequest) =>
    request<AddDocumentVersionResponse>(`/documents/${id}/versions`, { method: 'POST', body: JSON.stringify(body) }),

  getVersion: (id: string, versionId: string) =>
    request<DocumentVersionDto>(`/documents/${id}/versions/${versionId}`),

  render: (id: string, versionId: string, body: RenderDocumentRequest) =>
    request<RenderDocumentResponse>(`/documents/${id}/versions/${versionId}/render`, {
      method: 'POST',
      body: JSON.stringify(body),
    }),

  /** Task 039 — kicks off the async tailoring pipeline (202, poll GET/ws for the new version). */
  tailor: (id: string, body: TailoringRequest) =>
    request<TailorDocumentResponse>(`/documents/${id}/tailor`, { method: 'POST', body: JSON.stringify(body) }),

  /** Task 041 — resolves a pending needsHumanReview:true version. */
  review: (id: string, versionId: string, body: ReviewDocumentVersionRequest) =>
    request<ReviewDocumentVersionResponse>(`/documents/${id}/versions/${versionId}/review`, {
      method: 'POST',
      body: JSON.stringify(body),
    }),

  /** Not fetched via `request` — this is a plain URL for an <a>/download link (binary response, auth cookie carries automatically). */
  downloadUrl: (id: string, versionId: string) => `/api/documents/${id}/versions/${versionId}/download`,
};
