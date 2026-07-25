#!/usr/bin/env tsx
/**
 * Task 050's golden-set eval: "form tree → expected taxonomy; regression
 * gate ≥95% on P0 fields" (docs/05-playwright-design.md §7). Runs the REAL
 * task 050 production code (`makeMapFieldsWithLlmUseCase`, unmodified)
 * against golden fixtures of fields deliberately chosen to be AMBIGUOUS —
 * the kind stages 1/2 (048 known-ATS, 049 heuristics) would leave
 * low-confidence, since that's the only case this stage is ever actually
 * invoked for in production (cheapest-first, task 050's own acceptance
 * criterion, proven separately in `map-fields.test.ts`).
 *
 * HONEST SCOPE NOTE — see this task's Status entry in tasks/050.md for the
 * full disclosure: this eval requires a REAL reachable chat-completion
 * endpoint (`assertLlmReachable()` below, same requirement as
 * `run-matching-eval.ts`/`run-tailoring-eval.ts`). In the sandbox this
 * milestone's work happened in, neither a local Ollama instance nor any
 * cloud endpoint was reachable (Docker Desktop's registry pulls
 * consistently failed DNS resolution against `registry-1.docker.io`, so a
 * fresh Ollama image/model could not even be provisioned) — this script
 * was written and is believed correct, but has NOT actually been run
 * end-to-end against a real model. Do not report a pass/fail number for
 * this gate without first re-running it for real.
 *
 * Golden-set size: 10 fixtures (not a large "hundreds of examples" set) —
 * each is hand-built to probe a genuinely distinct disambiguation
 * challenge (foreign-language labels, EEO-euphemism identification,
 * file-vs-file / URL-vs-URL disambiguation, decoy rejection). Documented
 * honestly rather than padded, same posture as task 049's corpus.
 */
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { isOk } from '@careerpilot/domain';
import { makeMapFieldsWithLlmUseCase } from '@careerpilot/application';
import type { SerializedFormField } from '@careerpilot/application';
import { buildLlmHarness, assertLlmReachable } from './harness.js';
import { writeTimestampedResult } from './results-writer.js';

const DIR = path.dirname(fileURLToPath(import.meta.url));
const FIXTURES_DIR = path.join(DIR, '../fixtures/field-mapper');

const P0_FIELD_KEYS = ['firstName', 'lastName', 'email', 'phone', 'resumeUpload'] as const;
const GATE_P0_ACCURACY = 0.95;

interface FieldMapperFixture {
  id: string;
  notes: string;
  profileFacts: string[];
  formFields: SerializedFormField[];
  expected: Record<string, string | null>;
}

function loadFixtures(): FieldMapperFixture[] {
  return readdirSync(FIXTURES_DIR)
    .filter((f) => f.endsWith('.json'))
    .sort()
    .map((f) => JSON.parse(readFileSync(path.join(FIXTURES_DIR, f), 'utf8')) as FieldMapperFixture);
}

export async function runFieldMapperEval(): Promise<{ pass: boolean }> {
  await assertLlmReachable();
  const { llm, prompts, model } = buildLlmHarness();
  const useCase = makeMapFieldsWithLlmUseCase({ llm, prompts, model });
  const fixtures = loadFixtures();

  let p0Total = 0;
  let p0Correct = 0;
  let allTotal = 0;
  let allCorrect = 0;
  const perFixture: unknown[] = [];

  for (const fixture of fixtures) {
    const result = await useCase({
      userId: '018f0000-0000-7000-8000-0000000000ee',
      applyTaskId: fixture.id,
      lowConfidenceFields: fixture.formFields, // every field in a fixture IS the "left unresolved" set, by fixture design
      profileFactsText: fixture.profileFacts.join('\n'),
      allowEssayDrafting: false,
    });

    if (!isOk(result)) {
      perFixture.push({ id: fixture.id, error: result.error });
      continue;
    }

    const gotBySelector = new Map(result.value.map((f) => [f.selector, f.taxonomyKey]));
    const rows: { selector: string; expected: string | null; got: string | null; correctP0: boolean | null }[] = [];

    for (const [selector, expected] of Object.entries(fixture.expected)) {
      const got = gotBySelector.get(selector) ?? null;
      const correct = got === expected;
      allTotal++;
      if (correct) allCorrect++;

      const isP0 = expected !== null && (P0_FIELD_KEYS as readonly string[]).includes(expected);
      if (isP0) {
        p0Total++;
        if (correct) p0Correct++;
      }
      rows.push({ selector, expected, got, correctP0: isP0 ? correct : null });
    }
    perFixture.push({ id: fixture.id, rows });
  }

  const p0Accuracy = p0Total > 0 ? p0Correct / p0Total : 1;
  const overallAccuracy = allTotal > 0 ? allCorrect / allTotal : 1;
  const pass = p0Accuracy >= GATE_P0_ACCURACY;

  const resultPath = writeTimestampedResult('field-mapper-eval', {
    gate: GATE_P0_ACCURACY, p0Accuracy, overallAccuracy, p0Total, p0Correct, allTotal, allCorrect, pass, perFixture,
  });

  console.log(
    `[field-mapper eval] P0 accuracy ${(p0Accuracy * 100).toFixed(1)}% (${p0Correct}/${p0Total}), ` +
      `overall ${(overallAccuracy * 100).toFixed(1)}% (${allCorrect}/${allTotal}) — gate ${(GATE_P0_ACCURACY * 100).toFixed(0)}% — ` +
      `${pass ? 'PASS' : 'FAIL'}. Results: ${resultPath}`,
  );

  return { pass };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  runFieldMapperEval()
    .then(({ pass }) => process.exit(pass ? 0 : 1))
    .catch((e: unknown) => {
      console.error(e);
      process.exit(1);
    });
}
