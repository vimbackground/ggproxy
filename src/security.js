const HOP_BY_HOP = new Set([
  'connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization',
  'te', 'trailer', 'transfer-encoding', 'upgrade', 'host',
]);

const SENSITIVE = new Set([
  'authorization', 'cookie', 'set-cookie', 'x-api-key', 'x-goog-api-key',
  'x-proxy-token',
]);

export class HttpError extends Error {
  constructor(message, status = 500, code = 'internal_error') {
    super(message);
    this.status = status;
    this.code = code;
  }
}

export function requestId(request) {
  const supplied = request.headers.get('x-client-request-id');
  if (supplied && /^[A-Za-z0-9._:-]{1,128}$/.test(supplied)) return supplied;
  return globalThis.crypto?.randomUUID?.() ?? `req_${Date.now().toString(36)}`;
}

export async function enforceGatewayAuth(request, config, env) {
  const proxyHeader = request.headers.get('x-proxy-token');
  const authorization = request.headers.get('authorization') || '';
  const bearerToken = /^Bearer\s+(.+)$/i.exec(authorization)?.[1]?.trim() || '';
  const geminiHeader = request.headers.get('x-goog-api-key') || '';
  const queryKey = new URL(request.url).searchParams.get('key') || '';
  const hasAdminStore = Boolean(env?.GGPROXY_ADMIN_KV || (config.adminStoreUrl && config.adminStoreToken));
  if (!config.proxyTokens.length && !hasAdminStore) return { credentialSource: '', useManagedPool: false, isManagedToken: false };
  for (const [actual, credentialSource] of [
    [proxyHeader, 'proxy_header'], [bearerToken, 'authorization'], [geminiHeader, 'gemini_header'], [queryKey, 'query'],
  ]) {
    if (actual && config.proxyTokens.some((token) => constantTimeEqual(actual, token))) {
      return { credentialSource, useManagedPool: credentialSource !== 'proxy_header', isManagedToken: false };
    }
  }
  const { isManagedTokenValid } = await import('./admin.js');
  for (const [actual, credentialSource] of [
    [proxyHeader, 'proxy_header'], [bearerToken, 'authorization'], [geminiHeader, 'gemini_header'], [queryKey, 'query'],
  ]) {
    if (await isManagedTokenValid(actual, env, config)) {
      return { credentialSource, useManagedPool: credentialSource !== 'proxy_header', isManagedToken: true };
    }
  }
  throw new HttpError('Invalid proxy credentials', 401, 'invalid_proxy_token');
}

export function constantTimeEqual(left, right) {
  const a = new TextEncoder().encode(left);
  const b = new TextEncoder().encode(right);
  let mismatch = a.length ^ b.length;
  const length = Math.max(a.length, b.length);
  for (let i = 0; i < length; i += 1) mismatch |= (a[i] ?? 0) ^ (b[i] ?? 0);
  return mismatch === 0;
}

export function enforceBodySize(request, config) {
  const raw = request.headers.get('content-length');
  if (!raw) return;
  const size = Number(raw);
  if (!Number.isFinite(size) || size < 0) {
    throw new HttpError('Invalid Content-Length', 400, 'invalid_content_length');
  }
  if (size > config.maxBodyBytes) {
    throw new HttpError('Request body is too large', 413, 'request_too_large');
  }
}

export async function readJsonLimited(request, maxBytes) {
  const bytes = new Uint8Array(await request.arrayBuffer());
  if (bytes.byteLength > maxBytes) {
    throw new HttpError('Request body is too large', 413, 'request_too_large');
  }
  try {
    return JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    throw new HttpError('Request body must be valid JSON', 400, 'invalid_json');
  }
}

export function copyRequestHeaders(input, { dropCredentials = false } = {}) {
  const output = new Headers();
  for (const [name, value] of input.entries()) {
    const lower = name.toLowerCase();
    if (HOP_BY_HOP.has(lower) || lower === 'x-proxy-token') continue;
    if (lower.startsWith('cf-') || lower.startsWith('x-forwarded-')) continue;
    if (dropCredentials && SENSITIVE.has(lower)) continue;
    output.set(name, value);
  }
  return output;
}

