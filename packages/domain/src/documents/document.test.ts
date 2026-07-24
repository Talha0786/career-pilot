import { describe, it, expect } from 'vitest';
import { Document } from './document.js';
import { asUserId } from '../shared/ids.js';
import { isOk, isErr } from '../shared/result.js';
import type { ResumeDocumentContent } from './document-content.js';

const USER = asUserId('018f0000-0000-7000-8000-000000000001');
const OTHER = asUserId('018f0000-0000-7000-8000-000000000002');

const resumeContent = (overrides?: Partial<ResumeDocumentContent>): ResumeDocumentContent => ({
  schemaVersion: 1,
  kind: 'resume',
  contact: { name: 'Ada Lovelace', email: 'ada@example.com' },
  summary: 'Engineer',
  sections: [],
  ...overrides,
});

describe('Document.create', () => {
  it('creates a document with no versions and emits an event', () => {
    const r = Document.create({ userId: USER, kind: 'resume', title: 'My Resume' });
    expect(isOk(r)).toBe(true);
    if (!isOk(r)) return;

    expect(r.value.versions).toHaveLength(0);
    expect(r.value.currentVersionId).toBeNull();
    expect(r.value.isDeleted).toBe(false);
    const events = r.value.pullEvents();
    expect(events).toHaveLength(1);
    expect(events[0]!.eventType).toBe('documents.document_created');
  });

  const validDocument = () => ({ userId: USER, kind: 'resume' as const, title: 'ok' });

  it('rejects a blank title', () => {
    expect(isErr(Document.create({ ...validDocument(), title: '   ' }))).toBe(true);
  });

  it('rejects an unknown document kind', () => {
    expect(isErr(Document.create({ ...validDocument(), kind: 'cv' as never }))).toBe(true);
  });
});

describe('Document.addVersion — append-only', () => {
  it('creates version 1 on first call and sets currentVersionId', () => {
    const r = Document.create({ userId: USER, kind: 'resume', title: 'My Resume' });
    if (!isOk(r)) throw new Error('setup failed');
    const doc = r.value;

    const v1 = doc.addVersion({ source: 'imported', content: resumeContent() });
    expect(isOk(v1)).toBe(true);
    if (!isOk(v1)) return;

    expect(v1.value.version).toBe(1);
    expect(doc.currentVersionId).toBe(v1.value.id);
    expect(doc.versions).toHaveLength(1);
  });

  it('never reuses a version number — each addVersion strictly increments', () => {
    const r = Document.create({ userId: USER, kind: 'resume', title: 'My Resume' });
    if (!isOk(r)) throw new Error('setup failed');
    const doc = r.value;

    doc.addVersion({ source: 'imported', content: resumeContent() });
    doc.addVersion({ source: 'edited', content: resumeContent({ summary: 'Updated' }) });
    const v3 = doc.addVersion({ source: 'generated', content: resumeContent({ summary: 'Tailored' }) });

    expect(doc.versions.map((v) => v.version)).toEqual([1, 2, 3]);
    if (isOk(v3)) expect(doc.currentVersionId).toBe(v3.value.id);
  });

  it('earlier versions are never mutated by later addVersion calls (immutability check)', () => {
    const r = Document.create({ userId: USER, kind: 'resume', title: 'My Resume' });
    if (!isOk(r)) throw new Error('setup failed');
    const doc = r.value;

    const v1 = doc.addVersion({ source: 'imported', content: resumeContent({ summary: 'Original' }) });
    doc.addVersion({ source: 'edited', content: resumeContent({ summary: 'Changed' }) });

    if (!isOk(v1)) throw new Error('setup failed');
    const stillV1 = doc.versions.find((v) => v.id === v1.value.id)!;
    expect((stillV1.content as ResumeDocumentContent).summary).toBe('Original');
  });

  it('rejects content whose kind does not match the document kind', () => {
    const r = Document.create({ userId: USER, kind: 'resume', title: 'My Resume' });
    if (!isOk(r)) throw new Error('setup failed');

    const added = r.value.addVersion({
      source: 'imported',
      content: { schemaVersion: 1, kind: 'cover_letter', contact: { name: 'A', email: 'a@b.com' }, recipient: null, salutation: 'Hi', bodyParagraphs: [], closing: 'Best' },
    });
    expect(isErr(added)).toBe(true);
    if (isErr(added)) expect(added.error.code).toBe('validation_failed');
  });

  it('rejects adding a version to a deleted document', () => {
    const r = Document.create({ userId: USER, kind: 'resume', title: 'My Resume' });
    if (!isOk(r)) throw new Error('setup failed');
    const doc = r.value;
    doc.softDelete();

    const added = doc.addVersion({ source: 'edited', content: resumeContent() });
    expect(isErr(added)).toBe(true);
    if (isErr(added)) expect(added.error.code).toBe('conflict');
  });

  it('has no updateVersion method on the class (structural append-only guarantee)', () => {
    const doc = Document.create({ userId: USER, kind: 'resume', title: 'x' });
    if (!isOk(doc)) throw new Error('setup failed');
    expect((doc.value as unknown as Record<string, unknown>)['updateVersion']).toBeUndefined();
  });
});

