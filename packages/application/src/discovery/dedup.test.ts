import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { findDedupMatch, type DedupInput } from './dedup.js';
import type { DedupCandidate } from '../ports/repositories.js';

const CORPUS_PATH = path.join(path.dirname(fileURLToPath(import.meta.url)), 'test/fixtures/dedup-corpus.json');

interface CorpusPair {
  existing: { title: string; company: string; urlHash: string };
  incoming: { title: string; company: string; urlHash: string };
  isDuplicate: boolean;
  note: string;
}

const corpus = JSON.parse(readFileSync(CORPUS_PATH, 'utf8')) as { pairs: CorpusPair[] };

describe('findDedupMatch — unit behavior', () => {
  it('matches on exact urlHash regardless of title/company differences', () => {
    const candidates: DedupCandidate[] = [{ id: 'a', urlHash: 'h1', title: 'Anything', company: 'Anyco', dedupGroupId: null }];
    const input: DedupInput = { urlHash: 'h1', title: 'Completely Different Title', company: 'Different Co' };
    const decision = findDedupMatch(input, candidates);
    expect(decision.kind).toBe('exact');
    if (decision.kind !== 'unique') expect(decision.matchId).toBe('a');
  });

  it('never fuzzy-matches across different companies, however similar the title', () => {
    const candidates: DedupCandidate[] = [{ id: 'a', urlHash: 'h1', title: 'Software Engineer', company: 'Acme', dedupGroupId: null }];
    const input: DedupInput = { urlHash: 'h2', title: 'Software Engineer', company: 'Globex' };
    expect(findDedupMatch(input, candidates).kind).toBe('unique');
  });

  it('propagates an existing dedup_group_id rather than always using the matched row id', () => {
    const candidates: DedupCandidate[] = [{ id: 'a', urlHash: 'h1', title: 'X', company: 'Acme', dedupGroupId: 'group-99' }];
    const decision = findDedupMatch({ urlHash: 'h1', title: 'X', company: 'Acme' }, candidates);
    expect(decision.kind).toBe('exact');
    if (decision.kind !== 'unique') expect(decision.groupId).toBe('group-99');
  });

  it('picks the highest-scoring candidate when multiple fuzzy matches exceed the threshold', () => {
    const candidates: DedupCandidate[] = [
      { id: 'weaker', urlHash: null, title: 'Senior Backend Engineer Remote US', company: 'Acme', dedupGroupId: null },
      { id: 'stronger', urlHash: null, title: 'Senior Backend Engineer', company: 'Acme', dedupGroupId: null },
    ];
    const decision = findDedupMatch({ urlHash: null, title: 'Senior Backend Engineer', company: 'Acme' }, candidates);
    expect(decision.kind).toBe('fuzzy');
    if (decision.kind === 'fuzzy') expect(decision.matchId).toBe('stronger');
  });
});

/**
 * Task 029 acceptance: "Dedup precision ≥98% on a fixture corpus (roadmap
 * acceptance) — measured, not assumed; report the number." This test
 * actually computes precision = TP / (TP + FP) over
 * `test/fixtures/dedup-corpus.json` (30 hand-labeled pairs: 15 true
 * duplicates with realistic cross-source title/formatting variation, 15
 * true negatives including same-title-different-company and
 * same-company-different-role traps) and asserts the measured number, not
 * an assumed one.
 */
describe('Dedup precision — measured against the fixture corpus', () => {
  it('achieves >=98% precision, and the number is printed for the record', () => {
    let truePositives = 0;
    let falsePositives = 0;
    let truePositivesTotal = 0; // for recall reporting only — not gated by acceptance criteria
    const misclassified: string[] = [];

    for (const pair of corpus.pairs) {
      if (pair.isDuplicate) truePositivesTotal++;

      const candidates: DedupCandidate[] = [
        { id: 'existing', urlHash: pair.existing.urlHash, title: pair.existing.title, company: pair.existing.company, dedupGroupId: null },
      ];
      const input: DedupInput = { urlHash: pair.incoming.urlHash, title: pair.incoming.title, company: pair.incoming.company };
      const decision = findDedupMatch(input, candidates);
      const predictedDuplicate = decision.kind !== 'unique';

      if (predictedDuplicate && pair.isDuplicate) truePositives++;
      if (predictedDuplicate && !pair.isDuplicate) {
        falsePositives++;
        misclassified.push(`FALSE POSITIVE: "${pair.incoming.title}" vs "${pair.existing.title}" (${pair.note})`);
      }
    }

    const predictedPositives = truePositives + falsePositives;
    const precision = predictedPositives === 0 ? 1 : truePositives / predictedPositives;
    const recall = truePositivesTotal === 0 ? 1 : truePositives / truePositivesTotal;

    // Deliberate: this IS the measurement report task 029 asks to be recorded.
    console.log(
      `[dedup precision] corpus=${corpus.pairs.length} pairs, predicted_positive=${predictedPositives}, ` +
        `TP=${truePositives} FP=${falsePositives} precision=${(precision * 100).toFixed(1)}% recall=${(recall * 100).toFixed(1)}%`,
    );
    if (misclassified.length > 0) console.log(misclassified.join('\n'));

    expect(precision, `precision was ${(precision * 100).toFixed(1)}% — misclassified: ${misclassified.join('; ')}`).toBeGreaterThanOrEqual(0.98);
    // Sanity floor so this assertion can't trivially pass by predicting nothing.
    expect(predictedPositives).toBeGreaterThan(0);
  });
});
