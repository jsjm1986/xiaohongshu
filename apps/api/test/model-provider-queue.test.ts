import assert from 'node:assert/strict';
import test from 'node:test';
import type { ModelProvider } from '@content-agent/agent-core';
import { classifyImageBriefKind, retryModelProvider, serializeModelProvider } from '../src/generation.service.js';

const wait = (delayMs: number): Promise<void> => new Promise((resolveDelay) => setTimeout(resolveDelay, delayMs));

test('serializes retried requests and continues the queue after a final failure', async () => {
  let active = 0;
  let maxActive = 0;
  const attempts = new Map<string, number>();
  const starts: string[] = [];
  const provider: ModelProvider = {
    generate: async (request) => {
      const id = String(request.metadata?.id);
      const attempt = (attempts.get(id) ?? 0) + 1;
      attempts.set(id, attempt);
      active += 1;
      maxActive = Math.max(maxActive, active);
      starts.push(`${id}:${attempt}`);
      try {
        await wait(5);
        if (id === 'first') throw new Error('permanent failure');
        return { text: id, raw: { id } };
      } finally {
        active -= 1;
      }
    },
  };
  const queued = serializeModelProvider(retryModelProvider(provider, {
    baseDelayMs: 0,
    sleep: async () => undefined,
  }));

  const results = await Promise.allSettled([
    queued.generate({ messages: [], metadata: { id: 'first' } }),
    queued.generate({ messages: [], metadata: { id: 'second' } }),
    queued.generate({ messages: [], metadata: { id: 'third' } }),
  ]);

  assert.equal(results[0]?.status, 'rejected');
  assert.equal(results[1]?.status, 'fulfilled');
  assert.equal(results[2]?.status, 'fulfilled');
  assert.equal(results[1]?.status === 'fulfilled' ? results[1].value.text : undefined, 'second');
  assert.equal(results[2]?.status === 'fulfilled' ? results[2].value.text : undefined, 'third');
  assert.equal(maxActive, 1);
  assert.deepEqual(Object.fromEntries(attempts), { first: 3, second: 1, third: 1 });
  assert.deepEqual(starts, ['first:1', 'first:2', 'first:3', 'second:1', 'third:1']);
});

test('classifies image briefs from both artifact truth and actual text', () => {
  assert.equal(classifyImageBriefKind('a usable brief', 'contract_validated'), 'generation_brief');
  assert.equal(classifyImageBriefKind('a draft brief', 'drafted'), 'generation_brief');
  assert.equal(classifyImageBriefKind('', 'disabled'), 'disabled');
  assert.equal(classifyImageBriefKind('stale text must not override explicit state', 'disabled'), 'disabled');
  assert.equal(classifyImageBriefKind('', 'absent'), 'absent');
  assert.equal(classifyImageBriefKind('stale text must not override explicit state', 'absent'), 'absent');
  assert.equal(classifyImageBriefKind('', 'drafted'), 'absent');
  assert.equal(classifyImageBriefKind('', 'contract_validated'), 'absent');
  assert.equal(classifyImageBriefKind('historical brief'), 'generation_brief');
  assert.equal(classifyImageBriefKind(''), 'unknown');
});
