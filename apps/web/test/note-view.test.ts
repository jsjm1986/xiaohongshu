import test from 'node:test';
import assert from 'node:assert/strict';
import { accountName, avatarTone, noteDate } from '../src/lib/note-view';

test('avatarTone 对同一账号名稳定', () => {
  const a = avatarTone('稳行驾校');
  const b = avatarTone('稳行驾校');
  assert.deepEqual(a, b);
});

test('avatarTone 不同名字落到不同底色', () => {
  const names = ['稳行驾校', '毛毛驿站宠物美容', '云图健身', 'A', 'B'];
  const tones = new Set(names.map((n) => avatarTone(n).bg));
  assert.ok(tones.size >= 3, `期望至少 3 种底色，实际 ${tones.size}`);
});

test('avatarTone 取首字符作为头像字', () => {
  assert.equal(avatarTone('稳行驾校').initial, '稳');
  assert.equal(avatarTone('acme').initial, 'A');
});

test('avatarTone 空名字不崩，给兜底字', () => {
  assert.equal(avatarTone('').initial, '号');
});

test('noteDate 优先用 completedAt', () => {
  assert.equal(
    noteDate({ completedAt: '2026-07-25T08:45:27.000Z', createdAt: '2026-07-01T00:00:00.000Z' }),
    '2026-07-25',
  );
});

test('noteDate 只有 createdAt 时退到它', () => {
  assert.equal(noteDate({ createdAt: '2026-07-01T00:00:00.000Z' }), '2026-07-01');
});

test('noteDate 两者皆缺返回 undefined', () => {
  assert.equal(noteDate({}), undefined);
});

test('noteDate 遇到无法解析的时间返回 undefined 而不是 Invalid Date', () => {
  assert.equal(noteDate({ completedAt: '不是时间' }), undefined);
});

test('accountName 缺项目名时回落发布账号', () => {
  assert.equal(accountName(undefined), '发布账号');
  assert.equal(accountName(''), '发布账号');
  assert.equal(accountName('稳行驾校'), '稳行驾校');
});
