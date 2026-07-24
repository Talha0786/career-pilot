import { describe, it, expect } from 'vitest';
import {
  CareerProfile, JobPosting, Document, User, asUserId, isOk,
} from '@careerpilot/domain';
import type { LlmPort, CompleteRequest, CompleteResponse, LlmError, EmbedResponse } from '../../src/ports/llm.port.js';
import type { Result } from '@careerpilot/domain';
import { makeTailorDocumentUseCase } from '../../src/tailoring/commands/tailor-document.js';
import { GuardedLlmPort } from '../../src/ports/budget-guard.js';
import { FakeUnitOfWork, FakeProfileRepository, FakeJobPostingRepository, FakeUserRepository } from '../fake-repos.js';
import { InMemoryBudgetStore, FakeCostEstimator, FakePromptStore } from '../fakes.js';

// NOTE: this package (@careerpilot/application) deliberately has no
// dependency on @careerpilot/contracts (Clean Architecture boundary — see
// score-match.ts's doc comment for the same reasoning), so these unit
// tests assert shape structurally rather than importing the contracts
// package's zod schemas. Cross-package schema conformance (the persisted
// content actually validates against ResumeDocumentContentSchema) is
// exercised in apps/api's integration tests, which DO depend on contracts.

const USER = asUserId('018f0000-0000-7000-8000-000000000001');

class ScriptedLlmPort implements LlmPort {
  public completeCalls: CompleteRequest[] = [];
  private queue: string[] = [];
  queueResponses(...texts: string[]): void { this.queue.push(...texts); }
  async embed(): Promise<Result<EmbedResponse, LlmError>> { throw new Error('not used'); }
  async complete(req: CompleteRequest): Promise<Result<CompleteResponse, LlmError>> {
    this.completeCalls.push(req);
    const text = this.queue.shift();
    if (text === undefined) throw new Error('ScriptedLlmPort: no more queued responses');
    return { ok: true, value: { text, model: req.model, promptTokens: 10, completionTokens: 10 } };
  }
}

const VALID_RESUME_JSON = JSON.stringify({
  summary: 'Backend engineer with API experience.',
  sections: [
    {
      heading: 'Experience',
      entries: [
        {
          title: 'Senior Engineer', subtitle: 'Acme', dateRange: '2021-2023',
          bullets: [{ text: 'Led migration of X', supportingFactIds: ['F1'] }],
        },
      ],
    },
  ],
});

function setup(budgetUsd = 100) {
  const uow = new FakeUnitOfWork();
  const jobPostings = new FakeJobPostingRepository();
  const users = new FakeUserRepository();
  const inner = new ScriptedLlmPort();
  const store = new InMemoryBudgetStore();
  const guarded = new GuardedLlmPort(inner, store, new FakeCostEstimator(), budgetUsd, 'fake');
  const prompts = new FakePromptStore();
  prompts.register('tailor-resume', 'Tailor for {{job_title}} at {{job_company}}:\n{{profile_facts}}\n{{job_description}}');
  prompts.register('tailor-cover-letter', 'Tailor letter for {{job_title}} at {{job_company}}:\n{{profile_facts}}\n{{job_description}}');
  const tailorDocument = makeTailorDocumentUseCase({
    uow, profiles: uow.profiles, jobPostings, users, llm: guarded, prompts, model: 'test-model',
  });
  return { uow, profiles: uow.profiles, jobPostings, users, inner, tailorDocument };
}

async function seedUser(users: FakeUserRepository, email = 'ada@example.com') {
  // Fixed id = USER (via fromSnapshot, not register's auto-generated id) —
  // every other fixture in this file (profile/job/document) is created
  // with `userId: USER` directly, so the User aggregate's OWN id must match
  // that same constant for `deps.users.findById(USER)` to resolve.
  const created = User.fromSnapshot({
    id: USER, email, passwordHash: '$argon2id$v=19$m=65536,t=3,p=4$x$y', role: 'owner', createdAt: new Date(),
  });
  if (!isOk(created)) throw new Error('bad fixture');
  await users.save(created.value);
  return created.value;
}

async function seedProfileWithFacts(profiles: FakeProfileRepository) {
  const created = CareerProfile.create({ userId: USER, title: 'Profile' });
  if (!isOk(created)) throw new Error('setup failed');
  const profile = created.value;
  const added = profile.addSection({
    kind: 'experience',
    content: { schemaVersion: 1, title: 'Senior Engineer', organization: 'Acme', startDate: '2021-01', endDate: '2023-06', bullets: ['Led migration of X'] },
  });
  if (!isOk(added)) throw new Error('setup failed');
  await profiles.save(profile);
  return profile;
}

async function seedJob(jobPostings: FakeJobPostingRepository, title = 'Backend Engineer') {
  const created = JobPosting.createManual({ userId: USER, title, descriptionMd: 'Build APIs.' });
  if (!isOk(created)) throw new Error('setup failed');
  await jobPostings.save(created.value);
  return created.value;
}