describe('Document soft delete (design rule: soft delete only where product requires undo)', () => {
  it('soft-deletes and can be restored', () => {
    const r = Document.create({ userId: USER, kind: 'resume', title: 'My Resume' });
    if (!isOk(r)) throw new Error('setup failed');
    const doc = r.value;

    expect(isOk(doc.softDelete())).toBe(true);
    expect(doc.isDeleted).toBe(true);
    expect(doc.deletedAt).not.toBeNull();

    expect(isOk(doc.restore())).toBe(true);
    expect(doc.isDeleted).toBe(false);
    expect(doc.deletedAt).toBeNull();
  });

  it('rejects double-delete and restoring a non-deleted document', () => {
    const r = Document.create({ userId: USER, kind: 'resume', title: 'My Resume' });
    if (!isOk(r)) throw new Error('setup failed');
    const doc = r.value;

    expect(isErr(doc.restore())).toBe(true);
    doc.softDelete();
    expect(isErr(doc.softDelete())).toBe(true);
  });
});

describe('Document.attachRenderedArtifact', () => {
  it('attaches a rendered pdf key to an existing version without changing its content or version number', () => {
    const r = Document.create({ userId: USER, kind: 'resume', title: 'My Resume' });
    if (!isOk(r)) throw new Error('setup failed');
    const doc = r.value;
    const v1 = doc.addVersion({ source: 'generated', content: resumeContent() });
    if (!isOk(v1)) throw new Error('setup failed');

    const attached = doc.attachRenderedArtifact(v1.value.id, 'documents/abc.pdf');
    expect(isOk(attached)).toBe(true);

    const updated = doc.versions.find((v) => v.id === v1.value.id)!;
    expect(updated.renderedPdfKey).toBe('documents/abc.pdf');
    expect(updated.version).toBe(1);
    expect(updated.content).toEqual(v1.value.content);
  });

  it('returns not_found for an unknown version id', () => {
    const r = Document.create({ userId: USER, kind: 'resume', title: 'My Resume' });
    if (!isOk(r)) throw new Error('setup failed');
    const attached = r.value.attachRenderedArtifact('018f0000-0000-7000-8000-0000000000ff', 'x');
    expect(isErr(attached)).toBe(true);
    if (isErr(attached)) expect(attached.error.code).toBe('not_found');
  });
});

describe('DocumentVersion.isStaleAgainst', () => {
  it('is stale when the profile facts hash has moved on, fresh when it matches', () => {
    const r = Document.create({ userId: USER, kind: 'resume', title: 'My Resume' });
    if (!isOk(r)) throw new Error('setup failed');
    const v1 = r.value.addVersion({
      source: 'generated',
      content: resumeContent(),
      profileFactsHash: 'hash-a',
    });
    if (!isOk(v1)) throw new Error('setup failed');

    expect(v1.value.isStaleAgainst('hash-a')).toBe(false);
    expect(v1.value.isStaleAgainst('hash-b')).toBe(true);
  });

  it('a version with no recorded profileFactsHash is never flagged stale (nothing to compare against)', () => {
    const r = Document.create({ userId: USER, kind: 'resume', title: 'My Resume' });
    if (!isOk(r)) throw new Error('setup failed');
    const v1 = r.value.addVersion({ source: 'imported', content: resumeContent() });
    if (!isOk(v1)) throw new Error('setup failed');
    expect(v1.value.isStaleAgainst('anything')).toBe(false);
  });
});

describe('Document.assertOwnedBy', () => {
  it('permits the owner and forbids everyone else', () => {
    const r = Document.create({ userId: USER, kind: 'resume', title: 'My Resume' });
    if (!isOk(r)) throw new Error('setup failed');
    expect(isOk(r.value.assertOwnedBy(USER))).toBe(true);
    const denied = r.value.assertOwnedBy(OTHER);
    expect(isErr(denied)).toBe(true);
    if (isErr(denied)) expect(denied.error.code).toBe('forbidden');
  });
});

describe('Document snapshot round-trip', () => {
  it('survives toSnapshot -> fromSnapshot without loss, including versions', () => {
    const r = Document.create({ userId: USER, kind: 'resume', title: 'My Resume' });
    if (!isOk(r)) throw new Error('setup failed');
    const doc = r.value;
    doc.addVersion({ source: 'imported', content: resumeContent() });
    doc.addVersion({ source: 'edited', content: resumeContent({ summary: 'v2' }) });

    const restored = Document.fromSnapshot(doc.toSnapshot());
    expect(restored.toSnapshot()).toEqual(doc.toSnapshot());
    expect(restored.pullEvents()).toHaveLength(0);
  });
});
