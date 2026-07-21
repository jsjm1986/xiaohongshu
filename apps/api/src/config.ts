import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const APP_OPTIONS = Symbol('APP_OPTIONS');

export interface ApiOptions {
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
  modelRequestTimeoutMs: number;
  modelRetryAttempts: number;
  modelMaxConcurrentRequests: number;
  knowledgeContextTokens: number;
  pdfFontPath: string;
}

export type ApiOptionsInput = Partial<ApiOptions>;

export function resolveOptions(input: ApiOptionsInput = {}): ApiOptions {
  const appRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
  const dataDir = resolve(appRoot, input.dataDir ?? process.env.CONTENT_AGENT_DATA_DIR ?? './data');
  const port = input.port ?? Number.parseInt(process.env.PORT ?? '8780', 10);

  return {
    dataDir,
    databasePath: resolve(appRoot, input.databasePath ?? process.env.CONTENT_AGENT_DB_PATH ?? resolve(dataDir, 'app.db')),
    host: input.host ?? process.env.HOST ?? '127.0.0.1',
    port: Number.isFinite(port) ? port : 8780,
    adminUsername:
      input.adminUsername ?? process.env.CONTENT_AGENT_ADMIN_USERNAME ?? process.env.BOOTSTRAP_ADMIN_USERNAME ?? 'admin',
    adminPassword:
      input.adminPassword ?? process.env.CONTENT_AGENT_ADMIN_PASSWORD ?? process.env.BOOTSTRAP_ADMIN_PASSWORD ?? 'change-me-now-123!',
    sessionTtlMs:
      input.sessionTtlMs ??
      Number.parseInt(process.env.CONTENT_AGENT_SESSION_TTL_MS ?? `${7 * 24 * 60 * 60 * 1000}`, 10),
    secureCookies:
      input.secureCookies ?? (process.env.CONTENT_AGENT_SECURE_COOKIES ?? 'false').toLowerCase() === 'true',
    logger: input.logger ?? (process.env.NODE_ENV !== 'test'),
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
    modelRequestTimeoutMs:
      input.modelRequestTimeoutMs ?? Number.parseInt(process.env.CONTENT_AGENT_MODEL_TIMEOUT_MS ?? '90000', 10),
    modelRetryAttempts:
      input.modelRetryAttempts ?? Number.parseInt(process.env.CONTENT_AGENT_MODEL_RETRY_ATTEMPTS ?? '2', 10),
    modelMaxConcurrentRequests:
      input.modelMaxConcurrentRequests ?? Number.parseInt(process.env.CONTENT_AGENT_MODEL_MAX_CONCURRENT ?? '2', 10),
    knowledgeContextTokens:
      input.knowledgeContextTokens ?? Number.parseInt(process.env.KNOWLEDGE_CONTEXT_TOKENS ?? '120000', 10),
    pdfFontPath: input.pdfFontPath ?? process.env.PDF_FONT_PATH ?? '',
  };
}
