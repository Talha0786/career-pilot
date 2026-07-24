import { describe, it, expect } from 'vitest';
import { asUserId, isOk } from '@careerpilot/domain';
import { makeVerifyClaimsUseCase } from '../../src/tailoring/commands/verify-claims.js';
import { GuardedLlmPort } from '../../src/ports/budget-guard.js';
import { InMemoryBudgetStore, FakeCostEstimator, FakeLlmPort, FakePromptStore } from '../fakes.js';

const USER = asUserId('018f0000-0000-7000-8000-000000000001');

function setup(budgetUsd = 100) {
  const inner = new FakeLlmPort();
  const store = new InMemoryBudgetStore();
  const guarded = new GuardedLlmPort(inner, store, new FakeCostEstimator(), budgetUsd, 'fake');
  const prompts = new FakePromptStore();
  prompts.register('verify-claims', 'Audit:\n{{fact_list}}\n{{draft_text}}');
  const verifyClaims = makeVerifyClaimsUseCase({ llm: guarded, prompts, model: 'test-model' });
  return { inner, verifyClaims };
}

describe('verifyClaims — task 040 adversarial pass', () => {
  it('loads the verify-claims prompt (a SEPARATE file from tailor-resume/tailor-cover-letter) and validates the LLM response against ClaimAuditSchema', async () => {
    const { inner, verifyClaims } = setup();
    inner.completeResponseText = JSON.stringify({
      claims: [{ text: 'Led migration of X', factId: 'F1', confidence: 0.9 }],
    });

    const result = await verifyClaims({
      factsText: 'F1: Led migration of X at Acme', draftText: '1. Led migration of X', userId: USER, refId: 'job-1',
    });
    expect(isOk(result)).toBe(true);
    if (!isOk(result)) return;
    expect(result.value.claims).toEqual([{ text: 'Led migration of X', factId: 'F1', confidence: 0.9 }]);
    expect(inner.lastCompleteRequest?.prompt).toContain('F1: Led migration of X at Acme');
    expect(inner.lastCompleteRequest?.prompt).toContain('1. Led migration of X');
  });

  it('a claim can be explicitly UNSUPPORTED (factId: null)', async () => {
    const { inner, verifyClaims } = setup();
    inner.completeResponseText = JSON.stringify({
      claims: [{ text: 'Managed a team of 50', factId: null, confidence: 0.05 }],
    });

    const result = await verifyClaims({ factsText: 'F1: x', draftText: '1. Managed a team of 50', userId: USER, refId: 'job-1' });
    expect(isOk(result)).toBe(true);
    if (!isOk(result)) return;
    expect(result.value.claims[0]!.factId).toBeNull();
  });

  it('malformed JSON triggers exactly one repair attempt, then a typed failure', async () => {
    const { inner, verifyClaims } = setup();
    inner.completeResponseText = 'not json'; // every call returns this — repair doesn't help, proving the cap is exact

    const result = await verifyClaims({ factsText: 'F1: x', draftText: '1. y', userId: USER, refId: 'job-1' });
    expect(result.ok).toBe(false);
    expect(inner.completeCallCount).toBe(2); // 1 original + 1 repair, not more
  });

  it("returns a typed error, not an unhandled throw, when the prompt file doesn't exist", async () => {
    const inner = new FakeLlmPort();
    const store = new InMemoryBudgetStore();
    const guarded = new GuardedLlmPort(inner, store, new FakeCostEstimator(), 100, 'fake');
    const emptyPrompts = new FakePromptStore(); // 'verify-claims' never registered
    const verifyClaims = makeVerifyClaimsUseCase({ llm: guarded, prompts: emptyPrompts, model: 'test-model' });

    const result = await verifyClaims({ factsText: 'F1: x', draftText: '1. y', userId: USER, refId: 'job-1' });
    expect(result.ok).toBe(false);
  });
});
