import { lookup as dnsLookup } from 'node:dns/promises';
import ipaddr from 'ipaddr.js';
import { Agent, buildConnector, fetch as undiciFetch, type Dispatcher } from 'undici';

export interface ByokUrlPolicy {
  allowHttp?: boolean;
  allowPrivateNetwork?: boolean;
}

export interface PinnedModelTarget {
  address: string;
  family: 4 | 6;
  hostname: string;
  protocol: 'http:' | 'https:';
}

export interface SafeModelDispatcher {
  dispatcher: Dispatcher;
  close(): Promise<void>;
}

type LookupResult = { address: string; family: number };
type Lookup = (hostname: string) => Promise<LookupResult[]>;
type ModelRequestInit = Omit<RequestInit, 'dispatcher'>;
type TransportFetch = (
  input: Parameters<typeof globalThis.fetch>[0],
  init: ModelRequestInit & { dispatcher: Dispatcher },
) => Promise<Response>;
type DispatcherFactory = (target: PinnedModelTarget) => SafeModelDispatcher;
type Connector = ReturnType<typeof buildConnector>;

export interface SafeModelFetchOptions extends ByokUrlPolicy {
  lookup?: Lookup;
  transportFetch?: TransportFetch;
  dispatcherFactory?: DispatcherFactory;
  maxRedirects?: number;
  maxResponseBytes?: number;
}

const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);
const BODYLESS_STATUSES = new Set([204, 205, 304]);
export const DEFAULT_MAX_MODEL_RESPONSE_BYTES = 8 * 1024 * 1024;

function normalizedIp(value: string): ReturnType<typeof ipaddr.parse> {
  return ipaddr.process(value);
}

function isPublicIp(value: string): boolean {
  try {
    return normalizedIp(value).range() === 'unicast';
  } catch {
    return false;
  }
}

function normalizedHostname(url: URL): string {
  const hostname = url.hostname.startsWith('[') && url.hostname.endsWith(']')
    ? url.hostname.slice(1, -1)
    : url.hostname;
  return hostname.replace(/\.$/u, '').toLowerCase();
}

function assertSafeHost(url: URL, allowPrivateNetwork: boolean): void {
  const hostname = normalizedHostname(url);
  if (!hostname) throw new Error('BYOK API Base URL 缺少主机名');
  if (!allowPrivateNetwork && (hostname === 'localhost' || hostname.endsWith('.localhost'))) {
    throw new Error('BYOK API Base URL 必须使用公网主机');
  }
  if (ipaddr.isValid(hostname) && !allowPrivateNetwork && !isPublicIp(hostname)) {
    throw new Error('BYOK API Base URL 必须使用公网地址');
  }
}

export function validateByokBaseUrl(value: string, policy: ByokUrlPolicy = {}): string {
  const normalizedValue = value.trim();
  let url: URL;
  try {
    url = new URL(normalizedValue);
  } catch {
    throw new Error('BYOK API Base URL 无效');
  }
  if (url.protocol !== 'https:' && !(policy.allowHttp && url.protocol === 'http:')) {
    throw new Error(policy.allowHttp
      ? 'BYOK API Base URL 只支持 HTTP/HTTPS'
      : 'BYOK API Base URL 必须使用 HTTPS');
  }
  if (url.username || url.password) throw new Error('BYOK API Base URL 不能包含用户名或密码');
  if (normalizedValue.includes('?')) throw new Error('BYOK API Base URL 不能包含查询参数');
  if (normalizedValue.includes('#')) throw new Error('BYOK API Base URL 不能包含片段');
  assertSafeHost(url, policy.allowPrivateNetwork === true);
  return url.toString().replace(/\/$/u, '');
}

export function createPinnedConnector(
  target: PinnedModelTarget,
  underlying: Connector = buildConnector({
    family: target.family,
    port: target.protocol === 'https:' ? 443 : 80,
  }),
): Connector {
  return (options, callback) => {
    underlying({
      ...options,
      hostname: target.address,
      servername: target.protocol === 'https:' ? target.hostname : options.servername,
    }, callback);
  };
}

function defaultDispatcherFactory(target: PinnedModelTarget): SafeModelDispatcher {
  const dispatcher = new Agent({ connect: createPinnedConnector(target) });
  return {
    dispatcher,
    close: async () => { await dispatcher.close(); },
  };
}

async function defaultLookup(hostname: string): Promise<LookupResult[]> {
  return dnsLookup(hostname, { all: true, verbatim: true });
}

async function resolveTarget(
  url: URL,
  lookup: Lookup,
  allowPrivateNetwork: boolean,
): Promise<PinnedModelTarget> {
  const hostname = normalizedHostname(url);
  assertSafeHost(url, allowPrivateNetwork);
  let results: LookupResult[];
  try {
    results = ipaddr.isValid(hostname)
      ? [{ address: hostname, family: normalizedIp(hostname).kind() === 'ipv4' ? 4 : 6 }]
      : await lookup(hostname);
  } catch {
    throw new Error('BYOK 模型主机 DNS 解析失败');
  }
  if (!results.length) throw new Error('BYOK 模型主机 DNS 未返回地址');
  if (results.some((result) => !ipaddr.isValid(result.address))) {
    throw new Error('BYOK 模型主机 DNS 返回了无效地址');
  }
  if (!allowPrivateNetwork && results.some((result) => !isPublicIp(result.address))) {
    throw new Error('BYOK 模型主机 DNS 必须全部解析到公网地址');
  }
  const selected = results[0];
  if (!selected) throw new Error('BYOK 模型主机 DNS 未返回地址');
  const address = normalizedIp(selected.address);
  return {
    address: address.toString(),
    family: address.kind() === 'ipv4' ? 4 : 6,
    hostname,
    protocol: url.protocol as 'http:' | 'https:',
  };
}

