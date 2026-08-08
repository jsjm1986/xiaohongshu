import assert from 'node:assert/strict';
import test from 'node:test';
import { ModelProviderError, type ModelProvider } from '@content-agent/agent-core';
import { classifyImageBriefKind, deriveQualityStatus, retryModelProvider, serializeModelProvider } from '../src/generation.service.js';

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
        if (id === 'first') throw new ModelProviderError('permanent failure', 500);
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

/**
 * 中继断流(unexpected EOF)必须能被重试跨过。
 *
 * 实测本地 kiro-go 中继在上游 AWS 断流时返回 HTTP 500 且**持续多秒**(连打 5 次
 * 全是 500,中继内部已在 Kiro IDE / CodeWhisperer / AmazonQ 之间轮换过)。旧配置
 * maxAttempts=2、退避 300ms —— 两次尝试间隔不到 1 秒,等于在同一个故障窗口里连撞
 * 两次,整篇作废。今天因此损失多篇。
 */
test('持续数秒的 5xx 断流能被重试跨过，而不是在同一故障窗口内连撞', async () => {
  let attempts = 0;
  const slept: number[] = [];
  // 前 3 次都失败(模拟故障窗口),第 4 次成功。
  const provider: ModelProvider = {
    generate: async () => {
      attempts += 1;
      if (attempts <= 3) throw new ModelProviderError('Model provider rejected the request: unexpected EOF', 500);
      return { text: 'ok', raw: {} };
    },
  };
  const wrapped = retryModelProvider(provider, {
    maxAttempts: 5,
    baseDelayMs: 1000,
    sleep: async (ms) => { slept.push(ms); },
  });
  const result = await wrapped.generate({ messages: [] });
  assert.equal(result.text, 'ok');
  assert.equal(attempts, 4);
  // 退避必须真正拉开:累计等待要够跨过数秒级的故障窗口。
  const total = slept.reduce((sum, ms) => sum + ms, 0);
  assert.ok(total >= 3000, `累计退避 ${total}ms 太短，跨不过实测的数秒断流窗口`);
});

test('HTTP 200 空输出与结构错误不进入网络重试循环', async () => {
  for (const error of [
    new ModelProviderError('Model response did not contain output text.', 200, 'req-empty', false, 'stop'),
    new ModelProviderError('Model response was not a JSON object.', 200, 'req-json', false),
    new ModelProviderError('Model output was truncated at 16000 max tokens.', 200, 'req-length', false, 'length'),
  ]) {
    let attempts = 0;
    const provider: ModelProvider = {
      generate: async () => { attempts += 1; throw error; },
    };
    const wrapped = retryModelProvider(provider, {
      maxAttempts: 6, baseDelayMs: 0, sleep: async () => undefined,
    });
    await assert.rejects(() => wrapped.generate({ messages: [] }));
    assert.equal(attempts, 1, error.message);
  }
});

test('未知普通异常不冒充网络故障重复扣费', async () => {
  let attempts = 0;
  const provider: ModelProvider = {
    generate: async () => { attempts += 1; throw new Error('parser contract failed'); },
  };
  const wrapped = retryModelProvider(provider, {
    maxAttempts: 6, baseDelayMs: 0, sleep: async () => undefined,
  });
  await assert.rejects(() => wrapped.generate({ messages: [] }));
  assert.equal(attempts, 1);
});

test('4xx 客户端错误仍然立即放弃，不浪费重试', async () => {
  let attempts = 0;
  const provider: ModelProvider = {
    generate: async () => {
      attempts += 1;
      throw new ModelProviderError('bad request', 400);
    },
  };
  const wrapped = retryModelProvider(provider, { maxAttempts: 5, baseDelayMs: 0, sleep: async () => undefined });
  await assert.rejects(() => wrapped.generate({ messages: [] }));
  assert.equal(attempts, 1);
});

test('重试调试日志不泄露供应商响应、端点或凭据', async () => {
  const previousDebug = process.env.CONTENT_AGENT_DEBUG_RETRY;
  const previousConsoleError = console.error;
  const logs: string[] = [];
  process.env.CONTENT_AGENT_DEBUG_RETRY = '1';
  console.error = (...args: unknown[]) => { logs.push(args.map(String).join(' ')); };
  try {
    const provider: ModelProvider = {
      generate: async () => {
        throw new ModelProviderError('https://private-gateway.example/v1 returned sk-secret-credential and tenant response text', 502);
      },
    };
    const wrapped = retryModelProvider(provider, { maxAttempts: 1, baseDelayMs: 0, sleep: async () => undefined });
    await assert.rejects(() => wrapped.generate({
      messages: [],
      metadata: { purpose: 'analysis\nforged-log-line' },
    }));
  } finally {
    console.error = previousConsoleError;
    if (previousDebug === undefined) delete process.env.CONTENT_AGENT_DEBUG_RETRY;
    else process.env.CONTENT_AGENT_DEBUG_RETRY = previousDebug;
  }

  assert.equal(logs.length, 1);
  assert.match(logs[0]!, /purpose=analysis_forged-log-line/u);
  assert.match(logs[0]!, /status=502/u);
  assert.doesNotMatch(logs[0]!, /private-gateway|secret-credential|tenant response/u);
  assert.equal(logs[0]!.split('\n').length, 1, '日志字段不能注入新日志行');
});

