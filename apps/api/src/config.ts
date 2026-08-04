import { randomUUID } from 'node:crypto';
import { hostname } from 'node:os';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const APP_OPTIONS = Symbol('APP_OPTIONS');

export const MODEL_CONTEXT_WINDOW_TOKENS = 1_000_000;
// Knowledge is duplicated into section-scoped evidence projections in some stages.
// Keep a conservative budget until those projections are deduplicated; this still
// uses substantially more of the 1M context window than the historical 120K cap.
export const DEFAULT_KNOWLEDGE_CONTEXT_TOKENS = 600_000;

const INSECURE_MASTER_ENCRYPTION_KEYS = new Set([
  'change-me-now-123!',
  'replace-with-a-strong-password',
  'replace-with-at-least-32-random-characters',
]);

export function isUsableMasterEncryptionKey(value: string): boolean {
  const normalized = value.trim();
  return normalized.length >= 16 && !INSECURE_MASTER_ENCRYPTION_KEYS.has(normalized);
}

export interface ApiOptions {
  production: boolean;
  dataDir: string;
  databasePath: string;
  host: string;
  port: number;
  adminUsername: string;
  adminPassword: string;
  sessionTtlMs: number;
  secureCookies: boolean;
  logger: boolean;
  masterEncryptionKey: string;
  platformApiKey: string;
  platformBaseUrl: string;
  platformModel: string;
  platformTransport: 'responses' | 'chat_completions';
  byokAllowHttp: boolean;
  byokAllowPrivateNetwork: boolean;
  modelRequestTimeoutMs: number;
  modelRetryAttempts: number;
  /** 重试退避基数(毫秒);指数退避,用于跨过中继断流的故障窗口。 */
  modelRetryBaseDelayMs: number;
  modelMaxConcurrentRequests: number;
  knowledgeContextTokens: number;
  pdfFontPath: string;
  /**
   * 本实例的身份。写进 generation_jobs.claimed_by / analysis_tasks.claimed_by,
   * 让「谁在跑这个任务」成为库里的事实,回收时才能只动自己的和已死实例的。
   * 默认含 pid 与随机后缀:同一台机器起两个进程必须是两个不同身份,否则它们
   * 会互相当成「自己重启前留下的任务」而抢跑。
   */
  instanceId: string;
  /** 在跑任务的心跳间隔;回收扫描也用这个周期。 */
  jobHeartbeatMs: number;
  /**
   * 心跳超时判死的阈值。必须大于心跳间隔;默认取 6 倍,容忍单次长事务或 GC
   * 停顿造成的心跳延迟。
   */
  jobClaimTimeoutMs: number;
}

export type ApiOptionsInput = Partial<ApiOptions>;

interface IntegerConstraints {
  min?: number;
  max?: number;
}

function validateInteger(value: unknown, label: string, constraints: IntegerConstraints): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value)) {
    throw new Error(`${label} 必须是安全整数`);
  }
  if (constraints.min !== undefined && value < constraints.min) {
    throw new Error(`${label} 不能小于 ${constraints.min}`);
  }
  if (constraints.max !== undefined && value > constraints.max) {
    throw new Error(`${label} 不能大于 ${constraints.max}`);
  }
  return value;
}

function integerOption(
  inputValue: unknown,
  inputName: string,
  envName: string,
  fallback: number,
  constraints: IntegerConstraints,
): number {
  if (inputValue !== undefined) {
    return validateInteger(inputValue, `配置项 ${inputName}`, constraints);
  }
  const rawValue = process.env[envName];
  if (rawValue === undefined) return fallback;
  const normalized = rawValue.trim();
  if (!/^-?\d+$/.test(normalized)) {
    throw new Error(`${envName} 必须是完整的十进制整数`);
  }
  return validateInteger(Number(normalized), envName, constraints);
}

function validateBoolean(value: unknown, label: string): boolean {
  if (typeof value !== 'boolean') throw new Error(`${label} 必须是 true 或 false`);
  return value;
}

function booleanOption(
  inputValue: unknown,
  inputName: string,
  envName: string,
  fallback: boolean,
): boolean {
  if (inputValue !== undefined) return validateBoolean(inputValue, `配置项 ${inputName}`);
  const rawValue = process.env[envName];
  if (rawValue === undefined) return fallback;
  const normalized = rawValue.trim().toLowerCase();
  if (normalized === 'true') return true;
  if (normalized === 'false') return false;
  throw new Error(`${envName} 必须是 true 或 false`);
}

