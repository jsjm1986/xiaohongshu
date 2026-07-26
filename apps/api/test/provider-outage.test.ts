import assert from 'node:assert/strict';
import { test } from 'node:test';
import { detectProviderOutage } from '../src/provider-outage.js';

/**
 * 用例里的错误文本全部取自 generation_jobs.error 列的实测值。
 *
 * 背景:86 篇失败里 42 篇是同一个 Insufficient Balance,集中在 4 个批次(各 10 篇
 * 全灭),每篇平均跑 983 秒才撞上——而配额在创建时已扣。
 */

test('余额不足属于供应商级故障:换一篇内容不会改变结果', () => {
  const outage = detectProviderOutage(
    '模型候选 1 生成失败，任务已停止且未生成可发布降级稿：Model provider rejected the request: Insufficient Balance',
  );
  assert.equal(outage?.kind, 'insufficient_balance');
  assert.match(outage?.reason ?? '', /余额不足/);
  // 出路必须写清:用户要知道充值后去哪里重试
  assert.match(outage?.reason ?? '', /产出区批量重试/);
});

test('无可用账号与凭据冷却同样是供应商级', () => {
  assert.equal(
    detectProviderOutage('Model provider rejected the request: No available accounts')?.kind,
    'no_account',
  );
  assert.equal(
    detectProviderOutage('Model provider rejected the request: All credentials are temporarily cooling down. Please retry after 60s')?.kind,
    'cooling_down',
  );
});

test('OpenAI 官方口径的余额/配额错误也认', () => {
  assert.equal(detectProviderOutage('You exceeded your current quota, please check your plan')?.kind, 'insufficient_balance');
  assert.equal(detectProviderOutage('insufficient_quota')?.kind, 'insufficient_balance');
  assert.equal(detectProviderOutage('Billing hard limit has been reached')?.kind, 'insufficient_balance');
});

test('中文口径的无可用渠道也认', () => {
  assert.equal(detectProviderOutage('当前无可用渠道，请稍后再试')?.kind, 'no_account');
  assert.equal(detectProviderOutage('无可用账号')?.kind, 'no_account');
});

test('单篇级错误一律不算 outage:换一次调用可能就成功了', () => {
  // 这些实测也在失败列表里,但它们不该拖垮整个项目的队列
  const perJob = [
    'Model provider rejected the request: unexpected EOF',
    'Model provider rejected the request: 读取响应失败: error decoding response body',
    'Model output did not contain a complete package',
    'Staged comment output returned 1 thread',
    'Model provider rejected the request: This response_format type is unsupported',
    'Model provider rejected the request: HTTP 500',
    '请求超时',
  ];
  for (const message of perJob) {
    assert.equal(detectProviderOutage(message), null, `不该判为 outage: ${message}`);
  }
});

test('空值与无关文本安全返回 null', () => {
  assert.equal(detectProviderOutage(undefined), null);
  assert.equal(detectProviderOutage(null), null);
  assert.equal(detectProviderOutage(''), null);
  assert.equal(detectProviderOutage('生成成功'), null);
});

test('「balance」单独出现不算:避免把无关文本误判成余额不足', () => {
  // 误判的代价比多跑几篇大得多——会把本可成功的任务一并判死
  assert.equal(detectProviderOutage('balance the tone of the article'), null);
  assert.equal(detectProviderOutage('账户余额充足'), null);
});
