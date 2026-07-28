import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import test from 'node:test';
import {
  AUDIT_ACTION_COPY,
  AUDIT_ENTITY_COPY,
  auditActionCopy,
  auditEntityLabel,
  auditResourceText,
} from '../src/lib/audit-copy';

/*
  后端写 action 的方式有两种:`action: 'x.y'` 字面量,和 `record(..., 'x.y', ...)`
  透传。两种都要扫,否则会漏掉 intelligence / research 那一大片。

  这里读源文件而非 import——apps/web 不依赖 apps/api,跨包导入会把 web 的构建
  绑到 api 上。
*/
const backendActions = (() => {
  /*
    扫整个 apps/api/src 而不是维护一份文件白名单——第一版就是白名单,漏了
    admin.controller / registration.service / settings.service 三个文件里的
    四条 action。目录遍历不会因为新增文件而漏。
  */
  const dir = new URL('../../api/src/', import.meta.url);
  const found = new Set<string>();
  for (const file of readdirSync(dir)) {
    if (!file.endsWith('.ts')) continue;
    const source = readFileSync(new URL(file, dir), 'utf8');
    for (const match of source.matchAll(/action: '([\w.-]+)'/g)) found.add(match[1]);
    for (const match of source.matchAll(/\brecord\([^;]{0,400}?'([a-z][\w-]*\.[\w.-]+)'/g)) found.add(match[1]);
  }
  return [...found].sort();
})();

test('从后端源码扫到了足量 action(防止正则失效导致后面断言恒真)', () => {
  assert.ok(backendActions.length >= 40, `只扫到 ${backendActions.length} 条,正则或文件清单可能失效`);
});

test('后端写入的每条 action 都有中文文案', () => {
  const missing = backendActions.filter((action) => !AUDIT_ACTION_COPY[action]);
  assert.deepEqual(missing, [], `以下 action 缺少中文文案:${missing.join(', ')}`);
});

test('文案表里没有后端已不再写入的僵尸条目', () => {
  /*
    反向检查会误伤:approveResource 用 `${action}.approve` 拼接,静态正则扫不到
    这些。所以豁免 .approve 后缀,其余必须能在后端源码里找到出处。
  */
  const stale = Object.keys(AUDIT_ACTION_COPY).filter(
    (action) => !action.endsWith('.approve') && !backendActions.includes(action),
  );
  assert.deepEqual(stale, [], `以下 action 在后端已找不到出处:${stale.join(', ')}`);
});

test('每条中文动作名都不是标识符本身', () => {
  for (const [action, copy] of Object.entries(AUDIT_ACTION_COPY)) {
    assert.notEqual(copy.label, action, `${action} 的中文名还是标识符`);
    assert.ok(/[一-龥]/.test(copy.label), `${action} 的中文名里没有汉字`);
  }
});

test('系统自动触发的动作被标出来,人工操作不被误标', () => {
  assert.equal(AUDIT_ACTION_COPY['research.release.baseline-heal'].automatic, true);
  assert.equal(AUDIT_ACTION_COPY['formula.auto-upgrade'].automatic, true);
  // 反向对照:人工动作不该带 automatic,否则这个标记就没有区分力了
  assert.equal(AUDIT_ACTION_COPY['project.create'].automatic, undefined);
  assert.equal(AUDIT_ACTION_COPY['member.upsert'].automatic, undefined);
});

test('审批类动作统一译作「审批」,不预判结果', () => {
  /*
    approveResource 的 status 可以是 approved / rejected / draft,同一条 action
    既可能是通过也可能是驳回。译成「通过」会把驳回记录显示成批准。

    registration.approve 例外:它有配对的 registration.reject,通过和驳回是
    两条不同的 action,所以「通过注册申请」是确定的,不存在预判问题。
  */
  const ambiguous = Object.keys(AUDIT_ACTION_COPY).filter(
    (key) => key.endsWith('.approve') && !AUDIT_ACTION_COPY[`${key.slice(0, -'.approve'.length)}.reject`],
  );
  assert.ok(ambiguous.length >= 5, `只挑出 ${ambiguous.length} 条审批动作,筛选逻辑可能失效`);
  for (const action of ambiguous) {
    const label = AUDIT_ACTION_COPY[action].label;
    assert.ok(label.includes('审批'), `${action} 应译作「审批」,实际是「${label}」`);
    assert.ok(!label.includes('通过'), `${action} 不该预判为「通过」`);
  }
});

test('几条容易译错的动作,文案是实际行为', () => {
  // upsert 是新增或修改二合一,不是单纯「新增成员」
  assert.equal(AUDIT_ACTION_COPY['member.upsert'].label, '设置成员角色与权限');
  // 选定选题不等于批准其依赖项(intelligence.service.ts 在记录里专门写了 note)
  assert.equal(AUDIT_ACTION_COPY['topic-opportunity.select'].label, '选定选题');
  assert.ok(!AUDIT_ACTION_COPY['topic-opportunity.select'].label.includes('批准'));
  // generation.revise 是提交修改要求,不是「修订」
  assert.ok(AUDIT_ACTION_COPY['generation.revise'].label.includes('修改'));
});

test('未登记的 action 降级显示而不是消失', () => {
  const copy = auditActionCopy('brand.new.action');
  assert.equal(copy.label, 'brand.new.action');
  assert.equal(copy.known, false);
  // 已登记的要报 known: true,否则界面无法区分「没翻译」和「已翻译」
  assert.equal(auditActionCopy('project.create').known, true);
});

test('entityType 译成中文资源名,未登记时回退原值', () => {
  assert.equal(auditEntityLabel('generation_job'), '生成任务');
  assert.equal(auditEntityLabel('topic_opportunity'), '选题机会');
  assert.equal(auditEntityLabel('some_new_table'), 'some_new_table');
  for (const [key, label] of Object.entries(AUDIT_ENTITY_COPY)) {
    assert.ok(label.trim().length > 0, `${key} 的资源名为空`);
  }
});

test('资源列显示中文名加短 id,无 id 时只显示资源名', () => {
  assert.equal(auditResourceText('generation_job', '0a9930fa-4407-4798-a645-7a3d20ff8898'), '生成任务 · 0a9930fa');
  assert.equal(auditResourceText('user', ''), '用户');
  assert.equal(auditResourceText('user', null), '用户');
  assert.equal(auditResourceText('user', '   '), '用户');
});