/**
 * 退避基数必须可配置且默认够宽。
 *
 * 实测生产配置(maxAttempts=2, baseDelayMs 默认 300)只重试 1 次、间隔 300ms,
 * 而中继断流持续数秒 —— 等于在同一个故障窗口里连撞两次。默认基数必须拉到秒级,
 * 且允许用 env 覆盖以适配不同中继的恢复速度。
 */
test('退避基数默认为秒级，累计窗口足以跨过数秒断流', async () => {
  let attempts = 0;
  const slept: number[] = [];
  const provider: ModelProvider = {
    generate: async () => {
      attempts += 1;
      throw new ModelProviderError('unexpected EOF', 500);
    },
  };
  // 不传 baseDelayMs，走默认值；用生产的 4 次尝试。
  const wrapped = retryModelProvider(provider, {
    maxAttempts: 4,
    sleep: async (ms) => { slept.push(ms); },
  });
  await assert.rejects(() => wrapped.generate({ messages: [] }));
  assert.equal(attempts, 4);
  const total = slept.reduce((sum, ms) => sum + ms, 0);
  assert.ok(total >= 5000, `默认累计退避 ${total}ms 太短，跨不过实测的数秒断流窗口`);
});

/**
 * 退避窗口要跨过中继的**错误簇**,不是单次抖动。
 *
 * 实测 kirostudio 40 分钟日志共 37 个 502 簇,持续 0-410 秒,中位 16-20 秒。旧配置
 * (baseDelay=1000 × 4 次)累计只等 7 秒,整段落在簇内必然全败——同一篇生成里
 * generate_comment_readers 有两个候选把 4 次尝试全部耗尽,台账阶段因此 100% 失败。
 * 生产默认(6 次 × 4000ms)必须给出分钟级窗口。
 */
test('生产默认退避窗口达到分钟级，足以跨过实测错误簇', async () => {
  const slept: number[] = [];
  const provider: ModelProvider = {
    generate: async () => { throw new ModelProviderError('读取响应失败: error decoding response body', 502); },
  };
  // 生产默认:CONTENT_AGENT_MODEL_RETRY_ATTEMPTS=6, BASE_DELAY_MS=4000。
  const wrapped = retryModelProvider(provider, {
    maxAttempts: 6,
    baseDelayMs: 4_000,
    sleep: async (ms) => { slept.push(ms); },
  });
  await assert.rejects(() => wrapped.generate({ messages: [] }));
  const total = slept.reduce((sum, ms) => sum + ms, 0);
  // 4+8+16+32+64 = 124 秒,覆盖实测 37 个簇中的绝大多数。
  assert.equal(total, 124_000);
  assert.ok(total >= 60_000, `累计退避 ${total}ms 跨不过中位 20 秒、长尾百秒级的错误簇`);
});

/** 任务级质量取最佳可交付候选，并按当前机械白名单重算历史元数据。 */
test('deriveQualityStatus：语义旧阻断降为复核，机械硬门禁仍 blocked', () => {
  const clean = { validation: { valid: true, qualityStatus: 'passed' as const, issues: [] } };
  const advisory = { validation: { valid: true, qualityStatus: 'passed' as const, issues: [
    { code: 'body_too_short', severity: 'warning' as const, disposition: 'advisory' as const },
  ] } };
  const review = { validation: { valid: false, qualityStatus: 'blocked' as const, issues: [
    { code: 'future_semantic_rule', severity: 'error' as const, disposition: 'block' as const },
  ] } };
  const blocked = { validation: { valid: false, qualityStatus: 'needs_review' as const, issues: [
    { code: 'title_required', severity: 'warning' as const, disposition: 'review' as const },
  ] } };

  assert.equal(deriveQualityStatus([clean]), 'passed');
  assert.equal(deriveQualityStatus([advisory]), 'passed');
  assert.equal(deriveQualityStatus([review]), 'needs_review');
  assert.equal(deriveQualityStatus([blocked]), 'blocked');
  assert.equal(deriveQualityStatus([review, clean]), 'passed');
  assert.equal(deriveQualityStatus([blocked, clean]), 'passed');
  assert.equal(deriveQualityStatus([review, blocked]), 'needs_review');
});

/** 上限从 5 放宽到 8,以便按需覆盖长尾簇(实测最长 410 秒)。 */
test('maxAttempts 上限放宽到 8，可配置覆盖长尾错误簇', async () => {
  let attempts = 0;
  const provider: ModelProvider = {
    generate: async () => { attempts += 1; throw new ModelProviderError('502', 502); },
  };
  const wrapped = retryModelProvider(provider, { maxAttempts: 99, baseDelayMs: 0, sleep: async () => undefined });
  await assert.rejects(() => wrapped.generate({ messages: [] }));
  assert.equal(attempts, 8, '上限应封顶在 8 次');
});
