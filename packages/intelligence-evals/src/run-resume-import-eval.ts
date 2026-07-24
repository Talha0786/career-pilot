#!/usr/bin/env tsx
/**
 * Task 042's first (and only fully LLM-free) eval: migrates task 023's
 * accuracy-benchmark logic from `docs/eval/resume-import-benchmark/score.ts`
 * verbatim (same field-by-field comparison against hand-labeled ground
 * truth, same 90% acceptance gate) into this package so all three M5
 * intelligence evals live in one first-class workspace package instead of
 * `docs/eval` (a bolt-on fixed up during the M3/M4 merge, per task 042's own
 * instruction: "give it a proper package.json from the start this time").
 * `docs/eval/resume-import-benchmark/` is left in place, untouched, as the
 * historical task-023 evidence trail; this is the new source of truth going
 * forward. Fixtures/labels are copied (not re-authored) from that directory
 * — same 12-resume corpus, same labels, no regression risk from a rewrite.
 *
 * No LLM involved (`mapResumeTextToDraft` is a pure heuristic mapper) — this
 * runner works identically with or without a reachable Ollama/cloud model.
 */
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { mapResumeTextToDraft, type ResumeImportDraft } from '@careerpilot/application';
import { writeTimestampedResult } from './results-writer.js';

const DIR = path.dirname(fileURLToPath(import.meta.url));
const FIXTURES_DIR = path.join(DIR, '../fixtures/resume-import/fixtures');
const LABELS_DIR = path.join(DIR, '../fixtures/resume-import/labels');
const THRESHOLD = 90;

type FieldValue = string | number | boolean | null;

interface FixtureLabel {
  id: string;
  notes?: string;
  fields: Record<string, FieldValue>;
}

function normalizeString(s: string): string {
  return s.trim().toLowerCase().replace(/\s+/g, ' ');
}

function normalizePhone(s: string): string {
  return s.replace(/\D/g, '');
}

/** Flattens the mapper's output into the same dotted-key shape the labels use — identical to the original `score.ts`. */
function flattenPrediction(draft: ResumeImportDraft): Record<string, FieldValue> {
  const out: Record<string, FieldValue> = {};

  out['contact.name'] = draft.contact.name.value;
  out['contact.email'] = draft.contact.email.value;
  out['contact.phone'] = draft.contact.phone.value;
  out['summary.present'] = draft.summary.value !== null;

  const byKind = {
    experience: draft.sections.filter((s) => s.kind === 'experience'),
    education: draft.sections.filter((s) => s.kind === 'education'),
    project: draft.sections.filter((s) => s.kind === 'project'),
    certification: draft.sections.filter((s) => s.kind === 'certification'),
    skill_group: draft.sections.filter((s) => s.kind === 'skill_group'),
  };

  out['experience.count'] = byKind.experience.length;
  byKind.experience.forEach((s, i) => {
    const c = s.content as { title: string; organization: string; startDate: string; bullets: readonly string[] };
    out[`experience.${i}.title`] = c.title;
    out[`experience.${i}.organization`] = c.organization;
    out[`experience.${i}.hasDates`] = c.startDate.length > 0;
    out[`experience.${i}.hasBullets`] = c.bullets.length > 0;
  });

  out['education.count'] = byKind.education.length;
  byKind.education.forEach((s, i) => {
    const c = s.content as { institution: string; credential: string };
    out[`education.${i}.institution`] = c.institution;
    out[`education.${i}.credential`] = c.credential;
  });

  out['project.count'] = byKind.project.length;
  byKind.project.forEach((s, i) => {
    const c = s.content as { name: string; bullets: readonly string[] };
    out[`project.${i}.name`] = c.name;
    out[`project.${i}.hasBullets`] = c.bullets.length > 0;
  });

  out['certification.count'] = byKind.certification.length;
  byKind.certification.forEach((s, i) => {
    const c = s.content as { name: string; issuer: string };
    out[`certification.${i}.name`] = c.name;
    out[`certification.${i}.issuer`] = c.issuer;
  });

  const skillCount = byKind.skill_group.reduce(
    (sum, s) => sum + (s.content as { skills: readonly string[] }).skills.length,
    0,
  );
  out['skills.actualCount'] = skillCount;

  return out;
}

