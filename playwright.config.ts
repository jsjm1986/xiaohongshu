import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { defineConfig } from '@playwright/test';

/**
 * 浏览器冒烟的运行骨架。存在的理由:1700+ 个 API 级与源码断言测试都不打开
 * 真浏览器,理论上存在「测试全绿但页面白屏」的盲区(bundle 加载失败、路由
 * 崩溃、运行时错误都不在现有测试的射程内)。这层只做冒烟——关键页面能渲染、
 * 登录闭环能走通,不做业务断言(那是 API 测试的职责)。
 *
 * 运行: npm run smoke:browser (先 npm run build,webServer 起的是 dist 产物)
 */
const smokeDataDir = mkdtempSync(join(tmpdir(), 'content-agent-e2e-'));
// 临时库跑完即删:mkdtemp 目录不会自己消失,磁盘紧张的单机上积少成多。
process.env.CONTENT_AGENT_E2E_DATA_DIR = smokeDataDir;

export default defineConfig({
  testDir: './e2e',
  globalTeardown: './e2e/teardown.ts',
  timeout: 30_000,
  fullyParallel: false,
  retries: 0,
  reporter: [['list']],
  use: {
    baseURL: 'http://127.0.0.1:8791',
    screenshot: 'only-on-failure',
  },
  webServer: {
    command: 'node apps/api/dist/main.js',
    url: 'http://127.0.0.1:8791/health',
    reuseExistingServer: false,
    timeout: 30_000,
    env: {
      PORT: '8791',
      CONTENT_AGENT_DATA_DIR: smokeDataDir,
      ADMIN_USERNAME: 'admin',
      BOOTSTRAP_ADMIN_PASSWORD: 'Smoke-bootstrap-123!',
      MASTER_ENCRYPTION_KEY: 'browser-smoke-master-key-000000!',
    },
  },
});
