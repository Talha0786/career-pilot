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

/** A clean task 040 claim audit for the single bullet in VALID_RESUME_JSON — independently maps it to F1. */
const CLEAN_AUDIT_JSON = JSON.stringify({
  claims: [{ text: 'Led migration of X', factId: 'F1', confidence: 0.9 }],
});

/** An audit that finds the claim UNSUPPORTED — used for the retry/needs_human tests. */
const UNSUPPORTED_AUDIT_JSON = JSON.stringify({
  claims: [{ text: 'Led migration of X', factId: null, confidence: 0.1 }],
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
  prompts.register('verify-claims', 'Audit against:\n{{fact_list}}\n\nDraft:\n{{draft_text}}');
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

describe('tailorDocument — generation + structural gate (task 039) + adversarial claim verification (task 040)', () => {
  it('produces a resume version that validates against the M3 ResumeDocumentContentSchema, with profileFactsHash set, when the claim audit comes back clean on the first try', async () => {
    const { uow, profiles, jobPostings, users, inner, tailorDocument } = setup();
    await seedUser(users);
    const profile = await seedProfileWithFacts(profiles);
    const job = await seedJob(jobPostings);
    const doc = await seedDocument(uow, 'resume');
    inner.queueResponses(VALID_RESUME_JSON, CLEAN_AUDIT_JSON);

    const result = await tailorDocument({
      documentId: doc.id, profileId: profile.id, jobPostingId: job.id, userId: USER, kind: 'resume',
    });
    expect(isOk(result)).toBe(true);
    if (!isOk(result)) return;

    expect(result.value.structurallyUnsupported).toHaveLength(0);
    expect(result.value.needsHumanReview).toBe(false);
    expect(result.value.flaggedClaims).toHaveLength(0);
    expect(inner.completeCalls).toHaveLength(2); // 1 generation + 1 audit, no retries needed

    const stored = await uow.documents.findByIdForUser(doc.id, USER);
    const version = stored!.currentVersion!;
    expect(version.source).toBe('generated');
    expect(version.profileFactsHash).toBe(profile.factsHash);
    expect(version.needsHumanReview).toBe(false);
    expect(version.content.kind).toBe('resume');
    expect(version.content).toMatchObject({
      schemaVersion: 1,
      kind: 'resume',
      contact: { name: 'Ada', email: 'ada@example.com' },
      summary: 'Backend engineer with API experience.',
    });
  });

  it('STRUCTURAL GATE (task 039): a bullet with an EMPTY supportingFactIds is flagged unsupported by the cheap gate independently of what the adversarial audit finds', async () => {
    const { uow, profiles, jobPostings, users, inner, tailorDocument } = setup();
    await seedUser(users);
    const profile = await seedProfileWithFacts(profiles);
    const job = await seedJob(jobPostings);
    const doc = await seedDocument(uow, 'resume');

    const badJson = JSON.stringify({
      summary: null,
      sections: [{
        heading: 'Experience',
        entries: [{ title: 'X', subtitle: 'Y', dateRange: null, bullets: [{ text: 'Led migration of X', supportingFactIds: [] }] }],
      }],
    });
    // The draft's OWN citation is empty (structural gate fails it), but the
    // independent adversarial audit finds real support — proving the two
    // gates are genuinely independent checks, not the same thing twice.
    inner.queueResponses(badJson, CLEAN_AUDIT_JSON);

    const result = await tailorDocument({
      documentId: doc.id, profileId: profile.id, jobPostingId: job.id, userId: USER, kind: 'resume',
    });
    expect(isOk(result)).toBe(true);
    if (!isOk(result)) return;
    expect(result.value.structurallyUnsupported).toEqual(['Led migration of X']);
    expect(result.value.needsHumanReview).toBe(false); // adversarial audit was clean
  });

  it('STRUCTURAL GATE (task 039): a bullet citing a HALLUCINATED fact id is flagged, and the hallucinated id is stripped from the persisted content — never trusted from the LLM', async () => {
    const { uow, profiles, jobPostings, users, inner, tailorDocument } = setup();
    await seedUser(users);
    const profile = await seedProfileWithFacts(profiles); // only produces F1
    const job = await seedJob(jobPostings);
    const doc = await seedDocument(uow, 'resume');

    const hallucinatedJson = JSON.stringify({
      summary: null,
      sections: [{
        heading: 'Experience',
        entries: [{ title: 'X', subtitle: 'Y', dateRange: null, bullets: [{ text: 'Led migration of X', supportingFactIds: ['F99'] }] }],
      }],
    });
    inner.queueResponses(hallucinatedJson, CLEAN_AUDIT_JSON);

    const result = await tailorDocument({
      documentId: doc.id, profileId: profile.id, jobPostingId: job.id, userId: USER, kind: 'resume',
    });
    expect(isOk(result)).toBe(true);
    if (!isOk(result)) return;
    expect(result.value.structurallyUnsupported).toEqual(['Led migration of X']);

    const stored = await uow.documents.findByIdForUser(doc.id, USER);
    const content = stored!.currentVersion!.content as unknown as { sections: { entries: { bulletFacts: { supportingFactIds: string[] }[] }[] }[] };
    expect(content.sections[0]!.entries[0]!.bulletFacts[0]!.supportingFactIds).toEqual([]);
  });

  it('cover letter: a purely transitional paragraph is never sent to the auditor as a claim, and a supported paragraph verifies cleanly', async () => {
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
    // The auditor's prompt (task 040) instructs it to OMIT transitional
    // sentences entirely — only the one real claim comes back.
    const auditJson = JSON.stringify({
      claims: [{ text: 'I led a migration effort at Acme.', factId: 'F1', confidence: 0.85 }],
    });
    inner.queueResponses(coverLetterJson, auditJson);

    const result = await tailorDocument({
      documentId: doc.id, profileId: profile.id, jobPostingId: job.id, userId: USER, kind: 'cover_letter',
    });
    expect(isOk(result)).toBe(true);
    if (!isOk(result)) return;
    expect(result.value.structurallyUnsupported).toHaveLength(0);
    expect(result.value.needsHumanReview).toBe(false);

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

  it('malformed generation JSON triggers exactly one repair retry, then a typed failure — no crash, nothing persisted, audit never called', async () => {
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
    expect(inner.completeCalls).toHaveLength(2); // generation + its 1 repair — never reached the audit call

    const stored = await uow.documents.findByIdForUser(doc.id, USER);
    expect(stored!.versions).toHaveLength(0); // nothing persisted on failure
  });

  it('generation repair succeeds: first response malformed, second (repaired) valid, then a clean audit — persists successfully', async () => {
    const { uow, profiles, jobPostings, users, inner, tailorDocument } = setup();
    await seedUser(users);
    const profile = await seedProfileWithFacts(profiles);
    const job = await seedJob(jobPostings);
    const doc = await seedDocument(uow, 'resume');
    inner.queueResponses('garbage', VALID_RESUME_JSON, CLEAN_AUDIT_JSON);

    const result = await tailorDocument({
      documentId: doc.id, profileId: profile.id, jobPostingId: job.id, userId: USER, kind: 'resume',
    });
    expect(isOk(result)).toBe(true);
    expect(inner.completeCalls).toHaveLength(3);
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
    inner.queueResponses(VALID_RESUME_JSON, CLEAN_AUDIT_JSON);

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

describe('tailorDocument — task 040 adversarial retry loop and the needs_human hard stop', () => {
  it('unsupported claim on attempt 1 -> regenerates WITH the unsupported claim fed back as a hint -> clean on attempt 2 -> succeeds, needsHumanReview stays false', async () => {
    const { uow, profiles, jobPostings, users, inner, tailorDocument } = setup();
    await seedUser(users);
    const profile = await seedProfileWithFacts(profiles);
    const job = await seedJob(jobPostings);
    const doc = await seedDocument(uow, 'resume');

    // Attempt 1: generation, then an UNSUPPORTED audit.
    // Attempt 2 (1st retry): generation again, then a CLEAN audit.
    inner.queueResponses(VALID_RESUME_JSON, UNSUPPORTED_AUDIT_JSON, VALID_RESUME_JSON, CLEAN_AUDIT_JSON);

    const result = await tailorDocument({
      documentId: doc.id, profileId: profile.id, jobPostingId: job.id, userId: USER, kind: 'resume',
    });
    expect(isOk(result)).toBe(true);
    if (!isOk(result)) return;
    expect(result.value.needsHumanReview).toBe(false);
    expect(result.value.flaggedClaims).toHaveLength(0);
    expect(inner.completeCalls).toHaveLength(4); // 2 generations + 2 audits — exactly one retry, not more

    // The regeneration prompt actually included the "avoid this" hint —
    // proving the feedback loop is real, not just a re-roll.
    const secondGenerationPrompt = inner.completeCalls[2]!.prompt;
    expect(secondGenerationPrompt).toContain('Led migration of X');
    expect(secondGenerationPrompt.toLowerCase()).toContain('could not verify');

    const stored = await uow.documents.findByIdForUser(doc.id, USER);
    expect(stored!.versions).toHaveLength(1); // only the FINAL accepted attempt is persisted, not every intermediate try
  });

  it('THE HARD STOP: an audit that is ALWAYS unsupported terminates after exactly 2 retries (3 generations, 3 audits) and persists needs_human:true — proves it does not loop forever', async () => {
    const { uow, profiles, jobPostings, users, inner, tailorDocument } = setup();
    await seedUser(users);
    const profile = await seedProfileWithFacts(profiles);
    const job = await seedJob(jobPostings);
    const doc = await seedDocument(uow, 'resume');

    // Every single audit call returns unsupported — a fake LLM that NEVER
    // agrees the draft is clean, exactly the adversarial case the task
    // asks to be proven against.
    inner.queueResponses(
      VALID_RESUME_JSON, UNSUPPORTED_AUDIT_JSON,
      VALID_RESUME_JSON, UNSUPPORTED_AUDIT_JSON,
      VALID_RESUME_JSON, UNSUPPORTED_AUDIT_JSON,
    );

    const result = await tailorDocument({
      documentId: doc.id, profileId: profile.id, jobPostingId: job.id, userId: USER, kind: 'resume',
    });
    expect(isOk(result)).toBe(true); // NOT a crash/hang — a successful "flagged for review" outcome
    if (!isOk(result)) return;

    expect(result.value.needsHumanReview).toBe(true);
    expect(result.value.flaggedClaims).toEqual([{ text: 'Led migration of X', confidence: 0.1 }]);

    // Exactly 3 generation attempts (1 initial + 2 retries) and 3 audits —
    // the retry budget is a hard, exact cap, not "eventually gives up".
    expect(inner.completeCalls).toHaveLength(6);

    const stored = await uow.documents.findByIdForUser(doc.id, USER);
    const version = stored!.currentVersion!;
    expect(version.needsHumanReview).toBe(true);
    expect(version.isExportable()).toBe(false);
    expect(version.flaggedClaims).toEqual([{ text: 'Led migration of X', confidence: 0.1 }]);
  });

  it('a verify-claims LLM/provider failure is surfaced, not silently treated as "clean" (never trust silence as safety)', async () => {
    const { uow, profiles, jobPostings, users } = setup();
    await seedUser(users);
    const profile = await seedProfileWithFacts(profiles);
    const job = await seedJob(jobPostings);
    const doc = await seedDocument(uow, 'resume');

    // A custom LlmPort whose embed() is unused and whose complete() succeeds
    // for the generation call but fails outright for the audit call —
    // proves a genuine provider error during verification propagates as a
    // failure rather than defaulting to "no unsupported claims found."
    const failingAuditLlm: LlmPort = {
      embed: async () => { throw new Error('not used'); },
      complete: async (req) => {
        if (req.prompt.includes('Audit against:')) {
          return { ok: false, error: { code: 'provider_unavailable', message: 'audit provider down' } };
        }
        return { ok: true, value: { text: VALID_RESUME_JSON, model: req.model, promptTokens: 10, completionTokens: 10 } };
      },
    };
    const store = new InMemoryBudgetStore();
    const guarded = new GuardedLlmPort(failingAuditLlm, store, new FakeCostEstimator(), 100, 'fake');
    const prompts = new FakePromptStore();
    prompts.register('tailor-resume', 'Tailor for {{job_title}} at {{job_company}}:\n{{profile_facts}}\n{{job_description}}');
    prompts.register('verify-claims', 'Audit against:\n{{fact_list}}\n\nDraft:\n{{draft_text}}');
    const tailorDocumentWithFailingAudit = makeTailorDocumentUseCase({
      uow, profiles, jobPostings, users, llm: guarded, prompts, model: 'test-model',
    });

    const result = await tailorDocumentWithFailingAudit({
      documentId: doc.id, profileId: profile.id, jobPostingId: job.id, userId: USER, kind: 'resume',
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('provider_unavailable');

    const stored = await uow.documents.findByIdForUser(doc.id, USER);
    expect(stored!.versions).toHaveLength(0); // never persisted as if it were clean
  });
});
