import { describe, it, expect, beforeEach } from 'vitest';
import { withTestDb, resetTestDb } from './setup.js';
import { DrizzleUserRepository } from '../../src/db/repositories/user.repository.js';
import { DrizzleProfileRepository } from '../../src/db/repositories/profile.repository.js';
import { DrizzleDocumentRepository } from '../../src/db/repositories/document.repository.js';
import { DrizzleAuditPort } from '../../src/db/repositories/audit.repository.js';
import {
  User, Email, PasswordHash, CareerProfile, Document, isOk,
} from '@careerpilot/domain';
import type { ResumeDocumentContent } from '@careerpilot/domain';
import { sql } from 'drizzle-orm';

const email = (s: string) => {
  const r = Email.create(s);
  if (!isOk(r)) throw new Error('bad fixture');
  return r.value;
};
const hash = () => {
  const r = PasswordHash.fromHashed('$argon2id$v=19$m=65536,t=3,p=4$x$y');
  if (!isOk(r)) throw new Error('bad fixture');
  return r.value;
};
const resumeContent = (overrides?: Partial<ResumeDocumentContent>): ResumeDocumentContent => ({
  schemaVersion: 1,
  kind: 'resume',
  contact: { name: 'Ada Lovelace', email: 'ada@example.com' },
  summary: 'Engineer',
  sections: [],
  ...overrides,
});

describe('Migration 0002 — profile & document tables (REAL Postgres 16 + pgvector)', () => {
  it('creates the expected tables, extension, and generated tsvector column', async () => {
    await withTestDb(async (db) => {
      const tables = await db.execute(
        sql`SELECT table_name FROM information_schema.tables WHERE table_schema = 'public' AND table_name IN
          ('career_profiles', 'profile_sections', 'documents', 'document_versions')`,
      );
      expect(tables).toHaveLength(4);

      const ext = await db.execute(sql`SELECT extname FROM pg_extension WHERE extname = 'vector'`);
      expect(ext).toHaveLength(1);

      const generated = await db.execute(
        sql`SELECT is_generated FROM information_schema.columns
            WHERE table_name = 'profile_sections' AND column_name = 'content_tsv'`,
      );
      expect((generated as unknown as { is_generated: string }[])[0]!.is_generated).toBe('ALWAYS');
    });
  });
});

