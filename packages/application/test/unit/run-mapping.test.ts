import { describe, it, expect } from 'vitest';
import { ApplyTask, asUserId, asApplicationId, asJobPostingId, asDocumentVersionId, isOk, isErr } from '@careerpilot/domain';
import { makeRunMappingUseCase } from '../../src/apply/commands/run-mapping.js';
import { GuardedLlmPort } from '../../src/ports/budget-guard.js';
import type { FieldDetectionPort, FieldDetectionResult } from '../../src/ports/field-detection.port.js';
import type { LlmPort, CompleteRequest, CompleteResponse, LlmError, EmbedResponse } from '../../src/ports/llm.port.js';
import type { Result } from '@careerpilot/domain';
import { FakeApplyTaskRepository } from '../fake-repos.js';
import { InMemoryBudgetStore, FakeCostEstimator, FakePromptStore } from '../fakes.js';

const USER = asUserId('018f0000-0000-7000-8000-000000000001');

class ScriptedLlmPort implements LlmPort {
  public completeCalls: CompleteRequest[] = [];
  private queue: string[] = [];
  queueResponses(...texts: string[]): void { this.queue.push(...texts); }
  async embed(): Promise<Result<EmbedResponse, LlmError>> { throw new Error('not used'); }
  async complete(req: CompleteRequest): Promise<Result<CompleteResponse, LlmError>> {
    this.completeCalls.push(req);
    return { ok: true, value: { text: this.queue.shift() ?? '{"fields":[]}', model: req.model, promptTokens: 5, completionTokens: 5 } };
  }
}

class FakeFieldDetectionPort implements FieldDetectionPort {
  public result: FieldDetectionResult = { atsAdapter: null, atsAdapterVersion: null, detected: [], allFields: [] };
  public delayMs = 0;
  async detectAndScore(): Promise<FieldDetectionResult> {
    if (this.delayMs > 0) await new Promise((r) => setTimeout(r, this.delayMs));
    return this.result;
  }
}

function setup() {
  const applyTasks = new FakeApplyTaskRepository();
  const fieldDetection = new FakeFieldDetectionPort();
  const inner = new ScriptedLlmPort();
  const budget = new InMemoryBudgetStore();
  const llm = new GuardedLlmPort(inner, budget, new FakeCostEstimator(), 100, 'test');
  const prompts = new FakePromptStore();
  prompts.register('field-map', '{{allow_essay_drafting}} {{profile_facts}} {{form_fields_json}}', { modelTier: 'mid', temperature: 0.1, outputSchema: 'FieldMapSchema' });
  const useCase = makeRunMappingUseCase({ applyTasks, fieldDetection, llm, prompts, model: 'test-model' });
  const useCaseShortTimeout = makeRunMappingUseCase({
    applyTasks, fieldDetection, llm, prompts, model: 'test-model', mappingTimeoutMs: 30,
  });
  return { applyTasks, fieldDetection, inner, useCase, useCaseShortTimeout };
}

async function seedDraftTask(applyTasks: FakeApplyTaskRepository) {
  const task = ApplyTask.create({
    userId: USER, applicationId: asApplicationId('018f0000-0000-7000-8000-0000000000a1'),
    jobPostingId: asJobPostingId('018f0000-0000-7000-8000-0000000000a2'),
    documentVersionId: asDocumentVersionId('018f0000-0000-7000-8000-0000000000a3'),
  });
  await applyTasks.save(task);
  return task;
}

