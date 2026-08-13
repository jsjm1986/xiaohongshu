import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const page = readFileSync(new URL('../src/pages/ResetPasswordPage.tsx', import.meta.url), 'utf8');

test('忘记密码页面与全站密码合同一致：12–256 字符', () => {
  assert.match(page, /password\.length < 12/u);
  assert.match(page, /password\.length > 256/u);
  assert.match(page, /新密码至少 12 个字符/u);
  assert.match(page, /新密码不能超过 256 个字符/u);
  assert.match(page, /placeholder="至少 12 个字符"/u);
  assert.equal((page.match(/maxLength=\{256\}/gu) ?? []).length, 2);
  assert.doesNotMatch(page, /至少 8 个字符|password\.length < 8/u);
});
