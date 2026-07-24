import type { Result } from '@careerpilot/domain';

/**
 * The `prompts/{task}/{version}.md` convention (docs/06-agent-design.md §2:
 * "Prompts are versioned files with frontmatter (model tier, temperature,
 * output schema ref). Prompt changes are code-reviewed like code.").
 *
 * `task 034` establishes the loader; every M5 pipeline (038 match-score, 039
 * tailoring, 040 claim verification) resolves its prompt through this port
 * rather than inlining prompt text in application code — the whole point is
 * that a prompt change is a diff to a reviewable file, not a code change.
 */
export type PromptModelTier = 'small' | 'mid' | 'large';

export interface PromptFrontmatter {
  readonly modelTier: PromptModelTier;
  readonly temperature: number;
  /** Ref name into packages/contracts — e.g. "ScoreComponentsSchema". Not validated here (that would be a contracts-package dependency); the caller validates its own LLM response against the real schema. */
  readonly outputSchema: string;
}

export interface PromptTemplate {
  readonly task: string;
  readonly version: string;
  readonly frontmatter: PromptFrontmatter;
  /**
   * Substitutes every `{{placeholder}}` in the template body with
   * `vars[placeholder]`. Fails LOUD (throws `PromptRenderError`) if a
   * placeholder in the template has no corresponding entry in `vars` — an
   * unfilled `{{foo}}` must never silently reach the LLM as literal text.
   * Extra keys in `vars` that don't correspond to any placeholder are
   * ignored (harmless — callers commonly pass one shared vars object across
   * multiple templates that use different subsets of it).
   */
  render(vars: Record<string, string>): string;
}

export type PromptErrorCode = 'task_not_found' | 'version_not_found' | 'invalid_frontmatter';

export interface PromptError {
  readonly code: PromptErrorCode;
  readonly message: string;
}

/** Thrown by `PromptTemplate.render` — a template-usage bug, not a Result-shaped domain failure. */
export class PromptRenderError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PromptRenderError';
  }
}

export interface PromptStore {
  /** `version` omitted → highest semver-like version present in the task's directory ("latest"). */
  load(task: string, version?: string): Promise<Result<PromptTemplate, PromptError>>;
}
