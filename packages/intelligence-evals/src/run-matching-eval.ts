#!/usr/bin/env tsx
/**
 * Task 042's matching-quality eval: runs the REAL task 038 pipeline
 * (`makeScoreMatchUseCase`, unmodified production code) against golden
 * (profile, job posting) fixtures with a human-labeled `expectedOverall`
 * score, and reports how well the LLM rubric score's ordering agrees with
 * human judgment.
 *
 * METRIC CHOICE — Spearman rank correlation, not Pearson (see
 * `stats.ts`'s doc comment for the full reasoning): what the matching
 * feature needs to get right is RANKING candidates well (best fit surfaces
 * first), not hitting an absolute score on the same 0-1 scale a human would
 * pick. Spearman only cares about ordering agreement, so it isn't punished
 * by a systematic calibration offset between the model and the human
 * labeler. Pearson is still computed and reported for reference.
 *
 * GATE POSTURE (deliberately softer than the tailoring eval's hard 0
 * claims gate — documented here, not silently inconsistent): with a
 * 5-fixture golden set, a correlation coefficient is a noisy statistic —
 * one fixture flipping can swing it by a lot. This runner reports the
 * number and WARNS below `WARN_THRESHOLD`, but only FAILS the run (nonzero
 * exit) on an actual pipeline error (a candidate that should have scored
 * and didn't) or a correlation that's actually negative (the pipeline is
 * anti-correlated with human judgment — unambiguously broken, not just
 * "needs a bigger fixture set to be sure"). Expand the fixture set
 * (packages/intelligence-evals/fixtures/matching/) before tightening this
 * further.
 *
 * REQUIRES a reachable chat-completion + embeddings endpoint (real Ollama
 * by default) — see `harness.ts`'s `assertLlmReachable`.
 */
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  CareerProfile, JobPosting, newUserId, type ProfileSectionContent, type ProfileSectionKind,
  compileFactList,
} from '@careerpilot/domain';
import { makeScoreMatchUseCase } from '@careerpilot/application';
import { FakeProfileRepository, FakeJobPostingRepository, FakeMatchScoreRepository } from './fake-infra.js';
import { buildLlmHarness, assertLlmReachable } from './harness.js';
import { PINNED_EMBEDDING_MODEL } from './pinned-models.js';
import { pearsonCorrelation, spearmanCorrelation } from './stats.js';
import { writeTimestampedResult } from './results-writer.js';

const DIR = path.dirname(fileURLToPath(import.meta.url));
const FIXTURES_DIR = path.join(DIR, '../fixtures/matching');
const WARN_THRESHOLD = 0.6;

interface MatchingFixture {
  id: string;
  notes: string;
  expectedOverall: number;
  profile: { sections: { kind: ProfileSectionKind; content: ProfileSectionContent }[] };
  job: { title: string; company: string; descriptionMd: string };
}

function loadFixtures(): MatchingFixture[] {
  return readdirSync(FIXTURES_DIR)
    .filter((f) => f.endsWith('.json'))
    .sort()
    .map((f) => JSON.parse(readFileSync(path.join(FIXTURES_DIR, f), 'utf8')) as MatchingFixture);
}

function unwrap<T>(result: { ok: true; value: T } | { ok: false; error: unknown }, what: string): T {
  if (!result.ok) throw new Error(`${what} failed: ${JSON.stringify(result.error)}`);
  return result.value;
}

