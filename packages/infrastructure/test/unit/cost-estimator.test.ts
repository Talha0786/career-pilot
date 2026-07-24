import { describe, it, expect, vi } from 'vitest';
import { TieredCostEstimator } from '../../src/llm/cost-estimator.js';
import { PRICING_TABLE, FALLBACK_PRICING } from '../../src/llm/pricing-table.js';

describe('TieredCostEstimator', () => {
  it('estimates embed cost proportional to input length for a known model', () => {
    const estimator = new TieredCostEstimator();
    const cost = estimator.estimateEmbedCostUsd({ input: 'a'.repeat(4000), model: 'text-embedding-3-small' });
    // 4000 chars ~= 1000 tokens @ $0.00002/1k = $0.00002
    expect(cost).toBeCloseTo(0.00002, 8);
  });

  it('local/Ollama models are priced at $0', () => {
    const estimator = new TieredCostEstimator();
    expect(estimator.estimateEmbedCostUsd({ input: 'x'.repeat(4000), model: 'nomic-embed-text' })).toBe(0);
    expect(
      estimator.estimateCompleteCostUsd({ prompt: 'x'.repeat(4000), model: 'llama3.1:8b' }),
    ).toBe(0);
    expect(estimator.actualEmbedCostUsd('nomic-embed-text', 5000)).toBe(0);
  });

  it('actual embed cost uses real prompt token count', () => {
    const estimator = new TieredCostEstimator();
    const cost = estimator.actualEmbedCostUsd('text-embedding-3-large', 2000);
    expect(cost).toBeCloseTo((2000 / 1000) * PRICING_TABLE['text-embedding-3-large']!.embedPer1kUsd, 8);
  });

  it('estimates complete cost from prompt+system length, using maxTokens as the completion bound when set', () => {
    const estimator = new TieredCostEstimator();
    const rate = PRICING_TABLE['gpt-4o']!;
    const cost = estimator.estimateCompleteCostUsd({
      model: 'gpt-4o',
      prompt: 'a'.repeat(4000), // ~1000 tokens
      maxTokens: 500,
    });
    const expected = (1000 / 1000) * rate.inputPer1kUsd + (500 / 1000) * rate.outputPer1kUsd;
    expect(cost).toBeCloseTo(expected, 8);
  });

  it('actual complete cost is proportional to real prompt+completion token counts', () => {
    const estimator = new TieredCostEstimator();
    const rate = PRICING_TABLE['claude-3-5-sonnet']!;
    const cost = estimator.actualCompleteCostUsd('claude-3-5-sonnet', 1000, 2000);
    const expected = (1000 / 1000) * rate.inputPer1kUsd + (2000 / 1000) * rate.outputPer1kUsd;
    expect(cost).toBeCloseTo(expected, 8);
  });

  it('unknown model id falls back to the conservative non-zero rate and logs exactly one warning', () => {
    const warn = vi.fn();
    const estimator = new TieredCostEstimator(undefined, { warn });
    const cost = estimator.estimateEmbedCostUsd({ input: 'a'.repeat(4000), model: 'some-未知-model' });
    expect(cost).toBeCloseTo((1000 / 1000) * FALLBACK_PRICING.embedPer1kUsd, 8);
    expect(cost).toBeGreaterThan(0);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0]?.[0]).toMatchObject({ model: 'some-未知-model' });
  });

  it('unknown model never throws', () => {
    const estimator = new TieredCostEstimator(undefined, { warn: () => {} });
    expect(() =>
      estimator.estimateCompleteCostUsd({ model: 'totally-unpriced', prompt: 'hello' }),
    ).not.toThrow();
  });

  it('zero-length input estimates to exactly $0, not the fallback rate', () => {
    const estimator = new TieredCostEstimator();
    expect(estimator.estimateEmbedCostUsd({ input: '', model: 'gpt-4o' })).toBe(0);
    expect(estimator.estimateCompleteCostUsd({ model: 'gpt-4o', prompt: '' })).toBe(0);
    expect(estimator.actualEmbedCostUsd('gpt-4o', 0)).toBe(0);
    expect(estimator.actualCompleteCostUsd('gpt-4o', 0, 0)).toBe(0);
  });

  it('a custom pricing table overrides the default one', () => {
    const estimator = new TieredCostEstimator({
      'my-model': { inputPer1kUsd: 1, outputPer1kUsd: 2, embedPer1kUsd: 3 },
    });
    expect(estimator.actualEmbedCostUsd('my-model', 1000)).toBeCloseTo(3, 8);
  });
});
