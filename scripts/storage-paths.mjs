import { readFile, stat } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { parseEnv } from 'node:util';

/**
 * 与 API config.ts 相同：相对路径以仓库根解析，绝对路径由 path.resolve 原样保留。
 * 纯函数单独导出，调用方无需执行任何 CLI 副作用即可复用与测试。
 */
export function resolveStoragePaths(repositoryRoot, repositoryEnv) {
  const normalizedRoot = resolve(repositoryRoot);
  const dataDir = resolve(
    normalizedRoot,
    repositoryEnv.CONTENT_AGENT_DATA_DIR ?? './data',
  );
  const databasePath = repositoryEnv.CONTENT_AGENT_DB_PATH === undefined
    ? join(dataDir, 'app.db')
    : resolve(normalizedRoot, repositoryEnv.CONTENT_AGENT_DB_PATH);
  return {
    repositoryRoot: normalizedRoot,
    dataDir,
    databasePath,
  };
}

/** 读取仓库自己的 .env；不合并调用进程环境，避免运维进程意外改写真实存储源。 */
export async function resolveRepositoryStoragePaths(repositoryRoot) {
  const normalizedRoot = resolve(repositoryRoot);
  const envFile = join(normalizedRoot, '.env');
  const envStat = await stat(envFile);
  if (!envStat.isFile()) {
    throw new Error(`Repository .env is not a regular file: ${envFile}`);
  }
  const repositoryEnv = parseEnv(await readFile(envFile, 'utf8'));
  return {
    ...resolveStoragePaths(normalizedRoot, repositoryEnv),
    envFile,
  };
}
