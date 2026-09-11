import { handleAnthropic } from './anthropic.js';
import { getConfig } from './config.js';
import { proxyGemini } from './gemini.js';
import openai from './openai.mjs';
import {
  HttpError, corsHeaders, enforceBodySize, enforceGatewayAuth, jsonError,
  requestId, withCors,
} from './security.js';
import { handleVerification } from './verify_keys.js';
import { handleAdminRequest } from './admin.js';
import { resolveManagedGatewayConfig } from './admin.js';

export async function handleRequest(request, env = {}) {
  const config = getConfig(env);
  const id = requestId(request);
  const startedAt = Date.now();
  const route = identifyRoute(request);
  let response;

  try {
    if (request.method === 'OPTIONS') {
      response = new Response(null, { status: 204, headers: corsHeaders(request, config) });
      return withCors(response, request, config, id);
    }

    if (route.kind === 'home') {
      response = new Response(JSON.stringify({
        name: 'ggproxy', status: 'ok', protocols: ['gemini', 'openai', 'anthropic'],
      }), { headers: { 'content-type': 'application/json; charset=utf-8' } });
      return withCors(response, request, config, id);
    }

    if (route.kind === 'admin') {
      response = await handleAdminRequest(request, env, config, route.path);
      return withCors(response, request, config, id);
    }

    const gatewayAuth = route.authMode === 'byok'
      ? { usedAuthorization: false, useManagedPool: false }
      : await enforceGatewayAuth(request, config, env);
    const upstreamRequest = gatewayAuth.usedAuthorization ? stripGatewayAuthorization(request) : request;
    const activeConfig = gatewayAuth.useManagedPool ? await resolveManagedGatewayConfig(env, config) : config;
    enforceBodySize(upstreamRequest, config);

    if (route.kind === 'verify') {
      if (!activeConfig.verifyEnabled) throw new HttpError('Key verification is disabled', 404, 'not_found');
      response = await handleVerification(upstreamRequest, activeConfig);
    } else if (route.protocol === 'gemini') {
      response = await proxyGemini(rewriteRequestPath(upstreamRequest, route.path), activeConfig);
    } else if (route.protocol === 'openai') {
      response = await openai.fetch(upstreamRequest, { config: activeConfig, endpoint: route.endpoint, path: route.path });
    } else if (route.protocol === 'anthropic') {
      response = await handleAnthropic(upstreamRequest, { config: activeConfig, endpoint: route.endpoint });
    } else {
      throw new HttpError('Route not found', 404, 'not_found');
    }
  } catch (error) {
    response = jsonError(error, route.protocol || 'gemini', id);
  }

  console.log(JSON.stringify({
    request_id: id,
    protocol: route.protocol || route.kind,
    path: new URL(request.url).pathname,
    method: request.method,
    status: response.status,
    duration_ms: Date.now() - startedAt,
  }));
  return withCors(response, request, config, id);
}

export function identifyRoute(request) {
  const url = new URL(request.url);
  const path = normalizePath(url.pathname);
  if (path === '/' || path === '/index.html' || path === '/healthz') return { kind: 'home' };
  if (path === '/admin' || path.startsWith('/admin/api/')) return { kind: 'admin', path };
  if (path === '/verify') return { kind: 'verify', protocol: 'gemini' };
  if (path === '/byok' || path.startsWith('/byok/')) {
    const route = identifyApiRoute(path.slice('/byok'.length) || '/', request);
    return { ...route, authMode: 'byok' };
  }
  return identifyApiRoute(path, request);
}

function identifyApiRoute(initialPath, request) {
  let path = initialPath;
  let explicitProtocol = '';
  for (const [prefix, protocol] of [['/gemini', 'gemini'], ['/openai', 'openai'], ['/anthropic', 'anthropic']]) {
    if (path === prefix || path.startsWith(`${prefix}/`)) {
      explicitProtocol = protocol;
      path = path.slice(prefix.length) || '/';
      break;
    }
  }

  const openaiEndpoint = matchOpenAI(path);
  const anthropicEndpoint = matchAnthropic(path);
  if (explicitProtocol === 'openai') return { protocol: 'openai', endpoint: openaiEndpoint || 'passthrough', path };
  if (explicitProtocol === 'anthropic') return { protocol: 'anthropic', endpoint: anthropicEndpoint };
  if (explicitProtocol === 'gemini') return { protocol: 'gemini', path };

  if (anthropicEndpoint) return { protocol: 'anthropic', endpoint: anthropicEndpoint };
  if (openaiEndpoint && isOpenAIRoute(path, request)) {
    return { protocol: 'openai', endpoint: openaiEndpoint, path };
  }
  if (path.startsWith('/v1beta/openai/')) {
    return { protocol: 'openai', endpoint: 'passthrough', path };
  }
  if (path.startsWith('/v1/') && request.headers.has('authorization') && !request.headers.has('x-goog-api-key')) {
    return { protocol: 'openai', endpoint: 'passthrough', path };
  }
  if (/^\/(v1|v1beta)(\/|$)/.test(path) || /^\/upload\/(v1|v1beta)(\/|$)/.test(path)) {
    return { protocol: 'gemini', path };
  }
  return { kind: 'not_found' };
}

function matchOpenAI(path) {
  const stripped = path.replace(/^\/v1beta\/openai\//, '/').replace(/^\/v1\//, '/');
  const endpoints = new Map([
    ['/chat/completions', 'chat/completions'], ['/completions', 'completions'],
    ['/responses', 'responses'], ['/embeddings', 'embeddings'], ['/models', 'models'],
  ]);
  return endpoints.get(stripped) || '';
}

function matchAnthropic(path) {
  if (path === '/v1/messages') return 'messages';
  if (path === '/v1/messages/count_tokens') return 'messages/count_tokens';
  return '';
}

function isOpenAIRoute(path, request) {
  if (path.startsWith('/v1beta/openai/')) return true;
  if (path === '/v1/models') {
    if (request.headers.has('x-goog-api-key')) return false;
    return request.headers.has('authorization');
  }
  return true;
}

function normalizePath(path) {
  if (path.length > 1 && path.endsWith('/')) return path.slice(0, -1);
  return path;
}

function rewriteRequestPath(request, path) {
  const url = new URL(request.url);
  url.pathname = path;
  return new Request(url, request);
}

function stripGatewayAuthorization(request) {
  const headers = new Headers(request.headers);
  headers.delete('authorization');
  return new Request(request, { headers });
}
