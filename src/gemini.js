import {
  copyRequestHeaders, copyResponseHeaders, fetchWithTimeout, selectApiKey,
} from './security.js';
import { assertModelAllowed, filterAllowedModels } from './model_policy.js';

export const GEMINI_ORIGIN = 'https://generativelanguage.googleapis.com';

export async function proxyGemini(request, config) {
  const incoming = new URL(request.url);
  const target = new URL(incoming.pathname + incoming.search, GEMINI_ORIGIN);
  const model = incoming.pathname.match(/\/models\/([^/:]+)/)?.[1];
  if (model) assertModelAllowed(decodeURIComponent(model), config);
  const key = selectApiKey(request, config, 'gemini');
  target.searchParams.delete('key');

  const headers = copyRequestHeaders(request.headers);
  headers.set('x-goog-api-key', key);
  headers.set('x-goog-api-client', appendClientHeader(headers.get('x-goog-api-client')));
  const response = await fetchWithTimeout(target, {
    method: request.method,
    headers,
    body: allowsBody(request.method) ? request.body : undefined,
    signal: request.signal,
    redirect: 'manual',
  }, config.upstreamTimeoutMs);

  if (/^\/(v1|v1beta)\/models$/.test(incoming.pathname) && config.allowedModels?.length && response.ok) {
    const payload = await response.json();
    return new Response(JSON.stringify({ ...payload, models: filterAllowedModels(payload.models || [], config) }), {
      status: response.status, statusText: response.statusText, headers: copyResponseHeaders(response.headers),
    });
  }
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers: copyResponseHeaders(response.headers),
  });
}

export async function callGemini(path, { apiKey, body, config, signal, headers: extraHeaders }) {
  const headers = new Headers(extraHeaders);
  headers.set('content-type', 'application/json');
  headers.set('x-goog-api-key', apiKey);
  headers.set('x-goog-api-client', appendClientHeader(headers.get('x-goog-api-client')));
  return fetchWithTimeout(`${GEMINI_ORIGIN}${path}`, {
    method: 'POST', headers, body: JSON.stringify(body), signal,
  }, config.upstreamTimeoutMs);
}

function appendClientHeader(existing) {
  const marker = 'ggproxy/2.0.0';
  return existing ? `${existing} ${marker}` : marker;
}

function allowsBody(method) {
  return !['GET', 'HEAD'].includes(method.toUpperCase());
}
