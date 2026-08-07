import assert from 'node:assert/strict';
import { after, beforeEach, test } from 'node:test';
import { DEFAULT_KNOWLEDGE_CONTEXT_TOKENS, MODEL_CONTEXT_WINDOW_TOKENS, resolveOptions, type ApiOptionsInput } from '../src/config.js';

const MANAGED_ENV = [
  'NODE_ENV',
  'PORT',
  'CONTENT_AGENT_SESSION_TTL_MS',
  'CONTENT_AGENT_MODEL_TIMEOUT_MS',
  'CONTENT_AGENT_MODEL_RETRY_ATTEMPTS',
  'CONTENT_AGENT_MODEL_RETRY_BASE_DELAY_MS',
  'CONTENT_AGENT_MODEL_MAX_CONCURRENT',
  'KNOWLEDGE_CONTEXT_TOKENS',
  'CONTENT_AGENT_JOB_HEARTBEAT_MS',
  'CONTENT_AGENT_JOB_CLAIM_TIMEOUT_MS',
  'CONTENT_AGENT_SECURE_COOKIES',
  'CONTENT_AGENT_BYOK_ALLOW_HTTP',
  'CONTENT_AGENT_BYOK_ALLOW_PRIVATE_NETWORK',
  'CONTENT_AGENT_BYOK_ALLOW_PROXY_FAKE_IP',
] as const;

const originalEnv = new Map(MANAGED_ENV.map((name) => [name, process.env[name]]));

beforeEach(() => {
  for (const name of MANAGED_ENV) delete process.env[name];
});

after(() => {
  for (const name of MANAGED_ENV) {
    const value = originalEnv.get(name);
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
});

function options(input: ApiOptionsInput = {}) {
  return resolveOptions({ logger: false, ...input });
}

function withEnv(name: string, value: string, run: () => void): void {
  const previous = process.env[name];
  process.env[name] = value;
  try {
    run();
  } finally {
    if (previous === undefined) delete process.env[name];
    else process.env[name] = previous;
  }
}

test('integer environment variables reject partial and unsafe values', () => {
  for (const value of ['123abc', '1.5', '1e3', 'NaN', '9007199254740992']) {
    withEnv('PORT', value, () => {
      assert.throws(() => options(), (error: unknown) =>
        error instanceof Error && error.message.includes('PORT'));
    });
  }

  assert.throws(() => options({ port: 1.5 }), /port/u);
  assert.throws(() => options({ port: Number.MAX_SAFE_INTEGER + 1 }), /port/u);
});

test('port accepts only the valid TCP range', () => {
  assert.equal(options({ port: 1 }).port, 1);
  assert.equal(options({ port: 65_535 }).port, 65_535);
  assert.throws(() => options({ port: 0 }), /port/u);
  assert.throws(() => options({ port: -1 }), /port/u);
  assert.throws(() => options({ port: 65_536 }), /port/u);
});

test('retry attempts and model concurrency stay within one through eight', () => {
  for (const value of [1, 8]) {
    assert.equal(options({ modelRetryAttempts: value }).modelRetryAttempts, value);
    assert.equal(options({ modelMaxConcurrentRequests: value }).modelMaxConcurrentRequests, value);
  }
  for (const value of [0, -1, 9]) {
    assert.throws(() => options({ modelRetryAttempts: value }), /modelRetryAttempts/u);
    assert.throws(() => options({ modelMaxConcurrentRequests: value }), /modelMaxConcurrentRequests/u);
  }
});

test('the 1M model context exposes an expanded 600K knowledge budget', () => {
  assert.equal(options().knowledgeContextTokens, DEFAULT_KNOWLEDGE_CONTEXT_TOKENS);
  assert.equal(DEFAULT_KNOWLEDGE_CONTEXT_TOKENS, 600_000);
  assert.equal(options({ knowledgeContextTokens: MODEL_CONTEXT_WINDOW_TOKENS }).knowledgeContextTokens, 1_000_000);
  assert.throws(() => options({ knowledgeContextTokens: MODEL_CONTEXT_WINDOW_TOKENS + 1 }), /knowledgeContextTokens/u);
});

test('retry delay can be zero while positive durations reject zero and negatives', () => {
  assert.equal(options({ modelRetryBaseDelayMs: 0 }).modelRetryBaseDelayMs, 0);
  assert.throws(() => options({ sessionTtlMs: 0 }), /sessionTtlMs/u);
  assert.throws(() => options({ modelRequestTimeoutMs: -1 }), /modelRequestTimeoutMs/u);
  assert.throws(() => options({ knowledgeContextTokens: 0 }), /knowledgeContextTokens/u);
});

test('claim timeout must be strictly greater than the heartbeat interval', () => {
  const valid = options({ jobHeartbeatMs: 200, jobClaimTimeoutMs: 201 });
  assert.equal(valid.jobHeartbeatMs, 200);
  assert.equal(valid.jobClaimTimeoutMs, 201);
  assert.throws(() => options({ jobHeartbeatMs: 200, jobClaimTimeoutMs: 200 }), /jobClaimTimeoutMs/u);
  assert.throws(() => options({ jobHeartbeatMs: 200, jobClaimTimeoutMs: 199 }), /jobClaimTimeoutMs/u);
});

test('boolean environment variables accept only true or false and identify the bad variable', () => {
  for (const name of [
    'CONTENT_AGENT_SECURE_COOKIES',
    'CONTENT_AGENT_BYOK_ALLOW_HTTP',
    'CONTENT_AGENT_BYOK_ALLOW_PRIVATE_NETWORK',
    'CONTENT_AGENT_BYOK_ALLOW_PROXY_FAKE_IP',
  ]) {
    withEnv(name, 'yes', () => {
      assert.throws(() => options(), (error: unknown) =>
        error instanceof Error && error.message.includes(name));
    });
  }

  assert.throws(
    () => options({ secureCookies: 'false' as unknown as boolean }),
    /secureCookies/u,
  );
});


test('proxy fake-IP compatibility is explicit and defaults off', () => {
  assert.equal(options().byokAllowProxyFakeIp, false);
  assert.equal(options({ byokAllowProxyFakeIp: true }).byokAllowProxyFakeIp, true);
  withEnv('CONTENT_AGENT_BYOK_ALLOW_PROXY_FAKE_IP', 'true', () => {
    assert.equal(options().byokAllowProxyFakeIp, true);
  });
});

test('production defaults to secure cookies but permits an explicit trusted HTTP override', () => {
  assert.equal(options({ production: true }).secureCookies, true);
  assert.equal(options({ production: true, secureCookies: false }).secureCookies, false);
  withEnv('NODE_ENV', 'production', () => {
    assert.equal(options().production, true);
    assert.equal(options().secureCookies, true);
    withEnv('CONTENT_AGENT_SECURE_COOKIES', 'false', () => {
      assert.equal(options().secureCookies, false);
    });
  });
});
