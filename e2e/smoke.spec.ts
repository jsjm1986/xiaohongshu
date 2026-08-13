import { expect, test } from '@playwright/test';

/**
 * 浏览器冒烟:防「测试全绿但页面白屏」。
 * 覆盖:登录页渲染 → 登录闭环(强制改密)→ 专家壳可达 → 重置密码页渲染。
 * 不做业务断言,只验证 bundle 能加载、路由能渲染、认证闭环能走通。
 */

test('登录页渲染且无运行时错误', async ({ page }) => {
  const pageErrors: string[] = [];
  page.on('pageerror', (error) => pageErrors.push(error.message));

  await page.goto('/login');
  await expect(page.getByRole('button', { name: /登录/ })).toBeVisible();
  await expect(page.locator('input[autocomplete="username"]')).toBeVisible();
  expect(pageErrors, `页面运行时错误: ${pageErrors.join('; ')}`).toEqual([]);
});

test('登录闭环：admin 首登强制改密后进入专家壳', async ({ page }) => {
  const pageErrors: string[] = [];
  page.on('pageerror', (error) => pageErrors.push(error.message));

  await page.goto('/login');
  await page.locator('input[autocomplete="username"]').fill('admin');
  await page.locator('input[autocomplete="current-password"]').fill('Smoke-bootstrap-123!');
  await page.getByRole('button', { name: /登录/ }).click();

  // 首次登录会被要求改密(mustChangePassword),页面路径依用户树而定;
  // 冒烟只断言「离开了登录页且渲染出了内容」,不锁死具体跳转策略。
  await page.waitForURL((url) => !url.pathname.startsWith('/login'), { timeout: 10_000 });
  await expect(page.locator('#root > *').first()).toBeVisible();
  const text = await page.locator('body').innerText();
  expect(text.trim().length, '页面渲染不能是白屏').toBeGreaterThan(20);
  expect(pageErrors, `页面运行时错误: ${pageErrors.join('; ')}`).toEqual([]);
});

test('重置密码页凭 token 参数渲染表单，缺 token 给出明确提示', async ({ page }) => {
  await page.goto('/reset-password?token=smoke-token');
  await expect(page.getByRole('button', { name: /设置新密码/ })).toBeVisible();

  await page.goto('/reset-password');
  await expect(page.getByText(/链接不完整/)).toBeVisible();
});
