import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createServer, type Server } from 'node:http';
import { OpenAiCompatibleLlmAdapter } from '../../src/llm/openai-compat.adapter.js';
import { isOk, isErr } from '@careerpilot/domain';

/**
 * NOTE: no real Ollama/OpenAI model is reachable from this sandbox — the
 * network allowlist covers package registries only, not model providers, and
 * there's no Docker to run Ollama locally either. This test verifies the
 * ADAPTER'S OWN behavior (request shape, response parsing, error handling)
 * against a real HTTP server on loopback — genuine network I/O, just not a
 * genuine model behind it. Model-quality concerns are out of scope for an
 * infrastructure adapter test; wire-protocol correctness is exactly in scope.
 */
let server: Server;
let port: number;
let lastRequestBody: unknown = null;
let responseOverride: { status: number; body: unknown } | null = null;

beforeAll(async () => {
  server = createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => (raw += c));
    req.on('end', () => {
      lastRequestBody = raw ? JSON.parse(raw) : null;
      if (responseOverride) {
        res.writeHead(responseOverride.status, { 'content-type': 'application/json' });
        res.end(JSON.stringify(responseOverride.body));
        return;
      }
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(
        JSON.stringify({
          model: 'nomic-embed-text',
          data: [{ embedding: Array.from({ length: 768 }, (_, i) => i / 768) }],
          usage: { prompt_tokens: 12 },
        }),
      );
    });
  });
  await new Promise<void>((resolve) => server.listen(0, resolve));
  port = (server.address() as { port: number }).port;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

describe('OpenAiCompatibleLlmAdapter against a REAL local HTTP server', () => {
  it('sends the correct request shape and parses a well-formed response', async () => {
    responseOverride = null;
    const adapter = new OpenAiCompatibleLlmAdapter(`http://localhost:${port}`, null);

    const r = await adapter.embed({ input: 'a job description', model: 'nomic-embed-text' });

    expect(isOk(r)).toBe(true);
    if (isOk(r)) {
      expect(r.value.vector).toHaveLength(768);
      expect(r.value.model).toBe('nomic-embed-text');
      expect(r.value.promptTokens).toBe(12);
    }
    expect(lastRequestBody).toEqual({ model: 'nomic-embed-text', input: 'a job description' });
  });

  it('sends a Bearer auth header only when an API key is configured', async () => {
    responseOverride = null;
    let capturedAuth: string | undefined;
    const originalFetch = globalThis.fetch;
    const spyingFetch: typeof fetch = async (url, init) => {
      capturedAuth = (init?.headers as Record<string, string> | undefined)?.authorization;
      return originalFetch(url, init);
    };

    const withKey = new OpenAiCompatibleLlmAdapter(`http://localhost:${port}`, 'sk-test-123', spyingFetch);
    await withKey.embed({ input: 'x', model: 'm' });
    expect(capturedAuth).toBe('Bearer sk-test-123');

    const withoutKey = new OpenAiCompatibleLlmAdapter(`http://localhost:${port}`, null, spyingFetch);
    capturedAuth = undefined;
    await withoutKey.embed({ input: 'x', model: 'm' });
    expect(capturedAuth).toBeUndefined();
  });

  it('maps HTTP 429 to a rate_limited error', async () => {
    responseOverride = { status: 429, body: { error: 'slow down' } };
    const adapter = new OpenAiCompatibleLlmAdapter(`http://localhost:${port}`, null);
    const r = await adapter.embed({ input: 'x', model: 'm' });
    expect(isErr(r)).toBe(true);
    if (isErr(r)) expect(r.error.code).toBe('rate_limited');
  });

  it('maps a malformed 200 response to invalid_response rather than crashing', async () => {
    responseOverride = { status: 200, body: { unexpected: 'shape' } };
    const adapter = new OpenAiCompatibleLlmAdapter(`http://localhost:${port}`, null);
    const r = await adapter.embed({ input: 'x', model: 'm' });
    expect(isErr(r)).toBe(true);
    if (isErr(r)) expect(r.error.code).toBe('invalid_response');
  });

  it('maps an unreachable host to provider_unavailable, not an uncaught exception', async () => {
    const adapter = new OpenAiCompatibleLlmAdapter('http://localhost:1', null); // nothing listens on port 1
    const r = await adapter.embed({ input: 'x', model: 'm' });
    expect(isErr(r)).toBe(true);
    if (isErr(r)) expect(r.error.code).toBe('provider_unavailable');
  });
});
