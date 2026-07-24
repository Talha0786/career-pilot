import { describe, it, expect } from 'vitest';
import { makeCreateDocumentUseCase } from '../../src/documents/commands/create-document.js';
import { makeAddDocumentVersionUseCase } from '../../src/documents/commands/add-document-version.js';
import { makeGetDocumentUseCase, makeGetDocumentVersionUseCase } from '../../src/documents/queries/get-document.js';
import { makeListDocumentsUseCase } from '../../src/documents/queries/list-documents.js';
import { makeCreateProfileUseCase } from '../../src/profile/commands/create-profile.js';
import { FakeUnitOfWork } from '../fake-repos.js';
import { asUserId, isOk, isErr, type ResumeDocumentContent } from '@careerpilot/domain';

const USER = asUserId('018f0000-0000-7000-8000-000000000001');

const resumeContent = (overrides?: Partial<ResumeDocumentContent>): ResumeDocumentContent => ({
  schemaVersion: 1,
  kind: 'resume',
  contact: { name: 'Ada Lovelace', email: 'ada@example.com' },
  summary: 'Engineer',
  sections: [],
  ...overrides,
});

describe('createDocument', () => {
  it('creates a document and enqueues its creation event atomically', async () => {
    const uow = new FakeUnitOfWork();
    const createDocument = makeCreateDocumentUseCase({ uow });

    const r = await createDocument({ userId: USER }, { kind: 'resume', title: 'My Resume' });
    expect(isOk(r)).toBe(true);
    if (!isOk(r)) return;

    expect(uow.outbox.enqueued).toHaveLength(1);
    expect(uow.outbox.enqueued[0]!.eventType).toBe('documents.document_created');

    const stored = await uow.documents.findByIdForUser(r.value.documentId as never, USER);
    expect(stored).not.toBeNull();
  });

  it('rejects invalid input and writes nothing', async () => {
    const uow = new FakeUnitOfWork();
    const createDocument = makeCreateDocumentUseCase({ uow });

    const r = await createDocument({ userId: USER }, { kind: 'resume', title: '' });
    expect(isErr(r)).toBe(true);
    expect(uow.outbox.enqueued).toHaveLength(0);
  });
});

describe('addDocumentVersion', () => {
  async function setupDocument(uow: FakeUnitOfWork) {
    const createDocument = makeCreateDocumentUseCase({ uow });
    const created = await createDocument({ userId: USER }, { kind: 'resume', title: 'My Resume' });
    if (!isOk(created)) throw new Error('setup failed');
    return created.value.documentId;
  }

  it('appends a new version, updates currentVersionId, and writes an audit_log entry (happy path)', async () => {
    const uow = new FakeUnitOfWork();
    const documentId = await setupDocument(uow);
    const addDocumentVersion = makeAddDocumentVersionUseCase({ uow });

    const r = await addDocumentVersion(
      { userId: USER },
      { documentId, source: 'imported', content: resumeContent() },
    );
    expect(isOk(r)).toBe(true);
    if (!isOk(r)) return;
    expect(r.value.version).toBe(1);

    expect(uow.audit.records).toHaveLength(1);
    expect(uow.audit.records[0]!.action).toBe('document.version_created');
    expect(uow.audit.records[0]!.subjectId).toBe(documentId);

    const stored = await uow.documents.findByIdForUser(documentId as never, USER);
    expect(stored!.currentVersionId).toBe(r.value.versionId);
  });

  it('strictly increments version numbers across repeated calls — never mutates an earlier one', async () => {
    const uow = new FakeUnitOfWork();
    const documentId = await setupDocument(uow);
    const addDocumentVersion = makeAddDocumentVersionUseCase({ uow });

    await addDocumentVersion({ userId: USER }, { documentId, source: 'imported', content: resumeContent({ summary: 'v1' }) });
    await addDocumentVersion({ userId: USER }, { documentId, source: 'edited', content: resumeContent({ summary: 'v2' }) });

    const stored = await uow.documents.findByIdForUser(documentId as never, USER);
    expect(stored!.versions.map((v) => v.version)).toEqual([1, 2]);
    expect((stored!.versions[0]!.content as ResumeDocumentContent).summary).toBe('v1'); // untouched
  });

  it('invariant-violation path: rejects adding a version to a document that no longer exists for this user', async () => {
    const uow = new FakeUnitOfWork();
    const addDocumentVersion = makeAddDocumentVersionUseCase({ uow });

    const r = await addDocumentVersion(
      { userId: USER },
      { documentId: '018f0000-0000-7000-8000-0000000000ff', source: 'imported', content: resumeContent() },
    );
    expect(isErr(r)).toBe(true);
    if (isErr(r)) expect(r.error.code).toBe('not_found');
    expect(uow.audit.records).toHaveLength(0); // nothing audited on failure
  });

  it('invariant-violation path: the domain append-only guard rejects a version on a soft-deleted document', async () => {
    const uow = new FakeUnitOfWork();
    const documentId = await setupDocument(uow);
    const doc = await uow.documents.findByIdForUser(documentId as never, USER);
    doc!.softDelete();
    await uow.documents.save(doc!);

    const addDocumentVersion = makeAddDocumentVersionUseCase({ uow });
    const r = await addDocumentVersion(
      { userId: USER },
      { documentId, source: 'edited', content: resumeContent() },
    );
    expect(isErr(r)).toBe(true);
    if (isErr(r)) expect(r.error.code).toBe('conflict');
  });
});

