import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { ok, err, type Result } from '@careerpilot/domain';
import {
  PromptRenderError,
  type PromptStore,
  type PromptTemplate,
  type PromptFrontmatter,
  type PromptError,
  type PromptModelTier,
} from '@careerpilot/application';

const PLACEHOLDER_RE = /\{\{\s*([a-zA-Z0-9_]+)\s*\}\}/g;
const MODEL_TIERS: readonly PromptModelTier[] = ['small', 'mid', 'large'];

/**
 * Reads `prompts/{task}/{version}.md` files off disk (task 034). `promptsDir`
 * is injected (not hardcoded to a repo-root-relative path) specifically so
 * tests can point this at a fixture directory instead of the real
 * `prompts/` tree — same "no hidden repo-root assumption" posture as every
 * other infrastructure adapter in this codebase.
 *
 * Frontmatter is a hand-rolled `---\n...\n---` splitter, deliberately NOT a
 * real YAML parser (task 034 file-list note: "do not add a heavy YAML
 * frontmatter library for this") — frontmatter here is always exactly three
 * flat `key: value` lines, which a real parser is overkill for.
 */
export class FilePromptStore implements PromptStore {
  constructor(private readonly promptsDir: string) {}

  async load(task: string, version?: string): Promise<Result<PromptTemplate, PromptError>> {
    const taskDir = join(this.promptsDir, task);

    let entries: string[];
    try {
      entries = await readdir(taskDir);
    } catch {
      return err({ code: 'task_not_found', message: `No prompt directory for task "${task}"` });
    }

    const versions = entries
      .filter((f) => /^v[0-9]+(\.[0-9]+)*\.md$/.test(f))
      .map((f) => f.slice(0, -'.md'.length));

    if (versions.length === 0) {
      return err({ code: 'task_not_found', message: `Prompt directory for task "${task}" has no version files` });
    }

    const resolvedVersion = version ?? pickLatest(versions);
    if (!versions.includes(resolvedVersion)) {
      return err({
        code: 'version_not_found',
        message: `Prompt task "${task}" has no version "${resolvedVersion}"`,
      });
    }

    let raw: string;
    try {
      raw = await readFile(join(taskDir, `${resolvedVersion}.md`), 'utf8');
    } catch {
      return err({
        code: 'version_not_found',
        message: `Could not read prompt file for "${task}/${resolvedVersion}"`,
      });
    }

    const parsed = parseFrontmatter(raw);
    if (!parsed.ok) {
      return err({
        code: 'invalid_frontmatter',
        message: `Invalid frontmatter in "${task}/${resolvedVersion}.md": ${parsed.error}`,
      });
    }

    const { frontmatter, body } = parsed.value;
    return ok({
      task,
      version: resolvedVersion,
      frontmatter,
      render: (vars) => renderTemplate(body, vars),
    });
  }
}

/** Highest semver-like version string, comparing dot-separated numeric segments. */
function pickLatest(versions: string[]): string {
  return [...versions].sort((a, b) => compareVersions(b, a))[0]!;
}

function compareVersions(a: string, b: string): number {
  const partsA = a.slice(1).split('.').map(Number);
  const partsB = b.slice(1).split('.').map(Number);
  const len = Math.max(partsA.length, partsB.length);
  for (let i = 0; i < len; i++) {
    const diff = (partsA[i] ?? 0) - (partsB[i] ?? 0);
    if (diff !== 0) return diff;
  }
  return 0;
}

function parseFrontmatter(
  raw: string,
): { ok: true; value: { frontmatter: PromptFrontmatter; body: string } } | { ok: false; error: string } {
  const normalized = raw.replace(/\r\n/g, '\n');
  if (!normalized.startsWith('---\n')) {
    return { ok: false, error: 'missing opening "---" frontmatter fence' };
  }
  const closeIdx = normalized.indexOf('\n---\n', 4);
  if (closeIdx === -1) {
    return { ok: false, error: 'missing closing "---" frontmatter fence' };
  }

  const fmBlock = normalized.slice(4, closeIdx);
  const body = normalized.slice(closeIdx + '\n---\n'.length);

  const fields = new Map<string, string>();
  for (const line of fmBlock.split('\n')) {
    if (line.trim().length === 0) continue;
    const sep = line.indexOf(':');
    if (sep === -1) {
      return { ok: false, error: `malformed frontmatter line: "${line}"` };
    }
    fields.set(line.slice(0, sep).trim(), line.slice(sep + 1).trim());
  }

  const modelTier = fields.get('model_tier');
  const temperatureRaw = fields.get('temperature');
  const outputSchema = fields.get('output_schema');

  if (!modelTier || !MODEL_TIERS.includes(modelTier as PromptModelTier)) {
    return { ok: false, error: `model_tier must be one of ${MODEL_TIERS.join('/')}, got "${modelTier}"` };
  }
  if (!temperatureRaw || Number.isNaN(Number(temperatureRaw))) {
    return { ok: false, error: `temperature must be a number, got "${temperatureRaw}"` };
  }
  if (!outputSchema) {
    return { ok: false, error: 'output_schema is required' };
  }

  return {
    ok: true,
    value: {
      frontmatter: {
        modelTier: modelTier as PromptModelTier,
        temperature: Number(temperatureRaw),
        outputSchema,
      },
      body,
    },
  };
}

function renderTemplate(body: string, vars: Record<string, string>): string {
  const placeholdersInBody = new Set(
    [...body.matchAll(PLACEHOLDER_RE)].map((m) => m[1]!),
  );

  for (const key of placeholdersInBody) {
    if (!(key in vars)) {
      throw new PromptRenderError(`Missing value for placeholder "{{${key}}}"`);
    }
  }

  return body.replace(PLACEHOLDER_RE, (whole, key: string) => {
    if (!(key in vars)) {
      // Unreachable given the pre-check above, but keeps this function safe
      // to call standalone / in future refactors.
      throw new PromptRenderError(`Missing value for placeholder "{{${key}}}"`);
    }
    return vars[key]!;
  });
}
