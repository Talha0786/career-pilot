import type { FastifyInstance } from 'fastify';
import {
  CreateDocumentRequestSchema,
  AddDocumentVersionRequestSchema,
  RenderDocumentRequestSchema,
} from '@careerpilot/contracts';
import {
  makeListDocumentsUseCase,
  makeCreateDocumentUseCase,
  makeAddDocumentVersionUseCase,
  makeGetDocumentUseCase,
  makeGetDocumentVersionUseCase,
  makeRenderDocumentUseCase,
} from '@careerpilot/application';
import type {
  UnitOfWork, DocumentRepository, ProfileRepository, DocumentRendererPort, ObjectStoragePort,
} from '@careerpilot/application';
import { sendDomainError, sendProblem } from '../lib/problem.js';
import { requireAuth } from '../plugins/auth.js';

const CONTENT_TYPE_BY_FORMAT: Record<string, string> = {
  pdf: 'application/pdf',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
};

/** See the path-prefix note in routes/profile.ts — unprefixed, matching every other M2 route. */
export function registerDocumentRoutes(
  app: FastifyInstance,
  deps: {
    uow: UnitOfWork;
    documents: DocumentRepository;
    profiles: ProfileRepository;
    renderer: DocumentRendererPort;
    storage: ObjectStoragePort;
  },
): void {
  const listDocuments = makeListDocumentsUseCase({ documents: deps.documents, profiles: deps.profiles });
  const createDocument = makeCreateDocumentUseCase({ uow: deps.uow });
  const addDocumentVersion = makeAddDocumentVersionUseCase({ uow: deps.uow });
  const getDocument = makeGetDocumentUseCase({ documents: deps.documents });
  const getDocumentVersion = makeGetDocumentVersionUseCase({ documents: deps.documents });
  const renderDocument = makeRenderDocumentUseCase({ uow: deps.uow, renderer: deps.renderer, storage: deps.storage });

  app.get('/documents', { preHandler: requireAuth }, async (request, reply) => {
    const result = await listDocuments(request.actor!);
    return reply.send(result);
  });

  // 201, not 202 — unlike POST /jobs there is no async work pending after
  // creation (no embedding queued): the document row is fully created
  // synchronously. It has no version yet, but that's an ordinary empty
  // collection, not a pending state — the client adds a version explicitly.
  app.post('/documents', { preHandler: requireAuth }, async (request, reply) => {
    const parsed = CreateDocumentRequestSchema.safeParse(request.body);
    if (!parsed.success) {
      return sendProblem(reply, 400, { code: 'validation_failed', message: parsed.error.issues[0]?.message ?? 'Invalid request' });
    }

    const result = await createDocument(request.actor!, parsed.data);
    if (!result.ok) return sendDomainError(reply, result.error);
    return reply.code(201).send(result.value);
  });

  // Not in task 022's literal route list, but a natural addition — the
  // web UI (task 025) needs a single-document detail view with its full
  // version history, and this is the same shape `getJob`/`GET /jobs/:id`
  // (task 011) already established for a sibling resource.
  app.get<{ Params: { id: string } }>('/documents/:id', { preHandler: requireAuth }, async (request, reply) => {
    const result = await getDocument(request.actor!, request.params.id);
    if (!result.ok) return sendDomainError(reply, result.error);
    return reply.send(result.value);
  });

  app.post<{ Params: { id: string } }>('/documents/:id/versions', { preHandler: requireAuth }, async (request, reply) => {
    const parsed = AddDocumentVersionRequestSchema.safeParse(request.body);
    if (!parsed.success) {
      return sendProblem(reply, 400, { code: 'validation_failed', message: parsed.error.issues[0]?.message ?? 'Invalid request' });
    }

    const result = await addDocumentVersion(request.actor!, { documentId: request.params.id, ...parsed.data });
    if (!result.ok) return sendDomainError(reply, result.error);
    return reply.code(201).send(result.value);
  });

  app.get<{ Params: { id: string; versionId: string } }>(
    '/documents/:id/versions/:versionId',
    { preHandler: requireAuth },
    async (request, reply) => {
      const result = await getDocumentVersion(request.actor!, request.params.id, request.params.versionId);
      if (!result.ok) return sendDomainError(reply, result.error);
      return reply.send(result.value);
    },
  );

  // Task 024: renders the version's structured content and attaches the
  // artifact key. Never mutates content/version/createdAt — see
  // render-document.ts's doc comment.
  app.post<{ Params: { id: string; versionId: string } }>(
    '/documents/:id/versions/:versionId/render',
    { preHandler: requireAuth },
    async (request, reply) => {
      const parsed = RenderDocumentRequestSchema.safeParse(request.body);
      if (!parsed.success) {
        return sendProblem(reply, 400, { code: 'validation_failed', message: parsed.error.issues[0]?.message ?? 'Invalid request' });
      }

      const result = await renderDocument(request.actor!, {
        documentId: request.params.id,
        versionId: request.params.versionId,
        ...parsed.data,
      });
      if (!result.ok) return sendDomainError(reply, result.error);
      return reply.send(result.value);
    },
  );

  // Auth-gated download (task 024's "signed API route" — see
  // object-storage.port.ts's docstring for why there's no presigned URL).
  // Ownership is re-checked here independent of whether the caller already
  // has the renderedPdfKey, same posture as every other resource route.
  app.get<{ Params: { id: string; versionId: string } }>(
    '/documents/:id/versions/:versionId/download',
    { preHandler: requireAuth },
    async (request, reply) => {
      const versionResult = await getDocumentVersion(request.actor!, request.params.id, request.params.versionId);
      if (!versionResult.ok) return sendDomainError(reply, versionResult.error);

      const key = versionResult.value.renderedPdfKey;
      if (key === null) {
        return sendProblem(reply, 404, { code: 'not_found', message: 'This version has not been rendered yet' });
      }

      const bytes = await deps.storage.get(key);
      if (bytes === null) {
        return sendProblem(reply, 404, { code: 'not_found', message: 'Rendered artifact not found' });
      }

      const extension = key.split('.').pop() ?? '';
      const contentType = CONTENT_TYPE_BY_FORMAT[extension] ?? 'application/octet-stream';
      return reply
        .header('content-type', contentType)
        .header('content-disposition', `attachment; filename="document.${extension}"`)
        .send(bytes);
    },
  );
}