describe('getDocument / getDocumentVersion', () => {
  it('returns the document with its versions', async () => {
    const uow = new FakeUnitOfWork();
    const createDocument = makeCreateDocumentUseCase({ uow });
    const addDocumentVersion = makeAddDocumentVersionUseCase({ uow });
    const getDocument = makeGetDocumentUseCase({ documents: uow.documents });

    const created = await createDocument({ userId: USER }, { kind: 'resume', title: 'My Resume' });
    if (!isOk(created)) throw new Error('setup failed');
    await addDocumentVersion({ userId: USER }, { documentId: created.value.documentId, source: 'imported', content: resumeContent() });

    const r = await getDocument({ userId: USER }, created.value.documentId);
    expect(isOk(r)).toBe(true);
    if (isOk(r)) expect(r.value.versions).toHaveLength(1);
  });

  it('getDocumentVersion returns not_found for an unknown version id', async () => {
    const uow = new FakeUnitOfWork();
    const createDocument = makeCreateDocumentUseCase({ uow });
    const getDocumentVersion = makeGetDocumentVersionUseCase({ documents: uow.documents });

    const created = await createDocument({ userId: USER }, { kind: 'resume', title: 'My Resume' });
    if (!isOk(created)) throw new Error('setup failed');

    const r = await getDocumentVersion({ userId: USER }, created.value.documentId, 'nope');
    expect(isErr(r)).toBe(true);
    if (isErr(r)) expect(r.error.code).toBe('not_found');
  });
});

describe('listDocuments — staleness', () => {
  it('flags a document stale when its recorded profileFactsHash no longer matches the active profile', async () => {
    const uow = new FakeUnitOfWork();
    const createProfile = makeCreateProfileUseCase({ uow });
    const createDocument = makeCreateDocumentUseCase({ uow });
    const addDocumentVersion = makeAddDocumentVersionUseCase({ uow });
    const listDocuments = makeListDocumentsUseCase({ documents: uow.documents, profiles: uow.profiles });

    await createProfile({ userId: USER }, { title: 'My Career' });
    const created = await createDocument({ userId: USER }, { kind: 'resume', title: 'My Resume' });
    if (!isOk(created)) throw new Error('setup failed');

    // Generated against a facts hash that will no longer match once the profile changes.
    await addDocumentVersion({ userId: USER }, {
      documentId: created.value.documentId,
      source: 'generated',
      content: resumeContent(),
      profileFactsHash: 'stale-hash-from-earlier',
    });

    const { items } = await listDocuments({ userId: USER });
    expect(items).toHaveLength(1);
    expect(items[0]!.isStale).toBe(true);
  });

  it('is not stale when there is no recorded profileFactsHash (e.g. an imported document)', async () => {
    const uow = new FakeUnitOfWork();
    const createDocument = makeCreateDocumentUseCase({ uow });
    const addDocumentVersion = makeAddDocumentVersionUseCase({ uow });
    const listDocuments = makeListDocumentsUseCase({ documents: uow.documents, profiles: uow.profiles });

    const created = await createDocument({ userId: USER }, { kind: 'resume', title: 'My Resume' });
    if (!isOk(created)) throw new Error('setup failed');
    await addDocumentVersion({ userId: USER }, { documentId: created.value.documentId, source: 'imported', content: resumeContent() });

    const { items } = await listDocuments({ userId: USER });
    expect(items[0]!.isStale).toBe(false);
  });

  it('excludes soft-deleted documents', async () => {
    const uow = new FakeUnitOfWork();
    const createDocument = makeCreateDocumentUseCase({ uow });
    const listDocuments = makeListDocumentsUseCase({ documents: uow.documents, profiles: uow.profiles });

    const created = await createDocument({ userId: USER }, { kind: 'resume', title: 'My Resume' });
    if (!isOk(created)) throw new Error('setup failed');
    const doc = await uow.documents.findByIdForUser(created.value.documentId as never, USER);
    doc!.softDelete();
    await uow.documents.save(doc!);

    const { items } = await listDocuments({ userId: USER });
    expect(items).toHaveLength(0);
  });
});
