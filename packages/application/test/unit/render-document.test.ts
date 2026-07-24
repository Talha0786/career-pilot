import { describe, it, expect } from 'vitest';
import { makeCreateDocumentUseCase } from '../../src/documents/commands/create-document.js';
import { makeAddDocumentVersionUseCase } from '../../src/documents/commands/add-document-version.js';
import { makeRenderDocumentUseCase } from '../../src/documents/commands/render-document.js';
import { FakeUnitOfWork } from '../fake-repos.js';
import { FakeDocumentRenderer, InMemoryObjectStorage } from '../fakes.js';
import { asUserId, isOk, isErr, type ResumeDocumentContent } from '@careerpilot/domain';

const USER = asUserId('018f0000-0000-7000-8000-000000000001');

const resumeContent = (): ResumeDocumentContent => ({
  schemaVersion: 1,
  kind: 'resume',
  contact: { name: 'Ada Lovelace', email: 'ada@example.com' },
  summary: 'Engineer',
  sections: [],
});

describe('renderDocument', () => {
  async function setup() {
    const uow = new FakeUnitOfWork();
    const renderer = new FakeDocumentRenderer();
    const storage = new InMemoryObjectStorage();
    const createDocument = makeCreateDocumentUseCase({ uow });
    const addDocumentVersion = makeAddDocumentVersionUseCase({ uow });
    const renderDocument = makeRenderDocumentUseCase({ uow, renderer, storage });

    const created = await createDocument({ userId: USER }, { kind: 'resume', title: 'My Resume' });
    if (!isOk(created)) throw new Error('setup failed');
    const versionResult = await addDocumentVersion(
      { userId: USER },
      { documentId: created.value.documentId, source: 'imported', content: resumeContent() },
    );
    if (!isOk(versionResult)) throw new Error('setup failed');

    return { uow, renderer, storage, documentId: created.value.documentId, versionId: versionResult.value.versionId, renderDocument };
  }

  it('renders a version, stores the bytes, and attaches the key WITHOUT touching content/version/createdAt', async () => {
    const { uow, renderer, storage, documentId, versionId, renderDocument } = await setup();

    const r = await renderDocument({ userId: USER }, { documentId, versionId, format: 'pdf', template: 'classic' });
    expect(isOk(r)).toBe(true);
    if (!isOk(r)) return;

    expect(r.value.renderedKey).toBe(`documents/${documentId}/${versionId}.pdf`);
    expect(renderer.calls).toHaveLength(1);
    expect(renderer.calls[0]!.format).toBe('pdf');
    expect(renderer.calls[0]!.template).toBe('classic');

    const stored = await storage.get(r.value.renderedKey);
    expect(stored).not.toBeNull();
    expect(stored!.toString()).toBe('fake-pdf-classic-rendering');

    const doc = await uow.documents.findByIdForUser(documentId as never, USER);
    const version = doc!.versions.find((v) => v.id === versionId)!;
    expect(version.renderedPdfKey).toBe(r.value.renderedKey);
    expect(version.version).toBe(1);
  });

  it('supports rendering the SAME version in both formats and both templates independently', async () => {
    const { renderer, documentId, versionId, renderDocument } = await setup();

    await renderDocument({ userId: USER }, { documentId, versionId, format: 'pdf', template: 'modern' });
    await renderDocument({ userId: USER }, { documentId, versionId, format: 'docx', template: 'classic' });

    expect(renderer.calls).toHaveLength(2);
    expect(renderer.calls.map((c) => `${c.format}:${c.template}`)).toEqual(['pdf:modern', 'docx:classic']);
  });

  it('returns not_found for a document that does not belong to the caller', async () => {
    const { renderDocument } = await setup();
    const r = await renderDocument(
      { userId: asUserId('018f0000-0000-7000-8000-0000000000ff') },
      { documentId: '018f0000-0000-7000-8000-0000000000ee', versionId: 'x', format: 'pdf', template: 'classic' },
    );
    expect(isErr(r)).toBe(true);
    if (isErr(r)) expect(r.error.code).toBe('not_found');
  });

  it('returns not_found for an unknown version id on an owned document', async () => {
    const { documentId, renderDocument } = await setup();
    const r = await renderDocument(
      { userId: USER },
      { documentId, versionId: 'not-a-real-version', format: 'pdf', template: 'classic' },
    );
    expect(isErr(r)).toBe(true);
    if (isErr(r)) expect(r.error.code).toBe('not_found');
  });
});
