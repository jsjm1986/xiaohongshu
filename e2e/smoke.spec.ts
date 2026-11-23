import { expect, test } from '@playwright/test';

/**
 * 浏览器冒烟:防「测试全绿但页面白屏」。
 * 覆盖登录、强制改密、重置密码页和 SaaS 客户首登建项目。
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

test('管理员首登及刷新时可以改密，且不加载项目数据', async ({ page }) => {
  const pageErrors: string[] = [];
  page.on('pageerror', (error) => pageErrors.push(error.message));
  const workspaceRequests: string[] = [];
  page.on('request', (request) => {
    const path = new URL(request.url()).pathname;
    if (path.startsWith('/api/') && !path.startsWith('/api/auth/')) workspaceRequests.push(path);
  });

  await page.goto('/login');
  await page.locator('input[autocomplete="username"]').fill('admin');
  await page.locator('input[autocomplete="current-password"]').fill('Smoke-bootstrap-123!');
  await page.getByRole('button', { name: /登录/ }).click();

  await expect(page).toHaveURL('/settings');
  await expect(page.getByRole('heading', { name: '修改初始密码' })).toBeVisible();
  await expect(page.getByLabel('当前密码')).toBeVisible();
  await page.reload();
  await expect(page.getByRole('button', { name: '更新密码' })).toBeEnabled();
  expect(workspaceRequests).toEqual([]);
  expect(pageErrors, `页面运行时错误: ${pageErrors.join('; ')}`).toEqual([]);
});

test('重置密码页凭 token 参数渲染表单，缺 token 给出明确提示', async ({ page }) => {
  await page.goto('/reset-password?token=smoke-token');
  await expect(page.getByRole('button', { name: /设置新密码/ })).toBeVisible();

  await page.goto('/reset-password');
  await expect(page.getByText(/链接不完整/)).toBeVisible();
});

/**
 * 新客户首登旅程:空工作区 → 建第一个项目 → 引导主按钮指向第一个缺口。
 * 这是收客的第一公里:空态引导断链的话,客户拿到账号就卡死在白屏或
 * 无从下手,而这条链路(QuickHome 空态 + deriveNextAction)只有源码断言,
 * 此前没有真浏览器走过。
 */
test('新 SaaS 客户首登：改密后创建第一个项目', async ({ page, request }) => {
  // 服务端创建 SaaS 账号、工作区和成员关系，浏览器走客户的首次登录流程。
  const adminLogin = await request.post('/api/auth/login', {
    data: { username: 'admin', password: 'Smoke-bootstrap-123!' },
  });
  expect(adminLogin.ok(), await adminLogin.text()).toBe(true);
  const { csrfToken } = await adminLogin.json();
  const csrf = { 'x-csrf-token': csrfToken };
  // 引导 admin 处于强制改密状态,改密前所有业务端点 403
  const adminChanged = await request.post('/api/auth/change-password', {
    headers: csrf,
    data: { currentPassword: 'Smoke-bootstrap-123!', newPassword: 'Smoke-updated-456!' },
  });
  expect(adminChanged.ok(), await adminChanged.text()).toBe(true);
  const username = `smoke-client-${Date.now()}`;
  const userResponse = await request.post('/api/admin/users', {
    headers: csrf,
    data: { username, password: 'Client-init-12345!', systemRole: 'user', userKind: 'saas' },
  });
  expect(userResponse.ok(), await userResponse.text()).toBe(true);
  const user = await userResponse.json();
  const workspaceResponse = await request.post('/api/workspaces', {
    headers: csrf,
    data: { name: '冒烟客户工作区' },
  });
  expect(workspaceResponse.ok(), await workspaceResponse.text()).toBe(true);
  const workspace = await workspaceResponse.json();
  const memberResponse = await request.put(`/api/workspaces/${workspace.id}/members/${user.id}`, {
    headers: csrf,
    data: { role: 'Admin', grants: [], denies: [] },
  });
  expect(memberResponse.ok(), await memberResponse.text()).toBe(true);

  await page.goto('/login');
  await page.locator('input[autocomplete="username"]').fill(username);
  await page.locator('input[autocomplete="current-password"]').fill('Client-init-12345!');
  await page.getByRole('button', { name: /登录/ }).click();

  await expect(page).toHaveURL('/quick/account');
  await page.getByLabel('当前密码').fill('Client-init-12345!');
  await page.getByLabel(/^新密码/).fill('Client-fresh-6789!');
  await page.getByLabel('再次输入新密码').fill('Client-fresh-6789!');
  await page.getByRole('button', { name: '更新密码' }).click();

  await expect(page).toHaveURL('/quick');
  await expect(page.getByText(/创建第一个项目/)).toBeVisible();

  await page.getByLabel('项目名称').fill('冒烟测试项目');
  await page.getByRole('button', { name: '创建', exact: true }).click();

  // deriveNextAction:无知识 → 主按钮「上传资料并分析」
  await expect(page.getByRole('button', { name: /上传资料并分析/ })).toBeVisible({ timeout: 10_000 });
});
