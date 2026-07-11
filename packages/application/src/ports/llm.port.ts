import type { Result, DomainError } from '@careerpilot/domain';

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

export interface LlmPort {
  embed(req: EmbedRequest): Promise<Result<EmbedResponse, LlmError>>;
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
