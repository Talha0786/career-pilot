import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { describe, it, expect } from 'vitest';
import { isOk, isErr } from '@careerpilot/domain';
import { PromptRenderError } from '@careerpilot/application';
import { FilePromptStore } from '../../src/prompts/file-prompt-store.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const FIXTURES_DIR = join(__dirname, '..', 'fixtures', 'prompts');

describe('FilePromptStore', () => {
  it('loads a specific version and parses frontmatter', async () => {
    const store = new FilePromptStore(FIXTURES_DIR);
    const result = await store.load('greet', 'v1');
    expect(isOk(result)).toBe(true);
    if (!isOk(result)) return;
    expect(result.value.version).toBe('v1');
    expect(result.value.frontmatter).toEqual({
      modelTier: 'small',
      temperature: 0.5,
      outputSchema: 'GreetSchema',
    });
  });

  it('renders a template by substituting {{placeholders}}', async () => {
    const store = new FilePromptStore(FIXTURES_DIR);
    const result = await store.load('greet', 'v1');
    if (!isOk(result)) throw new Error('expected ok');
    const rendered = result.value.render({ name: 'Ada', place: 'CareerPilot' });
    expect(rendered).toContain('Hello Ada, welcome to CareerPilot!');
  });

  it('throws PromptRenderError on an unfilled placeholder — fails loud, never passes {{foo}} through', async () => {
    const store = new FilePromptStore(FIXTURES_DIR);
    const result = await store.load('greet', 'v1');
    if (!isOk(result)) throw new Error('expected ok');
    expect(() => result.value.render({ name: 'Ada' })).toThrow(PromptRenderError);
    expect(() => result.value.render({ name: 'Ada' })).toThrow(/place/);
  });

  it('resolves to the highest version when version is omitted ("latest wins")', async () => {
    const store = new FilePromptStore(FIXTURES_DIR);
    const result = await store.load('greet');
    if (!isOk(result)) throw new Error('expected ok');
    expect(result.value.version).toBe('v2');
    expect(result.value.render({ name: 'Ada', place: 'CareerPilot' })).toContain('latest');
  });

  it('missing task directory → typed PromptError, not an unhandled throw', async () => {
    const store = new FilePromptStore(FIXTURES_DIR);
    const result = await store.load('does-not-exist');
    expect(isErr(result)).toBe(true);
    if (!isErr(result)) return;
    expect(result.error.code).toBe('task_not_found');
  });

  it('missing version → typed PromptError', async () => {
    const store = new FilePromptStore(FIXTURES_DIR);
    const result = await store.load('greet', 'v99');
    expect(isErr(result)).toBe(true);
    if (!isErr(result)) return;
    expect(result.error.code).toBe('version_not_found');
  });

  it('invalid frontmatter → typed PromptError, not an unhandled throw', async () => {
    const store = new FilePromptStore(FIXTURES_DIR);
    const result = await store.load('broken-frontmatter', 'v1');
    expect(isErr(result)).toBe(true);
    if (!isErr(result)) return;
    expect(result.error.code).toBe('invalid_frontmatter');
  });

  it('the real prompts/ tree (match-score/v1, tailor-resume/v1, tailor-cover-letter/v1, verify-claims/v1) loads and parses cleanly', async () => {
    const realPromptsDir = join(__dirname, '..', '..', '..', '..', 'prompts');
    const store = new FilePromptStore(realPromptsDir);

    const matchScore = await store.load('match-score');
    expect(isOk(matchScore)).toBe(true);
    if (isOk(matchScore)) {
      expect(matchScore.value.frontmatter.outputSchema).toBe('ScoreComponentsSchema');
      const rendered = matchScore.value.render({
        profile_facts: 'F1: did a thing',
        job_title: 'Engineer',
        job_company: 'Acme',
        job_description: 'Build things.',
      });
      expect(rendered).toContain('F1: did a thing');
    }

    for (const [task, schema] of [
      ['tailor-resume', 'TailoringResultSchema'],
      ['tailor-cover-letter', 'TailoringResultSchema'],
      ['verify-claims', 'ClaimAuditSchema'],
    ] as const) {
      const result = await store.load(task);
      expect(isOk(result)).toBe(true);
      if (isOk(result)) expect(result.value.frontmatter.outputSchema).toBe(schema);
    }
  });
});
