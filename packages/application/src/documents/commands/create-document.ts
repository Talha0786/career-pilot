import { Document, type DocumentKind, type Result, type DomainError } from '@careerpilot/domain';
import type { UnitOfWork, Actor } from '../../ports/repositories.js';

export interface CreateDocumentInput {
  kind: DocumentKind;
  title: string;
}
export interface CreateDocumentOutput {
  documentId: string;
  kind: DocumentKind;
}

export function makeCreateDocumentUseCase(deps: { uow: UnitOfWork }) {
  return async function createDocument(
    actor: Actor,
    input: CreateDocumentInput,
  ): Promise<Result<CreateDocumentOutput, DomainError>> {
    const created = Document.create({ userId: actor.userId, kind: input.kind, title: input.title });
    if (!created.ok) return created;

    const doc = created.value;

    await deps.uow.withTransaction(async (ctx) => {
      await ctx.documents.save(doc);
      const events = doc.pullEvents();
      if (events.length > 0) await ctx.outbox.enqueue(events);
    });

    return { ok: true, value: { documentId: doc.id, kind: doc.kind } };
  };
}
