import assert from 'node:assert/strict';
import test from 'node:test';
import { buildGenerationTraceResponse, projectGenerationTraceDetails } from '../src/generation.service.js';

test('generation trace projection keeps safe diagnostics and drops prompt, copy, response and credentials', () => {
  const projected = projectGenerationTraceDetails('model_usage', {
    callId: 'call-1', purpose: 'generate_core', candidateIndex: 1, stage: 1,
    outcome: 'failed', elapsedMs: 123, providerRequests: 1,
    inputTokens: 100, outputTokens: 20, totalTokens: 120,
    responseDiagnostics: {
      topLevelKeys: ['choices', 'usage'], choiceMessageKeys: ['content', 'reasoning_content'],
      contentKind: 'string', contentChars: 0, reasoningContentChars: 310,
      rawBody: 'provider secret response',
    },
    prompt: 'secret prompt', body: 'private generated copy', apiKey: 'sk-secret', raw: { secret: true },
  });
  assert.deepEqual(projected.responseDiagnostics, {
    topLevelKeys: ['choices', 'usage'], choiceMessageKeys: ['content', 'reasoning_content'],
    contentKind: 'string', contentChars: 0, reasoningContentChars: 310,
  });
  const serialized = JSON.stringify(projected);
  for (const secret of ['secret prompt', 'private generated copy', 'sk-secret', 'provider secret response']) {
    assert.equal(serialized.includes(secret), false, secret);
  }
  assert.deepEqual(projectGenerationTraceDetails('future_unknown_event', { prompt: 'secret', safe: true }), {});
});

test('generation trace aggregation distinguishes full and historical traces', () => {
  const job = { id: 'job-1', status: 'completed' as const, created_at: '2026-08-05T00:00:00.000Z', completed_at: '2026-08-05T00:00:03.000Z' };
  const events = [
    { id: 1, event: 'queued', createdAt: job.created_at, details: {} },
    { id: 2, event: 'model_provider_attempt', createdAt: '2026-08-05T00:00:01.000Z', details: { willRetry: true } },
    { id: 3, event: 'model_usage', createdAt: '2026-08-05T00:00:02.000Z', details: { outcome: 'completed', providerRequests: 2, inputTokens: 100, outputTokens: 20, totalTokens: 120, cacheHitTokens: 40, cacheMissTokens: 60 } },
    { id: 4, event: 'candidate_completed', createdAt: job.completed_at, details: { candidateIndex: 0 } },
  ];
  const full = buildGenerationTraceResponse(job, events) as any;
  assert.equal(full.completeness, 'full');
  assert.deepEqual(full.summary, {
    elapsedMs: 3000, logicalModelCalls: 1, failedModelCalls: 0, providerRequests: 2,
    retryCount: 1, inputTokens: 100, outputTokens: 20, totalTokens: 120,
    cacheHitTokens: 40, cacheMissTokens: 60, cacheRate: 0.4,
    validationTelemetryAvailable: true, candidateCompletedCount: 1, candidateFailedCount: 0,
    repairStartedCount: 0, repairFailedCount: 0,
  });
  const historical = buildGenerationTraceResponse(job, events.slice(0, 3)) as any;
  assert.equal(historical.completeness, 'legacy_model_only');
  assert.equal(historical.summary.validationTelemetryAvailable, false);
});
