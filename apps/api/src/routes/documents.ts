import type { FastifyInstance } from 'fastify';
import { CreateDocumentRequestSchema, AddDocumentVersionRequestSchema } from '@careerpilot/contracts';
import {
  makeListDocumentsUseCase,
  makeCreateDocumentUseCase,
  makeAddDocumentVersionUseCase,
  makeGetDocumentUseCase,
  makeGetDocumentVersionUseCase,
} from '@careerpilot/application';
import type { UnitOfWork, DocumentRepository, ProfileRepository } from '@careerpilot/application';
import { sendDomainError, sendProblem } from '../lib/problem.js';
import { requireAuth } from '../plugins/auth.js';

/** See the path-prefix note in routes/profile.ts — unprefixed, matching every other M2 route. */
export function registerDocumentRoutes(
  app: FastifyInstance,
  deps: { uow: UnitOfWork; documents: DocumentRepository; profiles: ProfileRepository },
): void {
  const listDocuments = makeListDocumentsUseCase({ documents: deps.documents, profiles: deps.profiles });
  const createDocument = makeCreateDocumentUseCase({ uow: deps.uow });
  const addDocumentVersion = makeAddDocumentVersionUseCase({ uow: deps.uow });
  const getDocument = makeGetDocumentUseCase({ documents: deps.documents });
  const getDocumentVersion = makeGetDocumentVersionUseCase({ documents: deps.documents });

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
}
