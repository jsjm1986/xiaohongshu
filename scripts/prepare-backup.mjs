#!/usr/bin/env node
import { backup, DatabaseSync } from 'node:sqlite';
import { createHash } from 'node:crypto';
import { realpathSync } from 'node:fs';
import { chmod, cp, lstat, mkdir, readFile, stat } from 'node:fs/promises';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { resolveRepositoryStoragePaths } from './storage-paths.mjs';

function isExecutedAsCli(metaUrl) {
  if (!process.argv[1]) return false;
  try {
    return realpathSync(fileURLToPath(metaUrl)) === realpathSync(process.argv[1]);
  } catch {
    return metaUrl === pathToFileURL(process.argv[1]).href;
  }
}

async function validateStagedStorage(databaseTarget, filesTarget) {
  const dataTarget = join(filesTarget, 'data');
  const snapshot = new DatabaseSync(databaseTarget, { readOnly: true });
  try {
    const existingTables = new Set(
      snapshot.prepare(
        `SELECT name FROM sqlite_master
         WHERE type='table' AND name IN ('knowledge_files','image_assets')`,
      ).all().map((row) => String(row.name)),
    );
    for (const table of ['knowledge_files', 'image_assets']) {
      if (!existingTables.has(table)) continue;
      const rows = snapshot.prepare(
        `SELECT storage_path, bytes, sha256 FROM ${table} WHERE deleted_at IS NULL`,
      ).all();
      for (const row of rows) {
        const storagePath = String(row.storage_path);
        const target = resolve(dataTarget, storagePath);
        const targetRelative = relative(dataTarget, target);
        if (
          !storagePath
          || isAbsolute(storagePath)
          || targetRelative === '..'
          || targetRelative.startsWith(`..${sep}`)
          || isAbsolute(targetRelative)
        ) {
          throw new Error(`${table} ${storagePath} escapes staging data`);
        }
        let targetStat;
        try {
          targetStat = await lstat(target);
        } catch (error) {
          if (error?.code === 'ENOENT') {
            throw new Error(`${table} ${storagePath} missing from staging`);
          }
          throw error;
        }
        if (!targetStat.isFile()) {
          throw new Error(`${table} ${storagePath} is not a regular staging file`);
        }
        if (targetStat.size !== Number(row.bytes)) {
          throw new Error(`${table} ${storagePath} bytes mismatch`);
        }
        const digest = createHash('sha256').update(await readFile(target)).digest('hex');
        if (digest !== String(row.sha256)) {
          throw new Error(`${table} ${storagePath} sha256 mismatch`);
        }
      }
    }
  } finally {
    snapshot.close();
  }
}

export async function prepareBackup(repositoryRootArgument, stageDirArgument, hooks = {}) {
  const repositoryRoot = resolve(repositoryRootArgument);
  const {
    envFile,
    dataDir: sourceDataDir,
    databasePath: sourceDatabase,
  } = await resolveRepositoryStoragePaths(repositoryRoot);
  const stageDir = resolve(stageDirArgument);
  const databaseTarget = join(stageDir, 'app.db');
  const filesTarget = join(stageDir, 'files');

  await mkdir(join(filesTarget, 'data'), { recursive: true, mode: 0o700 });
  const databaseStat = await stat(sourceDatabase);
  if (!databaseStat.isFile()) {
    throw new Error(`Configured database is not a regular file: ${sourceDatabase}`);
  }

  const source = new DatabaseSync(sourceDatabase, { readOnly: true });
  try {
    await backup(source, databaseTarget);
  } finally {
    source.close();
  }

  const snapshot = new DatabaseSync(databaseTarget, { readOnly: true });
  try {
    const integrity = snapshot.prepare('PRAGMA integrity_check').get();
    if (integrity?.integrity_check !== 'ok') {
      throw new Error(`backup integrity_check failed: ${String(integrity?.integrity_check)}`);
    }
    const foreignKeys = snapshot.prepare('PRAGMA foreign_key_check').all();
    if (foreignKeys.length > 0) {
      throw new Error(`backup foreign_key_check found ${foreignKeys.length} violation(s)`);
    }
  } finally {
    snapshot.close();
  }

  await hooks.afterDatabaseSnapshot?.();
  await cp(envFile, join(filesTarget, '.env'), { force: true });
  for (const directory of ['knowledge', 'images']) {
    try {
      await cp(join(sourceDataDir, directory), join(filesTarget, 'data', directory), {
        recursive: true,
        force: true,
      });
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error;
    }
  }
  await hooks.afterFilesCopied?.(filesTarget);
  await validateStagedStorage(databaseTarget, filesTarget);

  await chmod(databaseTarget, 0o600);
  await chmod(join(filesTarget, '.env'), 0o600);
}

async function main() {
  const [mode, rootArgument, stageArgument, ...extraArguments] = process.argv.slice(2);
  if (
    !rootArgument
    || extraArguments.length > 0
    || (mode === '--prepare' && !stageArgument)
    || (mode === '--print-database-path' && stageArgument)
    || !['--prepare', '--print-database-path'].includes(mode)
  ) {
    throw new Error(
      'Usage: prepare-backup.mjs --prepare <repository-root> <stage-dir>\n'
      + '   or: prepare-backup.mjs --print-database-path <repository-root>',
    );
  }
  if (mode === '--print-database-path') {
    const { databasePath } = await resolveRepositoryStoragePaths(resolve(rootArgument));
    process.stdout.write(`${databasePath}\n`);
    return;
  }
  await prepareBackup(rootArgument, stageArgument);
}

if (isExecutedAsCli(import.meta.url)) {
  await main();
}