function normalizeRequest(
  input: Parameters<typeof globalThis.fetch>[0],
  init: RequestInit,
): Request {
  const sanitizedInit = { ...init } as RequestInit & { dispatcher?: unknown };
  delete sanitizedInit.dispatcher;
  return new Request(input, sanitizedInit);
}

function copiedRequestInit(request: Request, includeBody: boolean): ModelRequestInit {
  const copied: ModelRequestInit & { duplex?: 'half' } = {
    method: request.method,
    headers: new Headers(request.headers),
    cache: request.cache,
    credentials: request.credentials,
    integrity: request.integrity,
    keepalive: request.keepalive,
    mode: request.mode,
    redirect: request.redirect,
    referrer: request.referrer,
    referrerPolicy: request.referrerPolicy,
    signal: request.signal,
  };
  if (includeBody && request.body) {
    copied.body = request.body;
    copied.duplex = 'half';
  }
  return copied;
}

function redirectedRequest(status: number, request: Request, url: URL): Request {
  const method = request.method.toUpperCase();
  const becomesGet = ((status === 301 || status === 302) && method === 'POST')
    || (status === 303 && method !== 'GET' && method !== 'HEAD');
  const copied = copiedRequestInit(request, !becomesGet);
  if (becomesGet) {
    copied.method = 'GET';
    copied.body = undefined;
    const headers = new Headers(copied.headers);
    for (const name of [
      'content-encoding',
      'content-language',
      'content-length',
      'content-location',
      'content-type',
      'transfer-encoding',
    ]) headers.delete(name);
    copied.headers = headers;
  }
  return new Request(url, copied);
}

function responseSizeLimit(options: SafeModelFetchOptions): number {
  const configured = options.maxResponseBytes;
  return typeof configured === 'number' && Number.isFinite(configured) && configured >= 0
    ? Math.floor(configured)
    : DEFAULT_MAX_MODEL_RESPONSE_BYTES;
}

function redirectLimit(options: SafeModelFetchOptions): number {
  const configured = options.maxRedirects;
  return typeof configured === 'number' && Number.isFinite(configured) && configured >= 0
    ? Math.floor(configured)
    : 5;
}

async function bufferedResponse(response: Response, maxBytes: number): Promise<Response> {
  const hasBody = !BODYLESS_STATUSES.has(response.status) && response.body !== null;
  const declaredLength = response.headers.get('content-length');
  if (hasBody && declaredLength && /^\d+$/u.test(declaredLength)
    && BigInt(declaredLength) > BigInt(maxBytes)) {
    await response.body?.cancel().catch(() => undefined);
    throw new Error('BYOK 模型响应超过大小限制');
  }

  let body: Uint8Array | null = null;
  if (hasBody && response.body) {
    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let received = 0;
    try {
      while (true) {
        const chunk = await reader.read();
        if (chunk.done) break;
        received += chunk.value.byteLength;
        if (received > maxBytes) {
          await reader.cancel().catch(() => undefined);
          throw new Error('BYOK 模型响应超过大小限制');
        }
        chunks.push(chunk.value);
      }
    } finally {
      reader.releaseLock();
    }
    body = new Uint8Array(received);
    let offset = 0;
    for (const chunk of chunks) {
      body.set(chunk, offset);
      offset += chunk.byteLength;
    }
  }
  return new Response(body, {
    status: response.status,
    statusText: response.statusText,
    headers: response.headers,
  });
}

export function createSafeModelFetch(options: SafeModelFetchOptions = {}): typeof globalThis.fetch {
  const lookup = options.lookup ?? defaultLookup;
  const transportFetch = options.transportFetch ?? (undiciFetch as unknown as TransportFetch);
  const dispatcherFactory = options.dispatcherFactory ?? defaultDispatcherFactory;
  const allowPrivateNetwork = options.allowPrivateNetwork === true;
  const maxRedirects = redirectLimit(options);
  const maxResponseBytes = responseSizeLimit(options);

  return (async (input, init = {}) => {
    let request = normalizeRequest(input, init);
    let url = new URL(request.url);
    const originalOrigin = url.origin;

    for (let redirects = 0; ; redirects += 1) {
      validateByokBaseUrl(url.toString(), options);
      const target = await resolveTarget(url, lookup, allowPrivateNetwork);
      const active = dispatcherFactory(target);
      let response: Response;
      try {
        const outbound = request.clone();
        response = await transportFetch(url, {
          ...copiedRequestInit(outbound, true),
          dispatcher: active.dispatcher,
          redirect: 'manual',
        });
        response = await bufferedResponse(response, maxResponseBytes);
      } finally {
        await active.close();
      }

      if (!REDIRECT_STATUSES.has(response.status)) return response;
      if (redirects >= maxRedirects) throw new Error('BYOK 模型请求重定向次数过多');
      const location = response.headers.get('location');
      if (!location) return response;
      const redirected = new URL(location, url);
      if (redirected.origin !== originalOrigin) {
        throw new Error('BYOK 模型请求只允许同源重定向');
      }
      request = redirectedRequest(response.status, request, redirected);
      url = redirected;
    }
  }) as typeof globalThis.fetch;
}
