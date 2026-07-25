import { describe, it, expect } from 'vitest';
import { Application, Document, asUserId, isOk, isErr } from '@careerpilot/domain';
import { makeStartApplyTaskUseCase } from '../../src/apply/commands/start-apply-task.js';
import { FakeApplicationRepository, FakeDocumentRepository, FakeApplyTaskRepository } from '../fake-repos.js';

const USER = asUserId('018f0000-0000-7000-8000-000000000001');
const OTHER_USER = asUserId('018f0000-0000-7000-8000-000000000002');

async function seed(opts: { needsHumanReview: boolean }) {
  const applications = new FakeApplicationRepository();
  const documents = new FakeDocumentRepository();
  const applyTasks = new FakeApplyTaskRepository();

  const app = Application.create({ userId: USER, jobPostingId: '018f0000-0000-7000-8000-0000000000aa' as never });
  await applications.save(app);

  const docR = Document.create({ userId: USER, kind: 'resume', title: 'Resume' });
  if (!isOk(docR)) throw new Error('setup');
  const document = docR.value;
  const versionR = document.addVersion({
    source: 'generated',
    content: { schemaVersion: 1, kind: 'resume', contact: { name: 'A', email: 'a@b.com' }, summary: null, sections: [] },
    needsHumanReview: opts.needsHumanReview,
    flaggedClaims: opts.needsHumanReview ? [{ text: 'unsupported claim', confidence: 0.9 }] : null,
  });
  if (!isOk(versionR)) throw new Error('setup');
  await documents.save(document);

  return { applications, documents, applyTasks, app, document, version: versionR.value };
}

describe('startApplyTask — document-exportability gate (task 051, THE critical acceptance criterion)', () => {
  it('REJECTS starting an ApplyTask against a DocumentVersion with needsHumanReview: true', async () => {
    const { applications, documents, applyTasks, app, document, version } = await seed({ needsHumanReview: true });
    const useCase = makeStartApplyTaskUseCase({ applications, documents, applyTasks });

    const result = await useCase({
      userId: USER, applicationId: app.id, documentId: document.id, documentVersionId: version.id,
    });

    expect(isErr(result)).toBe(true);
    if (isErr(result)) {
      expect(result.error.code).toBe('validation_failed');
      expect(result.error.details?.needsHumanReview).toBe('true');
    }
    // No ApplyTask row was ever created — the gate fires BEFORE creation, not after.
    expect(applyTasks.saveCount).toBe(0);
  });

  it('ALLOWS starting an ApplyTask against an exportable (needsHumanReview: false) DocumentVersion', async () => {
    const { applications, documents, applyTasks, app, document, version } = await seed({ needsHumanReview: false });
    const useCase = makeStartApplyTaskUseCase({ applications, documents, applyTasks });

    const result = await useCase({
      userId: USER, applicationId: app.id, documentId: document.id, documentVersionId: version.id,
    });

    expect(isOk(result)).toBe(true);
    if (isOk(result)) {
      expect(result.value.stage).toBe('draft');
      expect(result.value.documentVersionId).toBe(version.id);
    }
    expect(applyTasks.saveCount).toBe(1);
  });

  it('rejects for another user (ownership-scoped, no cross-user application access)', async () => {
    const { applications, documents, applyTasks, app, document, version } = await seed({ needsHumanReview: false });
    const useCase = makeStartApplyTaskUseCase({ applications, documents, applyTasks });

    const result = await useCase({
      userId: OTHER_USER, applicationId: app.id, documentId: document.id, documentVersionId: version.id,
    });
    expect(isErr(result)).toBe(true);
    if (isErr(result)) expect(result.error.code).toBe('not_found');
  });

  it('rejects an unknown documentVersionId (not just an unknown document)', async () => {
    const { applications, documents, applyTasks, app, document } = await seed({ needsHumanReview: false });
    const useCase = makeStartApplyTaskUseCase({ applications, documents, applyTasks });

    const result = await useCase({
      userId: USER, applicationId: app.id, documentId: document.id,
      documentVersionId: '018f0000-0000-7000-8000-0000000000ff',
    });
    expect(isErr(result)).toBe(true);
    if (isErr(result)) expect(result.error.code).toBe('not_found');
  });
});
