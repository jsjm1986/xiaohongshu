#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { readdir, readFile, stat } from 'node:fs/promises';
import { basename, dirname, extname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

interface ImportOptions {
  source: string;
  baseUrl: string;
  username: string;
  password: string;
}

interface ApiProject {
  id: string;
  slug: string;
  name: string;
  workspaceId: string;
}

interface KnowledgeFile {
  id: string;
  filename: string;
  sha256: string;
  metadata?: Record<string, unknown>;
}

interface ImportSummary {
  projectsCreated: number;
  projectsSkipped: number;
  filesImported: number;
  filesSkipped: number;
}

type JsonObject = Record<string, unknown>;

const METHODOLOGY_NAME = /(方法论|提示词|评分体系|对标内容|项目总索引)/u;

export class LocalApiClient {
  private cookie = '';
  private csrfToken = '';

  constructor(
    private readonly baseUrl: string,
    private readonly username: string,
    private readonly password: string,
  ) {}

  async login(): Promise<void> {
    const response = await fetch(this.url('/api/auth/login'), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ username: this.username, password: this.password }),
    });
    const body = await readResponse(response);
    if (!response.ok) throw apiError('登录失败', response, body);
    const cookieHeader = response.headers.getSetCookie?.()[0] ?? response.headers.get('set-cookie');
    if (!cookieHeader) throw new Error('登录响应没有返回会话 Cookie');
    this.cookie = cookieHeader.split(';', 1)[0] ?? '';
    this.csrfToken = stringField(body, 'csrfToken');
    const user = objectField(body, 'user');
    if (user.mustChangePassword === true) {
      throw new Error('管理员账号仍要求首次改密；请先在界面修改密码，再运行导入脚本');
    }
  }

  async get<T>(path: string): Promise<T> {
    const response = await fetch(this.url(path), { headers: this.headers(false) });
    const body = await readResponse(response);
    if (!response.ok) throw apiError(`GET ${path} 失败`, response, body);
    return unwrapData(body) as T;
  }

  async postJson<T>(path: string, body: unknown): Promise<T> {
    const response = await fetch(this.url(path), {
      method: 'POST',
      headers: { ...this.headers(true), 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    const responseBody = await readResponse(response);
    if (!response.ok) throw apiError(`POST ${path} 失败`, response, responseBody);
    return unwrapData(responseBody) as T;
  }

  async uploadKnowledge(input: {
    projectId: string;
    filename: string;
    bytes: Buffer;
    category: string;
    sourcePath: string;
  }): Promise<KnowledgeFile> {
    const form = new FormData();
    form.set('projectId', input.projectId);
    form.set('filename', input.filename);
    form.set('content', input.bytes.toString('utf8'));
    form.set('category', input.category);
    form.set('evidenceStatus', 'user_supplied');
    form.set(
      'metadata',
      JSON.stringify({
        legacySource: input.sourcePath,
        sourceSha256: sha256(input.bytes),
        importedBy: 'scripts/import-legacy.ts',
      }),
    );
    const response = await fetch(this.url('/api/knowledge'), {
      method: 'POST',
      headers: this.headers(true),
      body: form,
    });
    const body = await readResponse(response);
    if (!response.ok) throw apiError(`导入 ${input.filename} 失败`, response, body);
    return unwrapData(body) as KnowledgeFile;
  }

  private headers(includeCsrf: boolean): Record<string, string> {
    const headers: Record<string, string> = { cookie: this.cookie };
    if (includeCsrf) headers['x-csrf-token'] = this.csrfToken;
    return headers;
  }

  private url(path: string): string {
    return new URL(path, `${this.baseUrl.replace(/\/+$/, '')}/`).toString();
  }
}

export async function importLegacy(options: ImportOptions): Promise<ImportSummary> {
  const source = resolve(options.source);
  const sourceInfo = await stat(source).catch(() => undefined);
  if (!sourceInfo?.isDirectory()) throw new Error(`旧项目目录不存在：${source}`);

  const projectInputs = await discoverLegacyProjects(source);
  if (!projectInputs.length) throw new Error(`没有在 ${join(source, 'projects')} 找到项目 JSON`);
  const documents = await discoverMethodologyDocuments(source);
  const client = new LocalApiClient(options.baseUrl, options.username, options.password);
  await client.login();

  const workspaces = await client.get<Array<{ id: string; slug: string }>>('/api/workspaces');
  const workspace = workspaces.find((item) => item.slug === 'default') ?? workspaces[0];
  if (!workspace) throw new Error('当前账号没有可用工作区');

  const summary: ImportSummary = {
    projectsCreated: 0,
    projectsSkipped: 0,
    filesImported: 0,
    filesSkipped: 0,
  };
  const existingProjects = await client.get<ApiProject[]>('/api/projects');

  for (const input of projectInputs) {
    let project = existingProjects.find(
      (candidate) => candidate.slug.toLocaleLowerCase() === input.slug.toLocaleLowerCase(),
    );
    if (project) {
      summary.projectsSkipped += 1;
      console.log(`跳过已有项目：${project.name} (${project.slug})`);
    } else {
      project = await client.postJson<ApiProject>('/api/projects', {
        workspaceId: workspace.id,
        slug: input.slug,
        name: input.name,
        description: `从旧项目 ${input.relativePath} 导入`,
        profile: input.profile,
      });
      existingProjects.push(project);
      summary.projectsCreated += 1;
      console.log(`已创建项目：${project.name} (${project.slug})`);
    }

    const existingFiles = await client.get<KnowledgeFile[]>(
      `/api/knowledge?projectId=${encodeURIComponent(project.id)}`,
    );
    for (const document of documents) {
      const bytes = await readFile(document.absolutePath);
      const digest = sha256(bytes);
      const duplicate = existingFiles.some(
        (candidate) =>
          candidate.filename === document.filename &&
          (candidate.sha256 === digest || candidate.metadata?.sourceSha256 === digest),
      );
      if (duplicate) {
        summary.filesSkipped += 1;
        console.log(`  跳过相同文件：${document.filename}`);
        continue;
      }
      const imported = await client.uploadKnowledge({
        projectId: project.id,
        filename: document.filename,
        bytes,
        category: document.category,
        sourcePath: document.relativePath,
      });
      existingFiles.push(imported);
      summary.filesImported += 1;
      console.log(`  已导入知识：${document.filename}`);
    }
  }
  return summary;
}

export async function discoverLegacyProjects(source: string): Promise<
  Array<{ slug: string; name: string; profile: JsonObject; relativePath: string }>
> {
  const projectsDir = join(source, 'projects');
  const names = await readdir(projectsDir).catch(() => []);
  const result: Array<{ slug: string; name: string; profile: JsonObject; relativePath: string }> = [];
  for (const filename of names.sort((a, b) => a.localeCompare(b))) {
    if (filename.toLowerCase() === 'index.json' || extname(filename).toLowerCase() !== '.json') continue;
    const absolutePath = join(projectsDir, filename);
    let profile: JsonObject;
    try {
      const parsed: unknown = JSON.parse(await readFile(absolutePath, 'utf8'));
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
        throw new Error('根节点不是对象');
      }
      profile = parsed as JsonObject;
    } catch (error) {
      throw new Error(`无法解析项目文件 ${absolutePath}：${String(error)}`);
    }
    const slug =
      typeof profile.id === 'string' && profile.id.trim()
        ? profile.id.trim()
        : basename(filename, extname(filename));
    const name =
      typeof profile.name === 'string' && profile.name.trim() ? profile.name.trim() : slug;
    result.push({
      slug,
      name,
      profile,
      relativePath: `projects/${filename}`,
    });
  }
  return result;
}

export async function discoverMethodologyDocuments(source: string): Promise<
  Array<{ filename: string; absolutePath: string; relativePath: string; category: string }>
> {
  const entries = await readdir(source, { withFileTypes: true });
  return entries
    .filter((entry) => {
      if (!entry.isFile()) return false;
      const extension = extname(entry.name).toLowerCase();
      if (extension !== '.md' && extension !== '.txt') return false;
      return METHODOLOGY_NAME.test(entry.name) || /^_formula_.*\.md$/i.test(entry.name);
    })
    .sort((a, b) => a.name.localeCompare(b.name))
    .map((entry) => ({
      filename: entry.name,
      absolutePath: join(source, entry.name),
      relativePath: entry.name,
      category: categoryFor(entry.name),
    }));
}

export function parseArguments(argv: string[]): ImportOptions | { help: true } {
  const values = new Map<string, string>();
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index]!;
    if (argument === '--help' || argument === '-h') return { help: true };
    if (!argument.startsWith('--')) throw new Error(`无法识别的参数：${argument}`);
    const [rawKey, inlineValue] = argument.slice(2).split('=', 2);
    if (!rawKey) throw new Error(`无效参数：${argument}`);
    const value = inlineValue ?? argv[++index];
    if (!value || value.startsWith('--')) throw new Error(`参数 --${rawKey} 缺少值`);
    values.set(rawKey, value);
  }

  const scriptDir = dirname(fileURLToPath(import.meta.url));
  const password =
    values.get('password') ??
    process.env.CONTENT_AGENT_ADMIN_PASSWORD ??
    process.env.BOOTSTRAP_ADMIN_PASSWORD ??
    '';
  if (!password) throw new Error('必须通过 --password 或管理员密码环境变量提供密码');
  return {
    source: resolve(values.get('source') ?? resolve(scriptDir, '../..')),
    baseUrl: values.get('base-url') ?? 'http://127.0.0.1:8780',
    username:
      values.get('username') ??
      process.env.CONTENT_AGENT_ADMIN_USERNAME ??
      process.env.BOOTSTRAP_ADMIN_USERNAME ??
      'admin',
    password,
  };
}

