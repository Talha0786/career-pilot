import type { McpRegistry } from '../registry.js';
import { loadMcpPromptFile, renderMcpPrompt } from './loader.js';

/** Task 059 §4: `weekly_review`, `job_triage`. Loaded once at registration time — same "prompt files, not code" posture as the LLM-pipeline convention, just a different directory/purpose (see loader.ts's doc comment). */
export function registerAllPrompts(registry: McpRegistry): void {
  const weeklyReview = loadMcpPromptFile('weekly_review.md');
  registry.registerPrompt({
    name: 'weekly_review',
    description: "Summarize the caller's job-search pipeline for the week and flag stale applications.",
    render: (args) => renderMcpPrompt(weeklyReview.body, { user_name: 'there', ...args }),
  });

  const jobTriage = loadMcpPromptFile('job_triage.md');
  registry.registerPrompt({
    name: 'job_triage',
    description: 'Batch-evaluate newly discovered job matches and recommend pursue/watch/skip.',
    render: (args) => renderMcpPrompt(jobTriage.body, { user_name: 'there', since: '7 days ago', ...args }),
  });
}