export function copyResponseHeaders(input) {
  const output = new Headers();
  for (const [name, value] of input.entries()) {
    if (!HOP_BY_HOP.has(name.toLowerCase())) output.set(name, value);
  }
  output.set('referrer-policy', 'no-referrer');
  output.set('x-content-type-options', 'nosniff');
  return output;
}

export function selectApiKey(request, config, protocol = 'gemini') {
  let raw = '';
  if (protocol === 'anthropic') raw = request.headers.get('x-api-key') || '';
  if (!raw && protocol === 'gemini') raw = request.headers.get('x-goog-api-key') || '';
  if (!raw) {
    const auth = request.headers.get('authorization') || '';
    if (/^Bearer\s+/i.test(auth)) raw = auth.replace(/^Bearer\s+/i, '');
  }
  if (!raw && protocol === 'gemini') raw = new URL(request.url).searchParams.get('key') || '';
  const candidates = raw ? raw.split(',') : config.geminiApiKeys;
  const keys = candidates
    .map((key) => key.trim())
    .filter(Boolean);
  if (!keys.length) throw new HttpError('Missing upstream API key', 401, 'missing_api_key');
  const random = new Uint32Array(1);
  globalThis.crypto?.getRandomValues?.(random);
  return keys[(random[0] || Math.floor(Math.random() * 0xffffffff)) % keys.length];
}

export function corsHeaders(request, config) {
  const origin = request.headers.get('origin');
  if (!origin || !config.corsOrigins.length) return new Headers();
  if (!config.corsOrigins.includes('*') && !config.corsOrigins.includes(origin)) return new Headers();
  const headers = new Headers({
    'access-control-allow-origin': config.corsOrigins.includes('*') ? '*' : origin,
    'access-control-allow-methods': 'GET, POST, PUT, PATCH, DELETE, OPTIONS',
    'access-control-allow-headers': 'authorization, content-type, x-api-key, x-goog-api-key, anthropic-version, anthropic-beta, x-proxy-token, x-client-request-id',
    'access-control-expose-headers': 'x-request-id',
    'access-control-max-age': '86400',
  });
  if (!config.corsOrigins.includes('*')) headers.set('vary', 'Origin');
  return headers;
}

export function withCors(response, request, config, id) {
  const headers = new Headers(response.headers);
  for (const [key, value] of corsHeaders(request, config)) headers.set(key, value);
  headers.set('x-request-id', id);
  headers.set('x-content-type-options', 'nosniff');
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
}

export function jsonError(error, protocol = 'gemini', id = '') {
  const status = Number.isInteger(error?.status) ? error.status : 500;
  const message = status >= 500 ? 'Upstream or gateway error' : (error?.message || 'Request failed');
  const code = error?.code || (status >= 500 ? 'internal_error' : 'invalid_request');
  let body;
  if (protocol === 'openai') {
    body = { error: { message, type: code, param: null, code } };
  } else if (protocol === 'anthropic') {
    body = { type: 'error', error: { type: code, message }, request_id: id };
  } else {
    body = { error: { code: status, message, status: code.toUpperCase() } };
  }
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8' },
  });
}

export async function fetchWithTimeout(url, init, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort('upstream timeout'), timeoutMs);
  const source = init.signal;
  const abort = () => controller.abort(source?.reason);
  if (source?.aborted) abort();
  source?.addEventListener?.('abort', abort, { once: true });
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } catch (error) {
    if (controller.signal.aborted && !source?.aborted) {
      throw new HttpError('Upstream request timed out', 504, 'upstream_timeout');
    }
    throw error;
  } finally {
    clearTimeout(timer);
    source?.removeEventListener?.('abort', abort);
  }
}