function categoryFor(filename: string): string {
  if (filename.includes('提示词')) return 'prompts';
  if (filename.includes('对标内容')) return 'reference-corpus';
  if (filename.includes('评分体系')) return 'evaluation';
  if (filename.includes('公式') || filename.toLowerCase().includes('formula')) return 'formula';
  if (filename.includes('项目总索引')) return 'index';
  return 'methodology';
}

function sha256(value: Buffer): string {
  return createHash('sha256').update(value).digest('hex');
}

async function readResponse(response: Response): Promise<unknown> {
  const text = await response.text();
  if (!text) return undefined;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return text;
  }
}

function unwrapData(value: unknown): unknown {
  const body = value && typeof value === 'object' && !Array.isArray(value) ? (value as JsonObject) : undefined;
  return body && 'data' in body ? body.data : value;
}

function apiError(prefix: string, response: Response, body: unknown): Error {
  const detail = typeof body === 'string' ? body : JSON.stringify(body);
  return new Error(`${prefix}：HTTP ${response.status}${detail ? ` ${detail}` : ''}`);
}

function objectField(value: unknown, field: string): JsonObject {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  const fieldValue = (value as JsonObject)[field];
  return fieldValue && typeof fieldValue === 'object' && !Array.isArray(fieldValue)
    ? (fieldValue as JsonObject)
    : {};
}

function stringField(value: unknown, field: string): string {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`API 响应缺少 ${field}`);
  }
  const fieldValue = (value as JsonObject)[field];
  if (typeof fieldValue !== 'string' || !fieldValue) throw new Error(`API 响应缺少 ${field}`);
  return fieldValue;
}

function printHelp(): void {
  console.log(`旧项目导入工具

用法：
  npm run import:legacy -- --source .. --base-url http://127.0.0.1:8780 \\
    --username admin --password "your-password"

参数：
  --source       旧系统根目录，默认是 content-agent 的上一级目录
  --base-url     已运行的本地 API，默认 http://127.0.0.1:8780
  --username     管理员用户名，默认 admin
  --password     管理员密码；也可使用 CONTENT_AGENT_ADMIN_PASSWORD
`);
}

async function main(): Promise<void> {
  const options = parseArguments(process.argv.slice(2));
  if ('help' in options) {
    printHelp();
    return;
  }
  const summary = await importLegacy(options);
  console.log('\n导入完成：');
  console.log(`  新建项目 ${summary.projectsCreated}，跳过项目 ${summary.projectsSkipped}`);
  console.log(`  导入文件 ${summary.filesImported}，跳过文件 ${summary.filesSkipped}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
