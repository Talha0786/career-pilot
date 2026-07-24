import { describe, it, expect } from 'vitest';
import { makeCreateDocumentUseCase } from '../../src/documents/commands/create-document.js';
import { makeAddDocumentVersionUseCase } from '../../src/documents/commands/add-document-version.js';
import { makeReviewDocumentVersionUseCase } from '../../src/documents/commands/review-document-version.js';
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

async function setupFlaggedVersion() {
  const uow = new FakeUnitOfWork();
  const createDocument = makeCreateDocumentUseCase({ uow });
  const addDocumentVersion = makeAddDocumentVersionUseCase({ uow });
  const reviewDocumentVersion = makeReviewDocumentVersionUseCase({ uow });

  const created = await createDocument({ userId: USER }, { kind: 'resume', title: 'Flagged Resume' });
  if (!isOk(created)) throw new Error('setup failed');
  const versionResult = await addDocumentVersion(
    { userId: USER },
    {
      documentId: created.value.documentId,
      source: 'generated',
      content: resumeContent(),
      needsHumanReview: true,
      flaggedClaims: [{ text: 'Led a team of 12 engineers', confidence: 0.2 }],
    },
  );
  if (!isOk(versionResult)) throw new Error('setup failed');

  return { uow, documentId: created.value.documentId, versionId: versionResult.value.versionId, reviewDocumentVersion };
}

describe('reviewDocumentVersion — task 041 human-review resolution', () => {
  it('approved:true clears needsHumanReview and unblocks export', async () => {
    const { uow, documentId, versionId, reviewDocumentVersion } = await setupFlaggedVersion();

    const result = await reviewDocumentVersion({ userId: USER }, { documentId, versionId, approved: true });
    expect(isOk(result)).toBe(true);
    if (!isOk(result)) return;
    expect(result.value.needsHumanReview).toBe(false);

    const stored = await uow.documents.findByIdForUser(documentId as never, USER);
    const version = stored!.versions.find((v) => v.id === versionId)!;
    expect(version.needsHumanReview).toBe(false);
    expect(version.isExportable()).toBe(true);
    // The historical flaggedClaims record is kept, not erased — an audit
    // trail of what was flagged and resolved, not just what's pending now.
    expect(version.flaggedClaims).toEqual([{ text: 'Led a team of 12 engineers', confidence: 0.2 }]);

    // Export actually works now — the real gate from render-document.ts,
    // exercised end to end through the just-cleared state.
    const renderDocument = makeRenderDocumentUseCase({ uow, renderer: new FakeDocumentRenderer(), storage: new InMemoryObjectStorage() });
    const renderResult = await renderDocument({ userId: USER }, { documentId, versionId, format: 'pdf', template: 'classic' });
    expect(renderResult.ok).toBe(true);
  });

  it('approved:false leaves needsHumanReview true — export stays blocked', async () => {
    const { uow, documentId, versionId, reviewDocumentVersion } = await setupFlaggedVersion();

    const result = await reviewDocumentVersion({ userId: USER }, { documentId, versionId, approved: false });
    expect(isOk(result)).toBe(true);
    if (!isOk(result)) return;
    expect(result.value.needsHumanReview).toBe(true);

    const renderDocument = makeRenderDocumentUseCase({ uow, renderer: new FakeDocumentRenderer(), storage: new InMemoryObjectStorage() });
    const renderResult = await renderDocument({ userId: USER }, { documentId, versionId, format: 'pdf', template: 'classic' });
    expect(renderResult.ok).toBe(false);
    if (!renderResult.ok) expect(renderResult.error.code).toBe('conflict');
  });

  it('returns conflict, not a silent no-op, when reviewing a version that has no pending review', async () => {
    const uow = new FakeUnitOfWork();
    const createDocument = makeCreateDocumentUseCase({ uow });
    const addDocumentVersion = makeAddDocumentVersionUseCase({ uow });
    const reviewDocumentVersion = makeReviewDocumentVersionUseCase({ uow });

    const created = await createDocument({ userId: USER }, { kind: 'resume', title: 'Clean Resume' });
    if (!isOk(created)) throw new Error('setup failed');
    const versionResult = await addDocumentVersion(
      { userId: USER },
      { documentId: created.value.documentId, source: 'imported', content: resumeContent() },
    );
    if (!isOk(versionResult)) throw new Error('setup failed');

    const result = await reviewDocumentVersion(
      { userId: USER },
      { documentId: created.value.documentId, versionId: versionResult.value.versionId, approved: true },
    );
    expect(isErr(result)).toBe(true);
    if (isErr(result)) expect(result.error.code).toBe('conflict');
  });

  it('returns not_found for a document the caller does not own', async () => {
    const { reviewDocumentVersion } = await setupFlaggedVersion();
    const result = await reviewDocumentVersion(
      { userId: asUserId('018f0000-0000-7000-8000-0000000000ff') },
      { documentId: '018f0000-0000-7000-8000-0000000000ee', versionId: 'x', approved: true },
    );
    expect(isErr(result)).toBe(true);
    if (isErr(result)) expect(result.error.code).toBe('not_found');
  });
});
