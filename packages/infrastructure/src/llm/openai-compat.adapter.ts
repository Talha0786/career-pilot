import { ok, err, type Result } from '@careerpilot/domain';
import type { LlmPort, EmbedRequest, EmbedResponse, LlmError } from '@careerpilot/application';

/**
 * OpenAI-compatible embeddings adapter (ADR-006). Covers OpenAI, Ollama, and
 * vLLM behind one HTTP shape. `baseUrl` pointed at a local Ollama endpoint is
 * the key-free default; pointed at api.openai.com with an API key is the
 * BYO-key path. Same adapter either way — the only difference is config.
 */
export class OpenAiCompatibleLlmAdapter implements LlmPort {
  constructor(
    private readonly baseUrl: string,
    private readonly apiKey: string | null,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  async embed(req: EmbedRequest): Promise<Result<EmbedResponse, LlmError>> {
    let response: Response;
    try {
      response = await this.fetchImpl(`${this.baseUrl}/embeddings`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          ...(this.apiKey ? { authorization: `Bearer ${this.apiKey}` } : {}),
        },
        body: JSON.stringify({ model: req.model, input: req.input }),
      });
    } catch (cause) {
      return err({
        code: 'provider_unavailable',
        message: `Could not reach LLM provider at ${this.baseUrl}: ${cause instanceof Error ? cause.message : String(cause)}`,
      });
    }

    if (response.status === 429) {
      return err({ code: 'rate_limited', message: 'LLM provider rate-limited the request' });
    }
    if (!response.ok) {
      return err({
        code: 'provider_unavailable',
        message: `LLM provider returned HTTP ${response.status}`,
      });
    }

    let body: unknown;
    try {
      body = await response.json();
    } catch {
      return err({ code: 'invalid_response', message: 'LLM provider response was not valid JSON' });
    }

    const parsed = parseEmbeddingResponse(body, req.model);
    if (!parsed) {
      return err({ code: 'invalid_response', message: 'LLM provider response did not match the expected embeddings shape' });
    }
    return ok(parsed);
  }
}

/** Narrow, defensive parsing — we don't trust an external HTTP response's shape. */
function parseEmbeddingResponse(body: unknown, fallbackModel: string): EmbedResponse | null {
  if (typeof body !== 'object' || body === null) return null;
  const b = body as Record<string, unknown>;
  const data = b.data;
  if (!Array.isArray(data) || data.length === 0) return null;
  const first = data[0] as Record<string, unknown> | undefined;
  const vector = first?.embedding;
  if (!Array.isArray(vector) || !vector.every((n) => typeof n === 'number')) return null;

  const usage = b.usage as Record<string, unknown> | undefined;
  const promptTokens = typeof usage?.prompt_tokens === 'number' ? usage.prompt_tokens : 0;
  const model = typeof b.model === 'string' ? b.model : fallbackModel;

  return { vector, model, promptTokens };
}