describe('Profile & Document repositories against REAL Postgres', () => {
  beforeEach(async () => {
    await withTestDb(async (db) => resetTestDb(db));
  });

  it('CareerProfile: create -> add section -> save -> read back with fidelity', async () => {
    await withTestDb(async (db) => {
      const users = new DrizzleUserRepository(db);
      const profiles = new DrizzleProfileRepository(db);
      const user = User.register({ email: email('profile@x.com'), passwordHash: hash() });
      await users.save(user);

      const created = CareerProfile.create({ userId: user.id, title: 'My Career', summary: 'A summary' });
      if (!isOk(created)) throw new Error('setup failed');
      const profile = created.value;
      profile.addSection({
        kind: 'experience',
        content: {
          schemaVersion: 1, title: 'Engineer', organization: 'Acme',
          startDate: '2020-01', endDate: null, bullets: ['Shipped things'],
        },
      });
      await profiles.save(profile);

      const found = await profiles.findByIdForUser(profile.id, user.id);
      expect(found).not.toBeNull();
      expect(found!.title).toBe('My Career');
      expect(found!.sections).toHaveLength(1);
      expect(found!.sections[0]!.kind).toBe('experience');
      expect(found!.factsHash).toBe(profile.factsHash);

      const active = await profiles.findActiveForUser(user.id);
      expect(active!.id).toBe(profile.id);
    });
  });

  it('CareerProfile: removeSection is reflected on the next save (full-set diff)', async () => {
    await withTestDb(async (db) => {
      const users = new DrizzleUserRepository(db);
      const profiles = new DrizzleProfileRepository(db);
      const user = User.register({ email: email('remove@x.com'), passwordHash: hash() });
      await users.save(user);

      const created = CareerProfile.create({ userId: user.id, title: 'My Career' });
      if (!isOk(created)) throw new Error('setup failed');
      const profile = created.value;
      const added = profile.addSection({
        kind: 'summary',
        content: { schemaVersion: 1, text: 'hello' },
      });
      if (!isOk(added)) throw new Error('setup failed');
      await profiles.save(profile);

      profile.removeSection(added.value.id);
      await profiles.save(profile);

      const found = await profiles.findByIdForUser(profile.id, user.id);
      expect(found!.sections).toHaveLength(0);
    });
  });

  it('CareerProfile: DB-level unique index rejects a second active profile for the same user', async () => {
    await withTestDb(async (db) => {
      const users = new DrizzleUserRepository(db);
      const profiles = new DrizzleProfileRepository(db);
      const user = User.register({ email: email('twoactive@x.com'), passwordHash: hash() });
      await users.save(user);

      const first = CareerProfile.create({ userId: user.id, title: 'First' });
      const second = CareerProfile.create({ userId: user.id, title: 'Second' });
      if (!isOk(first) || !isOk(second)) throw new Error('setup failed');

      await profiles.save(first.value);
      await expect(profiles.save(second.value)).rejects.toThrow();
    });
  });

  it('Document: create -> add two versions -> version 1 is immutable and version numbers are strict', async () => {
    await withTestDb(async (db) => {
      const users = new DrizzleUserRepository(db);
      const documents = new DrizzleDocumentRepository(db);
      const user = User.register({ email: email('doc@x.com'), passwordHash: hash() });
      await users.save(user);

      const created = Document.create({ userId: user.id, kind: 'resume', title: 'My Resume' });
      if (!isOk(created)) throw new Error('setup failed');
      const doc = created.value;

      const v1 = doc.addVersion({ source: 'imported', content: resumeContent({ summary: 'v1' }) });
      if (!isOk(v1)) throw new Error('setup failed');
      await documents.save(doc);

      const v2 = doc.addVersion({ source: 'edited', content: resumeContent({ summary: 'v2' }) });
      if (!isOk(v2)) throw new Error('setup failed');
      await documents.save(doc);

      const found = await documents.findByIdForUser(doc.id, user.id);
      expect(found!.versions).toHaveLength(2);
      expect(found!.versions.map((v) => v.version)).toEqual([1, 2]);
      expect((found!.versions[0]!.content as ResumeDocumentContent).summary).toBe('v1'); // untouched
      expect((found!.versions[1]!.content as ResumeDocumentContent).summary).toBe('v2');
      expect(found!.currentVersionId).toBe(v2.value.id);
    });
  });

  it('Document: the DB unique constraint rejects a duplicate (document_id, version) pair', async () => {
    await withTestDb(async (db) => {
      await resetTestDb(db);
      const users = new DrizzleUserRepository(db);
      const user = User.register({ email: email('dup@x.com'), passwordHash: hash() });
      await users.save(user);

      const created = Document.create({ userId: user.id, kind: 'resume', title: 'My Resume' });
      if (!isOk(created)) throw new Error('setup failed');
      const doc = created.value;

      await db.execute(
        sql`INSERT INTO documents (id, user_id, kind, title) VALUES (${doc.id}, ${user.id}, 'resume', 'My Resume')`,
      );
      await db.execute(
        sql`INSERT INTO document_versions (id, document_id, version, source, content)
            VALUES (${'018f0000-0000-7000-8000-000000000010'}, ${doc.id}, 1, 'imported', '{}'::jsonb)`,
      );
      await expect(
        db.execute(
          sql`INSERT INTO document_versions (id, document_id, version, source, content)
              VALUES (${'018f0000-0000-7000-8000-000000000011'}, ${doc.id}, 1, 'imported', '{}'::jsonb)`,
        ),
      ).rejects.toThrow();
    });
  });

  it('Document: soft delete persists deletedAt and is excluded from listForUser by default', async () => {
    await withTestDb(async (db) => {
      const users = new DrizzleUserRepository(db);
      const documents = new DrizzleDocumentRepository(db);
      const user = User.register({ email: email('softdel@x.com'), passwordHash: hash() });
      await users.save(user);

      const created = Document.create({ userId: user.id, kind: 'resume', title: 'My Resume' });
      if (!isOk(created)) throw new Error('setup failed');
      const doc = created.value;
      await documents.save(doc);

      doc.softDelete();
      await documents.save(doc);

      const active = await documents.listForUser(user.id);
      expect(active).toHaveLength(0);
      const all = await documents.listForUser(user.id, { includeDeleted: true });
      expect(all).toHaveLength(1);
      expect(all[0]!.deletedAt).not.toBeNull();
    });
  });

  it('Document: attachRenderedArtifact persists renderedPdfKey without ever UPDATE-ing content/version/createdAt', async () => {
    await withTestDb(async (db) => {
      const users = new DrizzleUserRepository(db);
      const documents = new DrizzleDocumentRepository(db);
      const user = User.register({ email: email('render@x.com'), passwordHash: hash() });
      await users.save(user);

      const created = Document.create({ userId: user.id, kind: 'resume', title: 'My Resume' });
      if (!isOk(created)) throw new Error('setup failed');
      const doc = created.value;
      const v1 = doc.addVersion({ source: 'generated', content: resumeContent() });
      if (!isOk(v1)) throw new Error('setup failed');
      await documents.save(doc);

      doc.attachRenderedArtifact(v1.value.id, 'documents/abc.pdf');
      await documents.save(doc);

      const found = await documents.findByIdForUser(doc.id, user.id);
      const version = found!.versions[0]!;
      expect(version.renderedPdfKey).toBe('documents/abc.pdf');
      expect(version.version).toBe(1);
      expect(version.content).toEqual(v1.value.content);
      expect(version.createdAt.getTime()).toBe(v1.value.createdAt.getTime());
    });
  });

  it('DrizzleAuditPort: writes a row into audit_log', async () => {
    await withTestDb(async (db) => {
      const users = new DrizzleUserRepository(db);
      const audit = new DrizzleAuditPort(db);
      const user = User.register({ email: email('audit@x.com'), passwordHash: hash() });
      await users.save(user);

      await audit.record({
        userId: user.id,
        action: 'document.version_created',
        subjectType: 'document',
        subjectId: '018f0000-0000-7000-8000-000000000099',
        detail: { version: 1 },
      });

      const rows = await db.execute(sql`SELECT action, subject_type FROM audit_log WHERE user_id = ${user.id}`);
      expect(rows).toHaveLength(1);
      expect((rows as unknown as { action: string }[])[0]!.action).toBe('document.version_created');
    });
  });
});
