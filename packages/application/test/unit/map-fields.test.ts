import { describe, it, expect } from 'vitest';
import { isOk, isErr } from '@careerpilot/domain';
import type { Result } from '@careerpilot/domain';
import { makeMapFieldsWithLlmUseCase } from '../../src/apply/commands/map-fields.js';
import { GuardedLlmPort } from '../../src/ports/budget-guard.js';
import type { LlmPort, CompleteRequest, CompleteResponse, LlmError, EmbedResponse } from '../../src/ports/llm.port.js';
import type { SerializedFormField } from '../../src/ports/field-detection.port.js';
import { InMemoryBudgetStore, FakeCostEstimator, FakePromptStore } from '../fakes.js';

class ScriptedLlmPort implements LlmPort {
  public completeCalls: CompleteRequest[] = [];
  private queue: string[] = [];
  queueResponses(...texts: string[]): void {
    this.queue.push(...texts);
  }
  async embed(): Promise<Result<EmbedResponse, LlmError>> {
    throw new Error('not used in this test');
  }
  async complete(req: CompleteRequest): Promise<Result<CompleteResponse, LlmError>> {
    this.completeCalls.push(req);
    const text = this.queue.shift() ?? '{"fields":[]}';
    return { ok: true, value: { text, model: req.model, promptTokens: 10, completionTokens: 5 } };
  }
}

const field = (overrides: Partial<SerializedFormField>): SerializedFormField => ({
  selector: '#x', tagName: 'input', type: null, name: null, id: null,
  autocomplete: null, ariaLabel: null, labelText: null, placeholder: null,
  ...overrides,
});

function setup() {
  const inner = new ScriptedLlmPort();
  const budget = new InMemoryBudgetStore();
  const estimator = new FakeCostEstimator();
  const llm = new GuardedLlmPort(inner, budget, estimator, 100, 'test');
  const prompts = new FakePromptStore();
  prompts.register(
    'field-map',
    '{{allow_essay_drafting}} {{profile_facts}} {{form_fields_json}}',
    { modelTier: 'mid', temperature: 0.1, outputSchema: 'FieldMapSchema' },
  );
  const useCase = makeMapFieldsWithLlmUseCase({ llm, prompts, model: 'test-model' });
  return { useCase, inner, budget };
}

const BASE_INPUT = { userId: 'u1', applyTaskId: 't1', profileFactsText: 'f1: Engineer', allowEssayDrafting: false };

describe('mapFieldsWithLlm (task 050) — cheapest-first enforcement', () => {
  it('with zero low-confidence fields, the LLM is NEVER called — cheapest-first proven, not just documented', async () => {
    const { useCase, inner } = setup();
    const result = await useCase({ ...BASE_INPUT, lowConfidenceFields: [] });
    expect(isOk(result)).toBe(true);
    if (isOk(result)) expect(result.value).toEqual([]);
    expect(inner.completeCalls).toHaveLength(0);
  });

  it('calls the LLM exactly once for a batch of low-confidence fields (not once per field)', async () => {
    const { useCase, inner } = setup();
    inner.queueResponses(JSON.stringify({
      fields: [
        { selector: '#a', taxonomyKey: 'email', confidence: 0.8 },
        { selector: '#b', taxonomyKey: 'phone', confidence: 0.7 },
      ],
    }));
    const result = await useCase({
      ...BASE_INPUT,
      lowConfidenceFields: [field({ selector: '#a' }), field({ selector: '#b' })],
    });
    expect(isOk(result)).toBe(true);
    expect(inner.completeCalls).toHaveLength(1);
    if (isOk(result)) {
      expect(result.value).toHaveLength(2);
      expect(result.value.find((f) => f.selector === '#a')?.taxonomyKey).toBe('email');
    }
  });
});

describe('mapFieldsWithLlm — sensitive-field defense in depth (task 050 acceptance criterion)', () => {
  it('force-zeroes confidence for a sensitive taxonomy key EVEN IF the LLM returns high confidence', async () => {
    const { useCase, inner } = setup();
    inner.queueResponses(JSON.stringify({
      fields: [{ selector: '#g', taxonomyKey: 'eeoGender', confidence: 0.99 }],
    }));
    const result = await useCase({ ...BASE_INPUT, lowConfidenceFields: [field({ selector: '#g' })] });
    expect(isOk(result)).toBe(true);
    if (isOk(result)) {
      expect(result.value).toHaveLength(1);
      expect(result.value[0]!.confidence).toBe(0);
      expect(result.value[0]!.neverAutoFill).toBe(true);
    }
  });
});

describe('mapFieldsWithLlm — hallucination guards', () => {
  it('ignores an entry for a selector that was never in the input (hallucinated selector)', async () => {
    const { useCase, inner } = setup();
    inner.queueResponses(JSON.stringify({
      fields: [{ selector: '#not-real', taxonomyKey: 'email', confidence: 0.9 }],
    }));
    const result = await useCase({ ...BASE_INPUT, lowConfidenceFields: [field({ selector: '#a' })] });
    expect(isOk(result)).toBe(true);
    if (isOk(result)) expect(result.value).toHaveLength(0);
  });

  it('drops a non-sensitive match below the low-confidence floor rather than guessing', async () => {
    const { useCase, inner } = setup();
    inner.queueResponses(JSON.stringify({
      fields: [{ selector: '#a', taxonomyKey: 'email', confidence: 0.1 }],
    }));
    const result = await useCase({ ...BASE_INPUT, lowConfidenceFields: [field({ selector: '#a' })] });
    expect(isOk(result)).toBe(true);
    if (isOk(result)) expect(result.value).toHaveLength(0);
  });

  it('ignores an unknown taxonomyKey value the LLM might invent', async () => {
    const { useCase, inner } = setup();
    inner.queueResponses(JSON.stringify({
      fields: [{ selector: '#a', taxonomyKey: 'notARealKey', confidence: 0.9 }],
    }));
    const result = await useCase({ ...BASE_INPUT, lowConfidenceFields: [field({ selector: '#a' })] });
    expect(isOk(result)).toBe(true);
    if (isOk(result)) expect(result.value).toHaveLength(0);
  });
});

describe('mapFieldsWithLlm — ADR-006 zod-repair-then-fail (task 050)', () => {
  it('malformed JSON triggers exactly one repair attempt, then a typed failure', async () => {
    const { useCase, inner } = setup();
    inner.queueResponses('not json at all', 'still not json');
    const result = await useCase({ ...BASE_INPUT, lowConfidenceFields: [field({ selector: '#a' })] });
    expect(isErr(result)).toBe(true);
    expect(inner.completeCalls).toHaveLength(2); // original + exactly one repair
  });

  it('a repaired response that now validates succeeds on the second attempt', async () => {
    const { useCase, inner } = setup();
    inner.queueResponses('garbage', JSON.stringify({ fields: [{ selector: '#a', taxonomyKey: 'email', confidence: 0.8 }] }));
    const result = await useCase({ ...BASE_INPUT, lowConfidenceFields: [field({ selector: '#a' })] });
    expect(isOk(result)).toBe(true);
    expect(inner.completeCalls).toHaveLength(2);
  });
});
