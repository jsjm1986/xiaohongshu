import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

export type ProcessStartIdentityBackend =
  | 'linux-proc-boot-id'
  | 'linux-proc-btime'
  | 'ps-lstart';
export type KnownProcessStartIdentity = {
  kind: 'known';
  backend: ProcessStartIdentityBackend;
  value: string;
};
export type ProcessStartIdentity =
  | KnownProcessStartIdentity
  | { kind: 'unknown'; backend: ProcessStartIdentityBackend };
export type ProcessOwnerState = 'same' | 'unknown' | 'reused' | 'dead';

interface ProcessStartIdentityDependencies {
  readFile: (path: string) => Promise<string>;
  psStart: (pid: number) => Promise<string | undefined>;
}

type ProcessStartIdentityReader = (
  pid: number,
  backend?: ProcessStartIdentityBackend,
) => Promise<ProcessStartIdentity>;

async function linuxProcessStartValue(
  pid: number,
  backend: Extract<ProcessStartIdentityBackend, `linux-proc-${string}`>,
  dependencies: ProcessStartIdentityDependencies,
): Promise<string | undefined> {
  try {
    const rawStat = await dependencies.readFile(`/proc/${pid}/stat`);
    const commandEnd = rawStat.lastIndexOf(')');
    if (commandEnd < 0) return undefined;
    // /proc/<pid>/stat fields after "(comm)" start at field 3 (state);
    // starttime is field 22, therefore index 19 in this suffix.
    const fields = rawStat.slice(commandEnd + 1).trim().split(/\s+/u);
    const startTimeTicks = fields[19];
    if (!startTimeTicks || !/^\d+$/u.test(startTimeTicks)) return undefined;
    if (backend === 'linux-proc-boot-id') {
      try {
        const bootId = (await dependencies.readFile('/proc/sys/kernel/random/boot_id')).trim();
        return bootId ? `${bootId}:${startTimeTicks}` : undefined;
      } catch {
        return undefined;
      }
    }
    try {
      const bootTime = (await dependencies.readFile('/proc/stat')).match(/^btime\s+(\d+)$/mu)?.[1];
      return bootTime ? `${bootTime}:${startTimeTicks}` : undefined;
    } catch {
      return undefined;
    }
  } catch {
    return undefined;
  }
}

async function defaultPsStart(pid: number): Promise<string | undefined> {
  try {
    const { stdout } = await execFileAsync(
      'ps',
      ['-o', 'lstart=', '-p', String(pid)],
      {
        encoding: 'utf8',
        env: {
          ...process.env,
          TZ: 'UTC',
          LC_ALL: 'C',
          LANG: 'C',
        },
      },
    );
    const value = String(stdout).trim();
    return value || undefined;
  } catch {
    return undefined;
  }
}

const defaultDependencies: ProcessStartIdentityDependencies = {
  readFile: async (path) => readFile(path, 'utf8'),
  psStart: defaultPsStart,
};

export function createProcessStartIdentityReader(
  dependencies: ProcessStartIdentityDependencies,
): ProcessStartIdentityReader {
  const readBackend = async (
    pid: number,
    backend: ProcessStartIdentityBackend,
  ): Promise<ProcessStartIdentity> => {
    const value = backend.startsWith('linux-proc-')
      ? await linuxProcessStartValue(
        pid,
        backend as Extract<ProcessStartIdentityBackend, `linux-proc-${string}`>,
        dependencies,
      )
      : await dependencies.psStart(pid);
    return value
      ? { kind: 'known', backend, value }
      : { kind: 'unknown', backend };
  };

  return async (pid, backend) => {
    const firstBackend = backend ?? 'linux-proc-boot-id';
    if (!Number.isSafeInteger(pid) || pid <= 0) {
      return { kind: 'unknown', backend: firstBackend };
    }
    if (backend) return readBackend(pid, backend);
    const bootIdIdentity = await readBackend(pid, 'linux-proc-boot-id');
    if (bootIdIdentity.kind === 'known') return bootIdIdentity;
    const bootTimeIdentity = await readBackend(pid, 'linux-proc-btime');
    if (bootTimeIdentity.kind === 'known') return bootTimeIdentity;
    return readBackend(pid, 'ps-lstart');
  };
}

export const processStartIdentity = createProcessStartIdentityReader(defaultDependencies);

function defaultProcessExists(pid: number): boolean {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

export async function classifyProcessOwner(
  pid: number,
  expected: KnownProcessStartIdentity,
  options: {
    readIdentity?: ProcessStartIdentityReader;
    processExists?: (pid: number) => boolean;
  } = {},
): Promise<ProcessOwnerState> {
  const processExists = options.processExists ?? defaultProcessExists;
  if (!processExists(pid)) return 'dead';
  const actual = await (options.readIdentity ?? processStartIdentity)(pid, expected.backend);
  if (actual.kind === 'unknown') return 'unknown';
  if (actual.backend !== expected.backend) return 'unknown';
  return actual.value === expected.value ? 'same' : 'reused';
}