export function resolveOptions(input: ApiOptionsInput = {}): ApiOptions {
  const appRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
  const dataDir = resolve(appRoot, input.dataDir ?? process.env.CONTENT_AGENT_DATA_DIR ?? './data');
  const production = input.production === undefined
    ? process.env.NODE_ENV === 'production'
    : validateBoolean(input.production, '配置项 production');
  const port = integerOption(input.port, 'port', 'PORT', 8780, { min: 1, max: 65_535 });
  const sessionTtlMs = integerOption(
    input.sessionTtlMs,
    'sessionTtlMs',
    'CONTENT_AGENT_SESSION_TTL_MS',
    7 * 24 * 60 * 60 * 1000,
    { min: 1 },
  );
  const modelRequestTimeoutMs = integerOption(
    input.modelRequestTimeoutMs,
    'modelRequestTimeoutMs',
    'CONTENT_AGENT_MODEL_TIMEOUT_MS',
    90_000,
    { min: 1 },
  );
  const modelRetryAttempts = integerOption(
    input.modelRetryAttempts,
    'modelRetryAttempts',
    'CONTENT_AGENT_MODEL_RETRY_ATTEMPTS',
    6,
    { min: 1, max: 8 },
  );
  const modelRetryBaseDelayMs = integerOption(
    input.modelRetryBaseDelayMs,
    'modelRetryBaseDelayMs',
    'CONTENT_AGENT_MODEL_RETRY_BASE_DELAY_MS',
    4_000,
    { min: 0 },
  );
  const modelMaxConcurrentRequests = integerOption(
    input.modelMaxConcurrentRequests,
    'modelMaxConcurrentRequests',
    'CONTENT_AGENT_MODEL_MAX_CONCURRENT',
    2,
    { min: 1, max: 8 },
  );
  const knowledgeContextTokens = integerOption(
    input.knowledgeContextTokens,
    'knowledgeContextTokens',
    'KNOWLEDGE_CONTEXT_TOKENS',
    DEFAULT_KNOWLEDGE_CONTEXT_TOKENS,
    { min: 1, max: MODEL_CONTEXT_WINDOW_TOKENS },
  );
  const jobHeartbeatMs = integerOption(
    input.jobHeartbeatMs,
    'jobHeartbeatMs',
    'CONTENT_AGENT_JOB_HEARTBEAT_MS',
    15_000,
    { min: 1 },
  );
  const jobClaimTimeoutMs = integerOption(
    input.jobClaimTimeoutMs,
    'jobClaimTimeoutMs',
    'CONTENT_AGENT_JOB_CLAIM_TIMEOUT_MS',
    90_000,
    { min: 1 },
  );
  if (jobClaimTimeoutMs <= jobHeartbeatMs) {
    throw new Error('CONTENT_AGENT_JOB_CLAIM_TIMEOUT_MS / 配置项 jobClaimTimeoutMs 必须大于心跳间隔');
  }

  return {
    production,
    dataDir,
    databasePath: resolve(appRoot, input.databasePath ?? process.env.CONTENT_AGENT_DB_PATH ?? resolve(dataDir, 'app.db')),
    host: input.host ?? process.env.HOST ?? '127.0.0.1',
    port,
    adminUsername:
      input.adminUsername ?? process.env.CONTENT_AGENT_ADMIN_USERNAME ?? process.env.BOOTSTRAP_ADMIN_USERNAME ?? 'admin',
    adminPassword:
      input.adminPassword ?? process.env.CONTENT_AGENT_ADMIN_PASSWORD ?? process.env.BOOTSTRAP_ADMIN_PASSWORD ?? 'change-me-now-123!',
    sessionTtlMs,
    secureCookies: booleanOption(
      input.secureCookies,
      'secureCookies',
      'CONTENT_AGENT_SECURE_COOKIES',
      production,
    ),
    logger: input.logger === undefined
      ? process.env.NODE_ENV !== 'test'
      : validateBoolean(input.logger, '配置项 logger'),
    masterEncryptionKey:
      input.masterEncryptionKey ?? process.env.MASTER_ENCRYPTION_KEY ?? process.env.SESSION_SECRET ?? '',
    platformApiKey:
      input.platformApiKey ?? process.env.OPENAI_API_KEY ?? process.env.ANTHROPIC_AUTH_TOKEN ?? '',
    platformBaseUrl:
      (input.platformBaseUrl ?? process.env.OPENAI_BASE_URL ?? process.env.ANTHROPIC_BASE_URL ?? 'https://api.openai.com/v1').trim(),
    platformModel:
      input.platformModel ?? process.env.OPENAI_MODEL ?? process.env.ANTHROPIC_DEFAULT_OPUS_MODEL ?? 'gpt-5.4-mini',
    platformTransport:
      input.platformTransport ??
      (process.env.OPENAI_TRANSPORT === 'chat_completions' ? 'chat_completions' : 'responses'),
    byokAllowHttp: booleanOption(
      input.byokAllowHttp,
      'byokAllowHttp',
      'CONTENT_AGENT_BYOK_ALLOW_HTTP',
      false,
    ),
    byokAllowPrivateNetwork: booleanOption(
      input.byokAllowPrivateNetwork,
      'byokAllowPrivateNetwork',
      'CONTENT_AGENT_BYOK_ALLOW_PRIVATE_NETWORK',
      false,
    ),
    modelRequestTimeoutMs,
    // 默认值按实测中继错误簇分布设定(见 retryModelProvider 注释):6 次尝试 ×
    // 4000ms 基数 = 4+8+16+32+64 = 124 秒退避窗口,覆盖实测 37 个簇中的绝大多数。
    modelRetryAttempts,
    modelRetryBaseDelayMs,
    modelMaxConcurrentRequests,
    knowledgeContextTokens,
    pdfFontPath: input.pdfFontPath ?? process.env.PDF_FONT_PATH ?? '',
    // 容器编排下可注入稳定 id;默认值保证同机多进程互不同名。
    instanceId:
      input.instanceId ?? process.env.CONTENT_AGENT_INSTANCE_ID
      ?? `${hostname()}:${process.pid}:${randomUUID().slice(0, 8)}`,
    jobHeartbeatMs,
    jobClaimTimeoutMs,
  };
}