export async function runMatchingEval(): Promise<{ pass: boolean }> {
  await assertLlmReachable();
  const { llm, prompts, model } = buildLlmHarness();
  const fixtures = loadFixtures();

  const perFixture: { id: string; expected: number; actual: number | null; error: string | null; components: unknown }[] = [];

  for (const fixture of fixtures) {
    const userId = newUserId();

    const profile = unwrap(CareerProfile.create({ userId, title: `Eval profile ${fixture.id}` }), 'CareerProfile.create');
    for (const section of fixture.profile.sections) {
      unwrap(profile.addSection({ kind: section.kind, content: section.content }), `addSection(${section.kind})`);
    }

    const job = unwrap(
      JobPosting.createManual({ userId, title: fixture.job.title, company: fixture.job.company, descriptionMd: fixture.job.descriptionMd }),
      'JobPosting.createManual',
    );

    // Real embeddings (real nomic-embed-text call) so the ANN prefilter this
    // use case runs through is genuine, not a hand-set vector that would
    // trivially always "match."
    const facts = compileFactList(profile);
    const factsText = facts.map((f) => `${f.id}: ${f.text}`).join('\n');
    const profileEmbed = await llm.embed(
      { model: PINNED_EMBEDDING_MODEL, input: factsText },
      { userId, refId: profile.id, context: 'matching' },
    );
    if (!profileEmbed.ok) {
      perFixture.push({ id: fixture.id, expected: fixture.expectedOverall, actual: null, error: `profile embed: ${profileEmbed.error.message}`, components: null });
      continue;
    }
    unwrap(profile.attachEmbedding(profileEmbed.value.vector, PINNED_EMBEDDING_MODEL, profile.factsHash), 'attachEmbedding(profile)');

    const jobEmbed = await llm.embed(
      { model: PINNED_EMBEDDING_MODEL, input: `${job.title} ${job.company ?? ''} ${job.descriptionMd}` },
      { userId, refId: job.id, context: 'matching' },
    );
    if (!jobEmbed.ok) {
      perFixture.push({ id: fixture.id, expected: fixture.expectedOverall, actual: null, error: `job embed: ${jobEmbed.error.message}`, components: null });
      continue;
    }
    unwrap(job.attachEmbedding(jobEmbed.value.vector, PINNED_EMBEDDING_MODEL), 'attachEmbedding(job)');

    const profiles = new FakeProfileRepository();
    const jobPostings = new FakeJobPostingRepository();
    const matchScores = new FakeMatchScoreRepository();
    await profiles.save(profile);
    await jobPostings.save(job);

    const scoreMatch = makeScoreMatchUseCase({ profiles, jobPostings, matchScores, llm, prompts, model });
    const result = await scoreMatch({ profileId: profile.id, userId, limit: 5 });

    if (!result.ok) {
      perFixture.push({ id: fixture.id, expected: fixture.expectedOverall, actual: null, error: `scoreMatch: ${result.error.message}`, components: null });
      continue;
    }
    if (result.value.scored.length === 0) {
      const failureReason = result.value.failures[0]?.reason ?? 'no candidates scored, no failure reason recorded';
      perFixture.push({ id: fixture.id, expected: fixture.expectedOverall, actual: null, error: failureReason, components: null });
      continue;
    }

    const scored = result.value.scored[0]!;
    perFixture.push({ id: fixture.id, expected: fixture.expectedOverall, actual: scored.components.overall, error: null, components: scored.components });
    console.log(`${fixture.id}: expected=${fixture.expectedOverall.toFixed(2)} actual=${scored.components.overall.toFixed(2)} (rationale: ${scored.components.rationale.slice(0, 120)}...)`);
  }

  const clean = perFixture.filter((r): r is typeof r & { actual: number } => r.actual !== null);
  const errored = perFixture.filter((r) => r.actual === null);

  const pearson = pearsonCorrelation(clean.map((r) => r.expected), clean.map((r) => r.actual));
  const spearman = spearmanCorrelation(clean.map((r) => r.expected), clean.map((r) => r.actual));

  console.log('\nMatching eval (task 038 pipeline vs. human-labeled expected scores)');
  console.log('='.repeat(70));
  console.log(`Fixtures scored cleanly: ${clean.length}/${perFixture.length}`);
  if (errored.length > 0) {
    for (const e of errored) console.log(`  ERROR ${e.id}: ${e.error}`);
  }
  console.log(`Pearson correlation:  ${Number.isNaN(pearson) ? 'n/a' : pearson.toFixed(3)}`);
  console.log(`Spearman correlation: ${Number.isNaN(spearman) ? 'n/a' : spearman.toFixed(3)} (primary metric — see this file's doc comment)`);

  // Hard-fail only on a genuine pipeline break (a candidate errored) or an
  // unambiguously anti-correlated result — see this file's doc comment for
  // why the gate is this specific and not a stricter numeric floor.
  const pass = errored.length === 0 && !(spearman < 0);
  console.log(pass
    ? (spearman < WARN_THRESHOLD ? `PASS (with WARNING: Spearman ${spearman.toFixed(3)} below the ${WARN_THRESHOLD} informational threshold — expand the fixture set).` : 'PASS.')
    : 'FAIL.');

  const resultPath = writeTimestampedResult('matching', {
    generatedAt: new Date().toISOString(),
    model,
    embeddingModel: PINNED_EMBEDDING_MODEL,
    pearson: Number.isNaN(pearson) ? null : Number(pearson.toFixed(4)),
    spearman: Number.isNaN(spearman) ? null : Number(spearman.toFixed(4)),
    warnThreshold: WARN_THRESHOLD,
    pass,
    perFixture,
  });
  console.log(`Full report written to ${resultPath}`);

  return { pass };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  runMatchingEval()
    .then(({ pass }) => { process.exitCode = pass ? 0 : 1; })
    .catch((e) => { console.error(e); process.exitCode = 1; });
}
