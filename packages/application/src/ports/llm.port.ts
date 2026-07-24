import type { Result } from '@careerpilot/domain';

/**
 * Provider-agnostic LLM boundary (ADR-006). Adapters: OpenAI-compatible
 * (covers OpenAI, Ollama, vLLM) and Anthropic. The port never appears
 * un-guarded outside the composition root — see budget-guard.ts.
 */
export interface EmbedRequest {
  readonly input: string;
  readonly model: string;
}

export interface EmbedResponse {
  readonly vector: readonly number[];
  readonly model: string;
  readonly promptTokens: number;
}

export type LlmErrorCode = 'provider_unavailable' | 'invalid_response' | 'rate_limited';

export interface LlmError {
  readonly code: LlmErrorCode;
  readonly message: string;
}

/**
 * Chat/completion capability (task 023 — resume field mapping needs
 * unstructured-text-to-structured-JSON extraction, which `embed` can't do).
 * `jsonSchema` is a hint, not a guarantee — adapters that support native
 * JSON-mode pass it through; the caller must still validate the response
 * (see `resume-field-mapper.ts`), same "never trust an external HTTP
 * response's shape" posture as `openai-compat.adapter.ts`'s embedding parser.
 */
export interface CompleteRequest {
  readonly model: string;
  readonly system?: string | undefined;
  readonly prompt: string;
  readonly jsonSchema?: Record<string, unknown> | undefined;
  readonly maxTokens?: number | undefined;
  /**
   * Forwarded verbatim to the provider when set. Task 042 finding: prompt
   * frontmatter (`PromptTemplate.frontmatter.temperature`, docs/06-agent-
   * design.md §2) has always been PARSED but was never actually wired
   * through to a real completion call — every M5 call site loaded a prompt
   * declaring a specific temperature (e.g. `verify-claims/v1.md`'s `0.0`,
   * chosen because the adversarial audit should be conservative/
   * deterministic) and then silently ignored it, leaving every provider on
   * its own default. Optional so existing callers that don't have a loaded
   * `PromptTemplate` in scope (none currently) aren't forced to supply one.
   */
  readonly temperature?: number | undefined;
}

export interface CompleteResponse {
  readonly text: string;
  readonly model: string;
  readonly promptTokens: number;
  readonly completionTokens: number;
}

export interface LlmPort {
  embed(req: EmbedRequest): Promise<Result<EmbedResponse, LlmError>>;
  complete(req: CompleteRequest): Promise<Result<CompleteResponse, LlmError>>;
}

/** Every dispatch — success or failure — becomes one of these for ai_invocations. */
export interface AiInvocationRecord {
  readonly userId: string;
  readonly context: 'matching' | 'tailoring' | 'interview' | 'agent' | 'parsing';
  readonly refId: string;
  readonly provider: string;
  readonly model: string;
  readonly promptTokens: number;
  readonly completionTokens: number;
  readonly costUsd: number;
  readonly latencyMs: number;
  readonly status: 'ok' | 'error';
  readonly error: string | null;
}
