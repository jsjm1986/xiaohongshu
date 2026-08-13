#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { createReadStream, realpathSync } from 'node:fs';
import { chmod, lstat, readFile, readdir, stat, writeFile } from 'node:fs/promises';
import { basename, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const SCHEMA = 'content-agent-backup/v2';
const LEGACY_SCHEMA = 'content-agent-backup/v1';
const STAMP_PATTERN = /^\d{8}-\d{6}$/u;
const GIT_COMMIT_PATTERN = /^[0-9a-f]{40}$/u;

function isExecutedAsCli(metaUrl) {
  if (!process.argv[1]) return false;
  try {
    return realpathSync(fileURLToPath(metaUrl)) === realpathSync(process.argv[1]);
  } catch {
    return metaUrl === pathToFileURL(process.argv[1]).href;
  }
}

function normalizeGitCommit(value) {
  if (value == null || value === '') return null;
  if (typeof value !== 'string' || !GIT_COMMIT_PATTERN.test(value)) {
    throw new Error(`Invalid backup git commit: ${value}`);
  }
  return value;
}

async function sha256(path) {
  const hash = createHash('sha256');
  await new Promise((resolveStream, rejectStream) => {
    const stream = createReadStream(path);
    stream.on('data', (chunk) => hash.update(chunk));
    stream.on('end', resolveStream);
    stream.on('error', rejectStream);
  });
  return hash.digest('hex');
}

async function describe(path) {
  const info = await lstat(path);
  if (!info.isFile()) throw new Error(`Backup artifact is not a regular file: ${path}`);
  return {
    file: basename(path),
    size: info.size,
    sha256: await sha256(path),
  };
}

export async function writeManifest(stamp, databasePath, filesPath, outputPath, gitCommit = null) {
  if (!STAMP_PATTERN.test(stamp)) throw new Error(`Invalid backup stamp: ${stamp}`);
  const manifest = {
    schema: SCHEMA,
    stamp,
    gitCommit: normalizeGitCommit(gitCommit),
    database: await describe(databasePath),
    files: await describe(filesPath),
    createdAt: new Date().toISOString(),
  };
  await writeFile(outputPath, `${JSON.stringify(manifest)}\n`, {
    encoding: 'utf8',
    flag: 'wx',
    mode: 0o600,
  });
  await chmod(outputPath, 0o600);
  return manifest;
}

async function verifyManifest(backupDir, manifestName) {
  const manifestPath = join(backupDir, manifestName);
  const manifestStat = await lstat(manifestPath);
  if (!manifestStat.isFile()) throw new Error(`Manifest is not a regular file: ${manifestName}`);
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
  const stamp = manifestName.slice('complete-'.length, -'.json'.length);
  if (
    (manifest.schema !== SCHEMA && manifest.schema !== LEGACY_SCHEMA)
    || manifest.stamp !== stamp
    || !STAMP_PATTERN.test(stamp)
    || manifest.database?.file !== `app-${stamp}.db.gz`
    || manifest.files?.file !== `files-${stamp}.tar.gz`
  ) {
    throw new Error(`Invalid backup manifest contract: ${manifestName}`);
  }
  if (manifest.schema === SCHEMA) {
    normalizeGitCommit(manifest.gitCommit);
  }
  for (const key of ['database', 'files']) {
    const expected = manifest[key];
    const path = join(backupDir, expected.file);
    const actual = await describe(path);
    if (actual.size !== expected.size || actual.sha256 !== expected.sha256) {
      throw new Error(`Backup manifest mismatch: ${expected.file}`);
    }
  }
  return {
    stamp,
    databasePath: join(backupDir, manifest.database.file),
    filesPath: join(backupDir, manifest.files.file),
    manifestPath,
  };
}

export async function inspectBackups(backupDirArgument) {
  const backupDir = resolve(backupDirArgument);
  let names;
  try {
    names = await readdir(backupDir);
  } catch (error) {
    if (error?.code === 'ENOENT') return { mode: 'none', latest: null, uncommitted: [] };
    throw error;
  }
  const manifests = names
    .filter((name) => /^complete-\d{8}-\d{6}\.json$/u.test(name))
    .sort();
  const pending = new Set(
    names
      .filter((name) => /^\.pending-\d{8}-\d{6}$/u.test(name))
      .map((name) => name.slice('.pending-'.length)),
  );
  const artifactStamps = new Set();
  for (const name of names) {
    const match = name.match(/^(?:app-(\d{8}-\d{6})\.db\.gz|files-(\d{8}-\d{6})\.tar\.gz)$/u);
    const stamp = match?.[1] ?? match?.[2];
    if (stamp) artifactStamps.add(stamp);
  }
  if (manifests.length > 0) {
    const committed = new Set(
      manifests.map((name) => name.slice('complete-'.length, -'.json'.length)),
    );
    const uncommitted = [...artifactStamps].filter((stamp) => !committed.has(stamp)).sort();
    return {
      mode: 'manifest',
      latest: await verifyManifest(backupDir, manifests.at(-1)),
      uncommitted,
    };
  }

  const uncommitted = [...artifactStamps].filter((stamp) => pending.has(stamp)).sort();
  const candidates = [];
  for (const stamp of artifactStamps) {
    if (pending.has(stamp)) continue;
    const databasePath = join(backupDir, `app-${stamp}.db.gz`);
    const filesPath = join(backupDir, `files-${stamp}.tar.gz`);
    try {
      const [databaseStat, filesStat] = await Promise.all([stat(databasePath), stat(filesPath)]);
      if (databaseStat.isFile() && filesStat.isFile()) {
        candidates.push({
          stamp,
          databasePath,
          filesPath,
          manifestPath: null,
          modifiedMs: Math.max(databaseStat.mtimeMs, filesStat.mtimeMs),
        });
      }
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error;
    }
  }
  candidates.sort((left, right) => left.modifiedMs - right.modifiedMs);
  const latest = candidates.at(-1) ?? null;
  if (latest) delete latest.modifiedMs;
  return { mode: 'legacy', latest, uncommitted };
}

async function main() {
  const [mode, ...args] = process.argv.slice(2);
  if (mode === '--write' && args.length >= 4 && args.length <= 5) {
    await writeManifest(args[0], args[1], args[2], args[3], args[4] ?? null);
    return;
  }
  if (mode === '--inspect' && args.length === 1) {
    process.stdout.write(`${JSON.stringify(await inspectBackups(args[0]))}\n`);
    return;
  }
  if (mode === '--inspect-lines' && args.length === 1) {
    const result = await inspectBackups(args[0]);
    process.stdout.write([
      result.mode,
      result.latest?.stamp ?? '-',
      result.latest?.databasePath ?? '-',
      result.latest?.filesPath ?? '-',
      result.latest?.manifestPath ?? '-',
      String(result.uncommitted.length),
      '',
    ].join('\n'));
    return;
  }
  throw new Error(
    'Usage: backup-manifest.mjs --write <stamp> <db.gz> <files.tar.gz> <output.json>\n'
    + '   or: backup-manifest.mjs --inspect[ -lines] <backup-dir>',
  );
}

if (isExecutedAsCli(import.meta.url)) {
  await main();
}
