import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * `packages/intelligence-evals/results/` (gitignored — see `.gitignore`'s
 * task 042 note) is where every runner in this package writes its
 * timestamped JSON output. Deliberately NOT a single checked-in
 * `results.json` that accumulates diffs over time (unlike
 * `docs/eval/resume-import-benchmark/results.json`, which this package's
 * `run-resume-import-eval.ts` intentionally does NOT continue writing to,
 * per this task's own instruction) — each run gets its own timestamped
 * file, and CI/local callers read the latest one or attach it as a build
 * artifact.
 */
const RESULTS_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '../results');

export function writeTimestampedResult(runName: string, data: unknown): string {
  mkdirSync(RESULTS_DIR, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const filePath = path.join(RESULTS_DIR, `${runName}-${stamp}.json`);
  writeFileSync(filePath, JSON.stringify(data, null, 2) + '\n');
  return filePath;
}
