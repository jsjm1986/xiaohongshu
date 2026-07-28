import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import {
  PERMISSION_COPY,
  PERMISSION_GROUPS,
  PERMISSION_ORDER,
  groupPermissions,
  permissionCopy,
} from '../src/lib/permission-copy';

/*
  后端 models.ts 是权限的真源。这里从源文件正则取出 PERMISSIONS,而不是 import
  ——apps/web 不依赖 apps/api,跨包导入会把 web 的构建绑到 api 上。读文本足够
  发现「后端加了一条、前端没跟上」这类漂移,也正是本次抄漏 4 条的成因。
*/
const backendPermissions = (() => {
  const source = readFileSync(new URL('../../api/src/models.ts', import.meta.url), 'utf8');
  const block = /export const PERMISSIONS = \[(.*?)\] as const;/s.exec(source);
  assert.ok(block, '没能在 models.ts 里定位 PERMISSIONS——真源结构变了,测试需同步');
  return [...block[1].matchAll(/'([\w.]+)'/g)].map((match) => match[1]);
})();

test('真源解析到了合理数量的权限(防止正则空转导致后面断言恒真)', () => {
  assert.ok(backendPermissions.length >= 20, `只解析出 ${backendPermissions.length} 条,正则可能失效`);
});

test('前端权限清单与后端同集合同序', () => {
  assert.deepEqual([...PERMISSION_ORDER], backendPermissions);
});

test('每条权限都有中文名和说明,且不是标识符本身', () => {
  for (const permission of PERMISSION_ORDER) {
    const copy = PERMISSION_COPY[permission];
    assert.ok(copy, `${permission} 缺少文案`);
    assert.ok(copy.label.trim().length > 0, `${permission} 中文名为空`);
    assert.notEqual(copy.label, permission, `${permission} 的中文名还是标识符`);
    assert.ok(copy.hint.trim().length > 0, `${permission} 缺少说明`);
    assert.ok(/[一-龥]/.test(copy.label), `${permission} 的中文名里没有汉字`);
  }
});

test('文案里的分组都在 PERMISSION_GROUPS 中声明过', () => {
  const declared = new Set(PERMISSION_GROUPS.map((group) => group.id));
  for (const permission of PERMISSION_ORDER) {
    assert.ok(declared.has(permissionCopy(permission).group), `${permission} 的分组未声明`);
  }
});

test('分组不丢权限:分组后总数等于输入总数', () => {
  const grouped = groupPermissions(PERMISSION_ORDER).flatMap((group) => group.permissions);
  assert.equal(grouped.length, PERMISSION_ORDER.length);
  assert.deepEqual(new Set(grouped), new Set(PERMISSION_ORDER));
});

test('分组顺序跟随 PERMISSION_GROUPS,空组被丢掉', () => {
  const groups = groupPermissions(['project.read', 'audit.read']);
  assert.deepEqual(groups.map((group) => group.id), ['project', 'audit']);
  // 反向对照:全量输入时组数必须更多,否则上面的断言可能是恒真的。
  assert.ok(groupPermissions(PERMISSION_ORDER).length > groups.length);
});

test('未登记的权限降级显示而不是被隐藏', () => {
  const copy = permissionCopy('something.new');
  assert.equal(copy.label, 'something.new');
  assert.ok(copy.hint.includes('还没有中文说明'));
  assert.deepEqual(groupPermissions(['something.new']).flatMap((group) => group.permissions), ['something.new']);
});

test('几条容易望文生义的权限,说明写的是实际管辖范围', () => {
  // generation.chat 实际是「提交修改要求」(revise),不是聊天
  assert.ok(PERMISSION_COPY['generation.chat'].label.includes('修改'));
  // generation.edit 实际管删除与恢复,不是编辑正文
  assert.ok(PERMISSION_COPY['generation.edit'].hint.includes('删除'));
  // api.read 是 API Key 的准入门槛,不是「读取 API」
  assert.ok(PERMISSION_COPY['api.read'].hint.includes('API Key'));
});
