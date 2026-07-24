#!/usr/bin/env tsx
/** Runs all three task 042 eval suites in sequence and prints one combined pass/fail summary. Individual runners can also be invoked directly (`pnpm run eval:matching`, etc.) — see README.md. */
import { runResumeImportEval } from './run-resume-import-eval.js';
import { runMatchingEval } from './run-matching-eval.js';
import { runTailoringEval } from './run-tailoring-eval.js';

async function main(): Promise<void> {
  const resumeImport = runResumeImportEval();

  let matching: { pass: boolean } | { pass: false; skipped: true; reason: string };
  let tailoring: { pass: boolean } | { pass: false; skipped: true; reason: string };
  try {
    matching = await runMatchingEval();
  } catch (e) {
    matching = { pass: false, skipped: true, reason: e instanceof Error ? e.message : String(e) };
  }
  try {
    tailoring = await runTailoringEval();
  } catch (e) {
    tailoring = { pass: false, skipped: true, reason: e instanceof Error ? e.message : String(e) };
  }

  console.log('\n\n=== Task 042 intelligence-evals summary ===');
  console.log(`resume-import: ${resumeImport.pass ? 'PASS' : 'FAIL'} (${resumeImport.overallAccuracyPct.toFixed(2)}%)`);
  console.log(`matching:      ${matching.pass ? 'PASS' : 'skipped' in matching ? `SKIPPED (${matching.reason})` : 'FAIL'}`);
  console.log(`tailoring:     ${tailoring.pass ? 'PASS' : 'skipped' in tailoring ? `SKIPPED (${tailoring.reason})` : 'FAIL'}`);

  const overallPass = resumeImport.pass && matching.pass && tailoring.pass;
  process.exitCode = overallPass ? 0 : 1;
}

main();
