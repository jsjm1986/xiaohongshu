import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';

interface FrozenSnapshotSpec {
  sha256: string;
  rowCount: number;
  storageRef: string;
}

type SnapshotReader = (path: string) => Buffer;

const METADATA_FALLBACK_CODES = new Set(['ENOENT', 'EACCES', 'EPERM']);

export function resolveFrozenSnapshotStorageRef(
  candidates: readonly string[],
  expected: FrozenSnapshotSpec,
  readSnapshot: SnapshotReader = (path) => readFileSync(path),
): string {
  for (const candidate of candidates) {
    try {
      const buffer = readSnapshot(candidate);
      const sha256 = createHash('sha256').update(buffer).digest('hex');
      const rowCount = buffer.toString('utf8').split(/\r?\n/u).filter((line) => line.trim()).length;
      if (sha256 !== expected.sha256 || rowCount !== expected.rowCount) {
        throw new Error('70篇对标内容快照与应用内固化的哈希或行数不一致');
      }
      return candidate;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code && METADATA_FALLBACK_CODES.has(code)) continue;
      throw error;
    }
  }
  return expected.storageRef;
}