describe('runMapping — draft → mapping (task 051)', () => {
  it('happy path: known-ATS confidently resolves everything, LLM never called', async () => {
    const { applyTasks, fieldDetection, inner, useCase } = setup();
    const task = await seedDraftTask(applyTasks);
    fieldDetection.result = {
      atsAdapter: 'greenhouse', atsAdapterVersion: '2026.07.1',
      detected: [{ selector: '#email', taxonomyKey: 'email', confidence: 0.95, neverAutoFill: false }],
      allFields: [{ selector: '#email', tagName: 'input', type: 'email', name: 'email', id: 'email', autocomplete: null, ariaLabel: null, labelText: null, placeholder: null }],
    };

    const result = await useCase({ userId: USER, applyTaskId: task.id, profileFactsText: 'f1', allowEssayDrafting: false });
    expect(isOk(result)).toBe(true);
    expect(inner.completeCalls).toHaveLength(0);
    if (isOk(result)) {
      expect(result.value.atsAdapter).toBe('greenhouse');
      expect(result.value.fields).toHaveLength(1);
    }

    const reloaded = await applyTasks.findByIdForUser(task.id, USER);
    expect(reloaded!.stage).toBe('mapping');
    expect(reloaded!.atsAdapter).toBe('greenhouse');
  });

  it('falls through to the LLM for fields heuristics left low-confidence', async () => {
    const { applyTasks, fieldDetection, inner, useCase } = setup();
    const task = await seedDraftTask(applyTasks);
    fieldDetection.result = {
      atsAdapter: null, atsAdapterVersion: null,
      detected: [],
      allFields: [{ selector: '#weird', tagName: 'input', type: 'text', name: null, id: 'weird', autocomplete: null, ariaLabel: null, labelText: 'Given name', placeholder: null }],
    };
    inner.queueResponses(JSON.stringify({ fields: [{ selector: '#weird', taxonomyKey: 'firstName', confidence: 0.8 }] }));

    const result = await useCase({ userId: USER, applyTaskId: task.id, profileFactsText: 'f1', allowEssayDrafting: false });
    expect(isOk(result)).toBe(true);
    expect(inner.completeCalls).toHaveLength(1);
    if (isOk(result)) expect(result.value.fields[0]).toMatchObject({ taxonomyKey: 'firstName', selector: '#weird' });
  });

  it('rejects starting mapping on a task not in draft', async () => {
    const { applyTasks, useCase } = setup();
    const task = await seedDraftTask(applyTasks);
    task.transitionTo('mapping');
    await applyTasks.save(task);

    const result = await useCase({ userId: USER, applyTaskId: task.id, profileFactsText: 'f1', allowEssayDrafting: false });
    expect(isErr(result)).toBe(true);
  });

  it('LLM failure transitions the task to failed, not left hanging in draft', async () => {
    const { applyTasks, fieldDetection, inner, useCase } = setup();
    const task = await seedDraftTask(applyTasks);
    fieldDetection.result = {
      atsAdapter: null, atsAdapterVersion: null, detected: [],
      allFields: [{ selector: '#x', tagName: 'input', type: 'text', name: null, id: 'x', autocomplete: null, ariaLabel: null, labelText: null, placeholder: null }],
    };
    inner.queueResponses('not json', 'still not json');

    const result = await useCase({ userId: USER, applyTaskId: task.id, profileFactsText: 'f1', allowEssayDrafting: false });
    expect(isErr(result)).toBe(true);
    const reloaded = await applyTasks.findByIdForUser(task.id, USER);
    expect(reloaded!.stage).toBe('failed');
  });

  it('total mapping failure (zero usable fields from any stage) sets manualAssistRequired, and the task is NOT failed (task 055 — never a dead end)', async () => {
    const { applyTasks, fieldDetection, inner, useCase } = setup();
    const task = await seedDraftTask(applyTasks);
    fieldDetection.result = {
      atsAdapter: null, atsAdapterVersion: null, detected: [],
      allFields: [{ selector: '#mystery', tagName: 'input', type: 'text', name: null, id: 'mystery', autocomplete: null, ariaLabel: null, labelText: null, placeholder: null }],
    };
    inner.queueResponses(JSON.stringify({ fields: [{ selector: '#mystery', taxonomyKey: null, confidence: 0 }] }));

    const result = await useCase({ userId: USER, applyTaskId: task.id, profileFactsText: 'f1', allowEssayDrafting: false });
    expect(isOk(result)).toBe(true);
    if (isOk(result)) {
      expect(result.value.manualAssistRequired).toBe(true);
      expect(result.value.fields).toHaveLength(0);
    }
    const reloaded = await applyTasks.findByIdForUser(task.id, USER);
    expect(reloaded!.stage).toBe('mapping'); // NOT 'failed' — the degradation ladder's point
  });

  it('a mapping with only sensitive fields detected still counts as manualAssistRequired (nothing usable to fill)', async () => {
    const { applyTasks, fieldDetection, useCase } = setup();
    const task = await seedDraftTask(applyTasks);
    fieldDetection.result = {
      atsAdapter: 'greenhouse', atsAdapterVersion: 'v1',
      detected: [{ selector: '#eeo_gender', taxonomyKey: 'eeoGender', confidence: 0, neverAutoFill: true }],
      allFields: [],
    };
    const result = await useCase({ userId: USER, applyTaskId: task.id, profileFactsText: 'f1', allowEssayDrafting: false });
    expect(isOk(result)).toBe(true);
    if (isOk(result)) expect(result.value.manualAssistRequired).toBe(true);
  });

  it('detection that finishes under the timeout completes normally (no false-trigger)', async () => {
    const { applyTasks, fieldDetection, useCaseShortTimeout } = setup();
    const task = await seedDraftTask(applyTasks);
    fieldDetection.delayMs = 5; // well under the 30ms test override
    fieldDetection.result = { atsAdapter: null, atsAdapterVersion: null, detected: [], allFields: [] };
    const result = await useCaseShortTimeout({ userId: USER, applyTaskId: task.id, profileFactsText: 'f1', allowEssayDrafting: false });
    expect(isOk(result)).toBe(true);
  });

  it('detection that exceeds the mapping timeout REALLY transitions the task to failed (not just documented)', async () => {
    const { applyTasks, fieldDetection, useCaseShortTimeout } = setup();
    const task = await seedDraftTask(applyTasks);
    fieldDetection.delayMs = 200; // exceeds the 30ms test override
    fieldDetection.result = { atsAdapter: null, atsAdapterVersion: null, detected: [], allFields: [] };

    const result = await useCaseShortTimeout({ userId: USER, applyTaskId: task.id, profileFactsText: 'f1', allowEssayDrafting: false });
    expect(isErr(result)).toBe(true);
    const reloaded = await applyTasks.findByIdForUser(task.id, USER);
    expect(reloaded!.stage).toBe('failed');
  });
});
