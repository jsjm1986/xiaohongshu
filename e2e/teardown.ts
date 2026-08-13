import { rmSync } from 'node:fs';

/** 删除本次冒烟的临时数据目录(见 playwright.config.ts)。 */
export default function globalTeardown(): void {
  const dir = process.env.CONTENT_AGENT_E2E_DATA_DIR;
  if (dir && dir.includes('content-agent-e2e-')) {
    rmSync(dir, { recursive: true, force: true });
  }
}
