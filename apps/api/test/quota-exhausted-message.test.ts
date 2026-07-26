import assert from 'node:assert/strict';
import { test } from 'node:test';
import { QUOTA_EXHAUSTED_MESSAGE, SUPPORT_WECHAT } from '../src/support.js';

/*
 * 额度用尽的话术。
 *
 * 实测缺陷:consumePlatformQuota 原来抛的是「平台测试额度已用完，请联系管理员增加
 * 额度或配置 BYOK」——对付费的 SaaS 用户来说这两条出路都不存在:他看不到管理员是
 * 谁,也没有配 BYOK 的权限(PATCH /api/settings 对 userKind='saas' 一律 403)。
 * 用真 saas 账号触发知识库分析拿到的就是这句无法执行的建议。
 *
 * 三个扣额度的入口(生成 / 按意见修改 / 知识库分析)都走 consumePlatformQuota,
 * 所以话术锁在常量上,一处改全都对。
 */

test('额度用尽话术给出可执行的出路:客服微信', () => {
  assert.match(QUOTA_EXHAUSTED_MESSAGE, /额度已用完/);
  assert.ok(QUOTA_EXHAUSTED_MESSAGE.includes(SUPPORT_WECHAT), '必须带客服微信');
});

// 行为反转,专门锁死:这两条路对 SaaS 用户都走不通,不能再出现在提示里
test('额度用尽话术不再提「联系管理员」或 BYOK', () => {
  assert.doesNotMatch(QUOTA_EXHAUSTED_MESSAGE, /管理员/);
  assert.doesNotMatch(QUOTA_EXHAUSTED_MESSAGE, /BYOK/i);
  assert.doesNotMatch(QUOTA_EXHAUSTED_MESSAGE, /自有密钥|自己的密钥/);
});

// 前后端两份常量必须一致,否则同一件事在界面和接口里说两个号
test('客服微信与前端 lib/support.ts 保持一致', () => {
  assert.equal(SUPPORT_WECHAT, 'wjyy5035');
});
