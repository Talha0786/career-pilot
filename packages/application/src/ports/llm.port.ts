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