async function seedDocument(uow: FakeUnitOfWork, kind: 'resume' | 'cover_letter' = 'resume') {
  const created = Document.create({ userId: USER, kind, title: 'My Resume' });
  if (!isOk(created)) throw new Error('setup failed');
  await uow.documents.save(created.value);
  return created.value;
}

describe('tailorDocument — the anti-hallucination structural gate (task 039)', () => {
  it('produces a resume version that validates against the M3 ResumeDocumentContentSchema, with profileFactsHash set from the exact facts used', async () => {
    const { uow, profiles, jobPostings, users, inner, tailorDocument } = setup();
    await seedUser(users);
    const profile = await seedProfileWithFacts(profiles);
    const job = await seedJob(jobPostings);
    const doc = await seedDocument(uow, 'resume');
    inner.queueResponses(VALID_RESUME_JSON);

    const result = await tailorDocument({
      documentId: doc.id, profileId: profile.id, jobPostingId: job.id, userId: USER, kind: 'resume',
    });
    expect(isOk(result)).toBe(true);
    if (!isOk(result)) return;

    expect(result.value.structurallyUnsupported).toHaveLength(0);

    const stored = await uow.documents.findByIdForUser(doc.id, USER);
    const version = stored!.currentVersion!;
    expect(version.source).toBe('generated');
    expect(version.profileFactsHash).toBe(profile.factsHash);
    expect(version.content.kind).toBe('resume');
    expect(version.content).toMatchObject({
      schemaVersion: 1,
      kind: 'resume',
      contact: { name: 'Ada', email: 'ada@example.com' },
      summary: 'Backend engineer with API experience.',
    });
  });

  it('STRUCTURAL GATE: a bullet with an EMPTY supportingFactIds is flagged unsupported and persisted with empty ids, not trusted as-is', async () => {
    const { uow, profiles, jobPostings, users, inner, tailorDocument } = setup();
    await seedUser(users);
    const profile = await seedProfileWithFacts(profiles);
    const job = await seedJob(jobPostings);
    const doc = await seedDocument(uow, 'resume');

    const badJson = JSON.stringify({
      summary: null,
      sections: [{
        heading: 'Experience',
        entries: [{ title: 'X', subtitle: 'Y', dateRange: null, bullets: [{ text: 'Unsupported claim', supportingFactIds: [] }] }],
      }],
    });
    inner.queueResponses(badJson);

    const result = await tailorDocument({
      documentId: doc.id, profileId: profile.id, jobPostingId: job.id, userId: USER, kind: 'resume',
    });
    expect(isOk(result)).toBe(true);
    if (!isOk(result)) return;
    expect(result.value.structurallyUnsupported).toEqual(['Unsupported claim']);
  });

  it('STRUCTURAL GATE: a bullet citing a HALLUCINATED fact id (not in the real fact list) is flagged unsupported, and the hallucinated id is stripped from the persisted content — never trusted from the LLM', async () => {
    const { uow, profiles, jobPostings, users, inner, tailorDocument } = setup();
    await seedUser(users);
    const profile = await seedProfileWithFacts(profiles); // only produces F1
    const job = await seedJob(jobPostings);
    const doc = await seedDocument(uow, 'resume');

    const hallucinatedJson = JSON.stringify({
      summary: null,
      sections: [{
        heading: 'Experience',
        entries: [{ title: 'X', subtitle: 'Y', dateRange: null, bullets: [{ text: 'Has a PMP certification', supportingFactIds: ['F99'] }] }],
      }],
    });
    inner.queueResponses(hallucinatedJson);

    const result = await tailorDocument({
      documentId: doc.id, profileId: profile.id, jobPostingId: job.id, userId: USER, kind: 'resume',
    });
    expect(isOk(result)).toBe(true);
    if (!isOk(result)) return;
    expect(result.value.structurallyUnsupported).toEqual(['Has a PMP certification']);

    const stored = await uow.documents.findByIdForUser(doc.id, USER);
    const content = stored!.currentVersion!.content as unknown as { sections: { entries: { bulletFacts: { supportingFactIds: string[] }[] }[] }[] };
    // The hallucinated "F99" must NEVER appear in what's persisted — this is
    // the "checked structurally in code, not just trusted from the LLM" acceptance criterion.
    expect(content.sections[0]!.entries[0]!.bulletFacts[0]!.supportingFactIds).toEqual([]);
  });

  it('cover letter: a purely transitional paragraph with EMPTY supportingFactIds is fine (not flagged) — only content-asserting paragraphs must cite', async () => {
    const { uow, profiles, jobPostings, users, inner, tailorDocument } = setup();
    await seedUser(users);
    const profile = await seedProfileWithFacts(profiles);
    const job = await seedJob(jobPostings);
    const doc = await seedDocument(uow, 'cover_letter');

    const coverLetterJson = JSON.stringify({
      salutation: 'Dear Hiring Manager,',
      bodyParagraphs: [
        { text: 'I led a migration effort at Acme.', supportingFactIds: ['F1'] },
        { text: 'I would welcome the opportunity to discuss further.', supportingFactIds: [] },
      ],
      closing: 'Sincerely,',
    });
    inner.queueResponses(coverLetterJson);

    const result = await tailorDocument({
      documentId: doc.id, profileId: profile.id, jobPostingId: job.id, userId: USER, kind: 'cover_letter',
    });
    expect(isOk(result)).toBe(true);
    if (!isOk(result)) return;
    expect(result.value.structurallyUnsupported).toHaveLength(0);

    const stored = await uow.documents.findByIdForUser(doc.id, USER);
    const content = stored!.currentVersion!.content;
    expect(content.kind).toBe('cover_letter');
    expect(content).toMatchObject({
      schemaVersion: 1,
      kind: 'cover_letter',
      salutation: 'Dear Hiring Manager,',
      closing: 'Sincerely,',
      bodyParagraphs: [
        'I led a migration effort at Acme.',
        'I would welcome the opportunity to discuss further.',
      ],
    });
  });

  it('malformed JSON triggers exactly one repair retry, then a typed failure — no crash, nothing persisted', async () => {
    const { uow, profiles, jobPostings, users, inner, tailorDocument } = setup();
    await seedUser(users);
    const profile = await seedProfileWithFacts(profiles);
    const job = await seedJob(jobPostings);
    const doc = await seedDocument(uow, 'resume');
    inner.queueResponses('not json at all', 'still garbage {"summary": 123}');

    const result = await tailorDocument({
      documentId: doc.id, profileId: profile.id, jobPostingId: job.id, userId: USER, kind: 'resume',
    });
    expect(result.ok).toBe(false);
    expect(inner.completeCalls).toHaveLength(2);

    const stored = await uow.documents.findByIdForUser(doc.id, USER);
    expect(stored!.versions).toHaveLength(0); // nothing persisted on failure
  });

  it('repair succeeds: first response malformed, second (repaired) valid — persists successfully', async () => {
    const { uow, profiles, jobPostings, users, inner, tailorDocument } = setup();
    await seedUser(users);
    const profile = await seedProfileWithFacts(profiles);
    const job = await seedJob(jobPostings);
    const doc = await seedDocument(uow, 'resume');
    inner.queueResponses('garbage', VALID_RESUME_JSON);

    const result = await tailorDocument({
      documentId: doc.id, profileId: profile.id, jobPostingId: job.id, userId: USER, kind: 'resume',
    });
    expect(isOk(result)).toBe(true);
    expect(inner.completeCalls).toHaveLength(2);
  });

  it('returns not_found when the profile does not exist', async () => {
    const { uow, jobPostings, users, tailorDocument } = setup();
    await seedUser(users);
    const job = await seedJob(jobPostings);
    const doc = await seedDocument(uow, 'resume');

    const result = await tailorDocument({
      documentId: doc.id, profileId: '018f0000-0000-7000-8000-0000000000ff', jobPostingId: job.id, userId: USER, kind: 'resume',
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('not_found');
  });

  it('returns validation_failed when the profile has no sections (no facts to tailor from)', async () => {
    const { uow, profiles, jobPostings, users, tailorDocument } = setup();
    await seedUser(users);
    const created = CareerProfile.create({ userId: USER, title: 'Empty' });
    if (!isOk(created)) throw new Error('setup failed');
    await profiles.save(created.value);
    const job = await seedJob(jobPostings);
    const doc = await seedDocument(uow, 'resume');

    const result = await tailorDocument({
      documentId: doc.id, profileId: created.value.id, jobPostingId: job.id, userId: USER, kind: 'resume',
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('validation_failed');
  });

  it("contact info is populated from the User's real email (never hallucinated by the LLM, which is never asked for it)", async () => {
    const { uow, profiles, jobPostings, users, inner, tailorDocument } = setup();
    await seedUser(users, 'jane.doe@example.com');
    const profile = await seedProfileWithFacts(profiles);
    const job = await seedJob(jobPostings);
    const doc = await seedDocument(uow, 'resume');
    inner.queueResponses(VALID_RESUME_JSON);

    const result = await tailorDocument({
      documentId: doc.id, profileId: profile.id, jobPostingId: job.id, userId: USER, kind: 'resume',
    });
    expect(isOk(result)).toBe(true);

    const stored = await uow.documents.findByIdForUser(doc.id, USER);
    const content = stored!.currentVersion!.content as unknown as { contact: { name: string; email: string } };
    expect(content.contact.email).toBe('jane.doe@example.com');
    expect(content.contact.name).toBe('Jane Doe');
  });
});
