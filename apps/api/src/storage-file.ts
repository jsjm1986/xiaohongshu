import { constants, type Stats } from 'node:fs';
import { lstat, open, realpath, unlink } from 'node:fs/promises';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { BadRequestException, PayloadTooLargeException } from '@nestjs/common';

export interface StoredFileScope {
  dataDir: string;
  projectDir: string;
  storagePath: string;
}

interface InspectedStoredFile {
  path: string;
  stats?: Stats;
  missing: boolean;
}

function invalidStoragePath(): never {
  throw new BadRequestException('Invalid storage path.');
}

function isMissing(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error
    && (error as { code?: unknown }).code === 'ENOENT';
}

function isDescendant(root: string, target: string): boolean {
  const child = relative(root, target);
  return child !== '' && child !== '..' && !child.startsWith(`..${sep}`) && !isAbsolute(child);
}

function lexicalPaths(scope: StoredFileScope): { root: string; projectRoot: string; target: string } {
  if (
    typeof scope.storagePath !== 'string'
    || scope.storagePath.trim().length === 0
    || scope.storagePath.includes('\0')
    || isAbsolute(scope.storagePath)
  ) {
    return invalidStoragePath();
  }
  const root = resolve(scope.dataDir);
  const projectRoot = resolve(scope.projectDir);
  const target = resolve(root, scope.storagePath);
  if (!isDescendant(root, projectRoot) || !isDescendant(projectRoot, target)) {
    return invalidStoragePath();
  }
  return { root, projectRoot, target };
}

async function inspectStoredFile(
  scope: StoredFileScope,
  allowMissing: boolean,
): Promise<InspectedStoredFile> {
  const paths = lexicalPaths(scope);
  const childPath = relative(paths.root, paths.target);
  const segments = childPath.split(sep);
  let cursor = paths.root;
  let targetStats: Stats | undefined;

  for (const [index, segment] of segments.entries()) {
    cursor = join(cursor, segment);
    let stats: Stats;
    try {
      stats = await lstat(cursor);
    } catch (error) {
      if (allowMissing && isMissing(error)) return { path: paths.target, missing: true };
      if (isMissing(error)) throw new BadRequestException('Stored file is unavailable.');
      throw error;
    }
    if (stats.isSymbolicLink()) invalidStoragePath();
    const isTarget = index === segments.length - 1;
    if ((!isTarget && !stats.isDirectory()) || (isTarget && !stats.isFile())) {
      invalidStoragePath();
    }
    if (isTarget) targetStats = stats;
  }

  let physicalRoot: string;
  let physicalProjectRoot: string;
  let physicalTarget: string;
  try {
    [physicalRoot, physicalProjectRoot, physicalTarget] = await Promise.all([
      realpath(paths.root),
      realpath(paths.projectRoot),
      realpath(paths.target),
    ]);
  } catch (error) {
    if (allowMissing && isMissing(error)) return { path: paths.target, missing: true };
    if (isMissing(error)) throw new BadRequestException('Stored file is unavailable.');
    throw error;
  }
  if (!isDescendant(physicalRoot, physicalProjectRoot) || !isDescendant(physicalProjectRoot, physicalTarget)) {
    invalidStoragePath();
  }
  return { path: paths.target, stats: targetStats, missing: false };
}

function assertSameFile(before: Stats | undefined, after: Stats): void {
  if (!before || !after.isFile() || before.dev !== after.dev || before.ino !== after.ino) {
    invalidStoragePath();
  }
}

export async function readStoredFile(scope: StoredFileScope, maxBytes: number): Promise<Buffer> {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 0) {
    throw new TypeError('maxBytes must be a non-negative safe integer.');
  }
  const inspected = await inspectStoredFile(scope, false);
  const handle = await open(inspected.path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const openedStats = await handle.stat();
    assertSameFile(inspected.stats, openedStats);
    if (openedStats.size > maxBytes) throw new PayloadTooLargeException('Stored file is too large.');

    const chunks: Buffer[] = [];
    let total = 0;
    while (total <= maxBytes) {
      const capacity = Math.min(64 * 1024, maxBytes + 1 - total);
      if (capacity <= 0) break;
      const chunk = Buffer.allocUnsafe(capacity);
      const { bytesRead } = await handle.read(chunk, 0, capacity, null);
      if (bytesRead === 0) break;
      chunks.push(chunk.subarray(0, bytesRead));
      total += bytesRead;
    }
    if (total > maxBytes) throw new PayloadTooLargeException('Stored file is too large.');
    return Buffer.concat(chunks, total);
  } finally {
    await handle.close();
  }
}

export async function readStoredText(scope: StoredFileScope, maxBytes: number): Promise<string> {
  return (await readStoredFile(scope, maxBytes)).toString('utf8');
}

export async function validateStoredFile(scope: StoredFileScope, allowMissing = false): Promise<boolean> {
  const inspected = await inspectStoredFile(scope, allowMissing);
  return !inspected.missing;
}

export async function removeStoredFile(scope: StoredFileScope): Promise<boolean> {
  const inspected = await inspectStoredFile(scope, true);
  if (inspected.missing) return false;

  // The data directory is private to this process. Rechecking the inode narrows
  // the remaining validation-to-unlink race; Node does not expose unlinkat(2).
  let current: Stats;
  try {
    current = await lstat(inspected.path);
  } catch (error) {
    if (isMissing(error)) return false;
    throw error;
  }
  if (current.isSymbolicLink()) invalidStoragePath();
  assertSameFile(inspected.stats, current);
  try {
    await unlink(inspected.path);
    return true;
  } catch (error) {
    if (isMissing(error)) return false;
    throw error;
  }
}