function fieldMatches(fieldKey: string, expected: FieldValue, predicted: Record<string, FieldValue>): boolean {
  if (fieldKey === 'skills.count_min') {
    const actual = predicted['skills.actualCount'];
    return typeof actual === 'number' && typeof expected === 'number' && actual >= expected;
  }

  const actual = predicted[fieldKey];

  if (expected === null) return actual === null || actual === undefined;
  if (typeof expected === 'boolean') return actual === expected;
  if (typeof expected === 'number') return actual === expected;
  if (fieldKey.endsWith('.phone') && typeof expected === 'string') {
    return typeof actual === 'string' && normalizePhone(actual) === normalizePhone(expected);
  }
  if (typeof expected === 'string') {
    return typeof actual === 'string' && normalizeString(actual) === normalizeString(expected);
  }
  return false;
}

interface FixtureResult {
  id: string;
  total: number;
  passed: number;
  failures: { field: string; expected: FieldValue; actual: FieldValue | undefined }[];
}

function scoreFixture(label: FixtureLabel, text: string): FixtureResult {
  const draft = mapResumeTextToDraft(text);
  const predicted = flattenPrediction(draft);

  const failures: FixtureResult['failures'] = [];
  let passed = 0;
  const entries = Object.entries(label.fields);

  for (const [key, expected] of entries) {
    if (fieldMatches(key, expected, predicted)) {
      passed += 1;
    } else {
      const actual = key === 'skills.count_min' ? predicted['skills.actualCount'] : predicted[key];
      failures.push({ field: key, expected, actual });
    }
  }

  return { id: label.id, total: entries.length, passed, failures };
}

export function runResumeImportEval(): { pass: boolean; overallAccuracyPct: number } {
  const labelFiles = readdirSync(LABELS_DIR).filter((f) => f.endsWith('.json')).sort();
  const results: FixtureResult[] = [];

  for (const file of labelFiles) {
    const label = JSON.parse(readFileSync(path.join(LABELS_DIR, file), 'utf8')) as FixtureLabel;
    const fixturePath = path.join(FIXTURES_DIR, `${label.id}.txt`);
    const text = readFileSync(fixturePath, 'utf8');
    results.push(scoreFixture(label, text));
  }

  let totalFields = 0;
  let totalPassed = 0;

  console.log('\nResume import field-accuracy eval (task 023 gate, migrated by task 042)\n' + '='.repeat(70));
  for (const r of results) {
    totalFields += r.total;
    totalPassed += r.passed;
    const pct = ((r.passed / r.total) * 100).toFixed(1);
    console.log(`${r.id}: ${r.passed}/${r.total} (${pct}%)`);
    for (const f of r.failures) {
      console.log(`    MISS ${f.field}: expected ${JSON.stringify(f.expected)}, got ${JSON.stringify(f.actual)}`);
    }
  }

  const overallPct = (totalPassed / totalFields) * 100;
  console.log('='.repeat(70));
  console.log(`OVERALL: ${totalPassed}/${totalFields} fields correct = ${overallPct.toFixed(2)}%`);
  console.log(`Fixture corpus size: ${results.length}`);

  const pass = overallPct >= THRESHOLD;
  console.log(pass
    ? `PASS — meets the ${THRESHOLD}% acceptance gate.`
    : `BELOW GATE — ${THRESHOLD}% required, got ${overallPct.toFixed(2)}%.`);

  const resultPath = writeTimestampedResult('resume-import', {
    generatedAt: new Date().toISOString(),
    thresholdPct: THRESHOLD,
    overallAccuracyPct: Number(overallPct.toFixed(2)),
    pass,
    totalFields,
    totalPassed,
    fixtureCount: results.length,
    perFixture: results.map((r) => ({
      id: r.id,
      total: r.total,
      passed: r.passed,
      accuracyPct: Number(((r.passed / r.total) * 100).toFixed(1)),
      failures: r.failures,
    })),
  });
  console.log(`Full report written to ${resultPath}`);

  return { pass, overallAccuracyPct: overallPct };
}

// `import.meta.url === 'file://' + process.argv[1]` breaks on Windows
// (backslash path vs. percent-encoded file: URL) — compare resolved
// filesystem paths instead, the cross-platform-safe "is this the entry
// module" check.
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const { pass } = runResumeImportEval();
  process.exitCode = pass ? 0 : 1;
}
