import assert from 'node:assert/strict';
import { afterEach, describe, it } from 'node:test';

import { handleRequest, identifyRoute } from '../src/handle_request.js';

const originalFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = originalFetch; });

describe('route identification', () => {
  it('keeps official provider paths', () => {
    assert.deepEqual(route('/v1/chat/completions', { authorization: 'Bearer key' }), {
      protocol: 'openai', endpoint: 'chat/completions', path: '/v1/chat/completions',
    });
    assert.deepEqual(route('/v1/responses', { authorization: 'Bearer key' }), {
      protocol: 'openai', endpoint: 'responses', path: '/v1/responses',
    });
    assert.deepEqual(route('/v1/messages', { 'x-api-key': 'key', 'anthropic-version': '2023-06-01' }), {
      protocol: 'anthropic', endpoint: 'messages',
    });
    assert.deepEqual(route('/v1beta/models/gemini-test:generateContent', { 'x-goog-api-key': 'key' }), {
      protocol: 'gemini', path: '/v1beta/models/gemini-test:generateContent',
    });
    assert.deepEqual(route('/v1/batches/batch_123', { authorization: 'Bearer key' }), {
      protocol: 'openai', endpoint: 'passthrough', path: '/v1/batches/batch_123',
    });
  });

  it('resolves the /v1/models collision using credentials', () => {
    assert.equal(route('/v1/models', { authorization: 'Bearer key' }).protocol, 'openai');
    assert.equal(route('/v1/models', { 'x-goog-api-key': 'key' }).protocol, 'gemini');
  });
});

describe('gateway security', () => {
  it('keeps health public but protects API routes when configured', async () => {
    assert.equal((await handleRequest(request('/healthz'), { PROXY_TOKEN: 'secret' })).status, 200);
    const response = await handleRequest(request('/v1/models', { authorization: 'Bearer key' }), { PROXY_TOKEN: 'secret' });
    assert.equal(response.status, 401);
    assert.equal((await response.json()).error.type, 'invalid_proxy_token');
  });

  it('disables key verification by default', async () => {
    const response = await handleRequest(request('/verify', { 'x-goog-api-key': 'key' }, { method: 'POST' }));
    assert.equal(response.status, 404);
  });

  it('keeps CORS closed unless an origin is allowlisted', async () => {
    const closed = await handleRequest(request('/healthz', { origin: 'https://app.example' }));
    assert.equal(closed.headers.get('access-control-allow-origin'), null);
    const open = await handleRequest(request('/healthz', { origin: 'https://app.example' }), {
      CORS_ORIGINS: 'https://app.example',
    });
    assert.equal(open.headers.get('access-control-allow-origin'), 'https://app.example');
  });

  it('rejects oversized requests before reading them', async () => {
    const response = await handleRequest(request('/v1/chat/completions', {
      authorization: 'Bearer key', 'content-length': '101', 'content-type': 'application/json',
    }, { method: 'POST', body: '{}' }), { MAX_BODY_BYTES: '100' });
    assert.equal(response.status, 413);
  });

  it('creates, uses, and revokes a managed client token without exposing its hash', async () => {
    const data = new Map();
    const env = {
      ADMIN_TOKEN: 'admin-secret',
      GEMINI_API_KEYS: 'server-key',
      GGPROXY_ADMIN_KV: { get: async (key) => data.get(key) || null, put: async (key, value) => data.set(key, value) },
    };
    const unauthorized = await handleRequest(request('/admin/api/overview'), env);
    assert.equal(unauthorized.status, 401);

    const created = await handleRequest(jsonRequest('/admin/api/tokens', { name: 'Kelivo - Alice' }, {
      'x-admin-token': 'admin-secret',
    }), env);
    assert.equal(created.status, 201);
    const createdBody = await created.json();
    assert.match(createdBody.token, /^ggp_[a-f0-9]{48}$/);
    assert.equal(JSON.stringify(createdBody).includes('hash'), false);

    let upstreamKey;
    globalThis.fetch = async (_url, init) => {
      upstreamKey = new Headers(init.headers).get('x-goog-api-key');
      return new Response('{"models":[]}');
    };
    const allowed = await handleRequest(request('/v1/models', { authorization: `Bearer ${createdBody.token}` }), env);
    assert.equal(allowed.status, 200);
    assert.equal(upstreamKey, 'server-key');

    const revoked = await handleRequest(request(`/admin/api/tokens/${createdBody.record.id}`, {
      'x-admin-token': 'admin-secret',
    }, { method: 'DELETE' }), env);
    assert.equal(revoked.status, 204);
    const denied = await handleRequest(request('/v1/models', { authorization: `Bearer ${createdBody.token}` }), env);
    assert.equal(denied.status, 401);
  });
});

describe('protocol adapters', () => {
  it('transparently proxies Gemini paths without leaking the query key', async () => {
    let captured;
    globalThis.fetch = async (url, init) => {
      captured = { url: String(url), headers: new Headers(init.headers) };
      return new Response('{"ok":true}', { headers: { 'content-type': 'application/json' } });
    };
    const response = await handleRequest(request('/v1beta/models?key=secret'));
    assert.equal(response.status, 200);
    assert.equal(captured.url, 'https://generativelanguage.googleapis.com/v1beta/models');
    assert.equal(captured.headers.get('x-goog-api-key'), 'secret');
    assert.equal(captured.headers.get('x-goog-api-client').includes('ggproxy/2.0.0'), true);
  });

  it('passes the new Gemini Interactions path through unchanged', async () => {
    let target;
    globalThis.fetch = async (url) => {
      target = String(url);
      return new Response('{}', { headers: { 'content-type': 'application/json' } });
    };
    await handleRequest(jsonRequest('/v1/interactions', { model: 'gemini-test', input: 'hello' }, {
      'x-goog-api-key': 'key',
    }));
    assert.equal(target, 'https://generativelanguage.googleapis.com/v1/interactions');
  });

  it('prefers a request key over the configured server key pool', async () => {
    let upstreamKey;
    globalThis.fetch = async (_url, init) => {
      upstreamKey = new Headers(init.headers).get('x-goog-api-key');
      return new Response('{}');
    };
    await handleRequest(request('/v1beta/models', { 'x-goog-api-key': 'request-key' }), {
      GEMINI_API_KEYS: 'server-key',
    });
    assert.equal(upstreamKey, 'request-key');
  });

  it('forwards unimplemented OpenAI resources to Google compatibility routes', async () => {
    let captured;
    globalThis.fetch = async (url, init) => {
      captured = { url: String(url), headers: new Headers(init.headers) };
      return new Response('{"id":"batch_123"}', { headers: { 'content-type': 'application/json' } });
    };
    const response = await handleRequest(request('/v1/batches/batch_123', { authorization: 'Bearer gemini-key' }));
    assert.equal(response.status, 200);
    assert.equal(captured.url, 'https://generativelanguage.googleapis.com/v1beta/openai/batches/batch_123');
    assert.equal(captured.headers.get('authorization'), 'Bearer gemini-key');
  });

  it('converts OpenAI Chat Completions', async () => {
    globalThis.fetch = async () => geminiCompletion('Hello from Gemini');
    const response = await handleRequest(jsonRequest('/v1/chat/completions', {
      model: 'gpt-4o', messages: [{ role: 'user', content: 'Hello' }],
    }, { authorization: 'Bearer gemini-key' }));
    const body = await response.json();
    assert.equal(response.status, 200);
    assert.equal(body.object, 'chat.completion');
    assert.equal(body.choices[0].message.content, 'Hello from Gemini');
  });

  it('normalizes Gemini failures to the OpenAI error shape', async () => {
    globalThis.fetch = async () => new Response(JSON.stringify({
      error: { message: 'bad key', status: 'UNAUTHENTICATED' },
    }), { status: 401, headers: { 'content-type': 'application/json' } });
    const response = await handleRequest(jsonRequest('/v1/chat/completions', {
      model: 'gpt-4o', messages: [{ role: 'user', content: 'Hello' }],
    }, { authorization: 'Bearer bad-key' }));
    const body = await response.json();
    assert.equal(response.status, 401);
    assert.equal(body.error.type, 'unauthenticated');
  });

  it('maps OpenAI tool results to a Gemini user function response', async () => {
    let upstreamBody;
    globalThis.fetch = async (_url, init) => {
      upstreamBody = JSON.parse(init.body);
      return geminiCompletion('done');
    };
    await handleRequest(jsonRequest('/v1/chat/completions', {
      model: 'gemini-test',
      messages: [
        { role: 'user', content: 'weather?' },
        { role: 'assistant', content: null, tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'weather', arguments: '{"city":"Paris"}' } }] },
        { role: 'tool', tool_call_id: 'call_1', content: '{"temperature":20}' },
      ],
    }, { authorization: 'Bearer key' }));
    assert.equal(upstreamBody.contents[2].role, 'user');
    assert.equal(upstreamBody.contents[2].parts[0].functionResponse.name, 'weather');
  });

  it('converts OpenAI Responses', async () => {
    globalThis.fetch = async () => geminiCompletion('Response text');
    const response = await handleRequest(jsonRequest('/v1/responses', {
      model: 'gpt-5', input: 'Hello',
    }, { authorization: 'Bearer gemini-key' }));
    const body = await response.json();
    assert.equal(body.object, 'response');
    assert.equal(body.output[0].content[0].text, 'Response text');
  });

  it('converts Claude Messages', async () => {
    globalThis.fetch = async () => geminiCompletion('Claude-shaped response');
    const response = await handleRequest(jsonRequest('/v1/messages', {
      model: 'claude-sonnet', max_tokens: 100,
      messages: [{ role: 'user', content: 'Hello' }],
    }, { 'x-api-key': 'gemini-key', 'anthropic-version': '2023-06-01' }));
    const body = await response.json();
    assert.equal(body.type, 'message');
    assert.equal(body.content[0].text, 'Claude-shaped response');
    assert.equal(body.usage.input_tokens, 3);
  });

  it('preserves tool names when converting Claude tool results', async () => {
    let upstreamBody;
    globalThis.fetch = async (_url, init) => {
      upstreamBody = JSON.parse(init.body);
      return geminiCompletion('done');
    };
    await handleRequest(jsonRequest('/v1/messages', {
      model: 'claude-sonnet', max_tokens: 100,
      messages: [
        { role: 'assistant', content: [{ type: 'tool_use', id: 'tool-1', name: 'weather', input: { city: 'Paris' } }] },
        { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'tool-1', content: 'sunny' }] },
      ],
    }, { 'x-api-key': 'gemini-key', 'anthropic-version': '2023-06-01' }));
    assert.equal(upstreamBody.contents[1].parts[0].functionResponse.name, 'weather');
  });

  it('translates streaming output for all compatibility protocols', async () => {
    globalThis.fetch = async () => geminiStream('streamed');
    const openai = await handleRequest(jsonRequest('/v1/chat/completions', {
      model: 'gpt-4o', stream: true, messages: [{ role: 'user', content: 'Hello' }],
    }, { authorization: 'Bearer key' }));
    assert.match(await openai.text(), /data: \[DONE\]/);

    globalThis.fetch = async () => geminiStream('response delta');
    const responses = await handleRequest(jsonRequest('/v1/responses', {
      model: 'gpt-5', stream: true, input: 'Hello',
    }, { authorization: 'Bearer key' }));
    assert.match(await responses.text(), /event: response\.output_text\.delta/);

    globalThis.fetch = async () => geminiStream('claude delta');
    const anthropic = await handleRequest(jsonRequest('/v1/messages', {
      model: 'claude-sonnet', stream: true, max_tokens: 100,
      messages: [{ role: 'user', content: 'Hello' }],
    }, { 'x-api-key': 'key', 'anthropic-version': '2023-06-01' }));
    const anthropicText = await anthropic.text();
    assert.match(anthropicText, /event: message_start/);
    assert.match(anthropicText, /event: message_stop/);
  });
});

function route(path, headers = {}) {
  return identifyRoute(request(path, headers));
}

function request(path, headers = {}, init = {}) {
  return new Request(`https://proxy.example${path}`, { ...init, headers });
}

function jsonRequest(path, body, headers = {}) {
  return request(path, { 'content-type': 'application/json', ...headers }, {
    method: 'POST', body: JSON.stringify(body),
  });
}

function geminiCompletion(text) {
  return new Response(JSON.stringify({
    candidates: [{ index: 0, content: { role: 'model', parts: [{ text }] }, finishReason: 'STOP' }],
    modelVersion: 'gemini-test',
    usageMetadata: { promptTokenCount: 3, candidatesTokenCount: 4, totalTokenCount: 7 },
  }), { status: 200, headers: { 'content-type': 'application/json' } });
}

function geminiStream(text) {
  const event = {
    candidates: [{ index: 0, content: { role: 'model', parts: [{ text }] }, finishReason: 'STOP' }],
    modelVersion: 'gemini-test',
    usageMetadata: { promptTokenCount: 3, candidatesTokenCount: 4, totalTokenCount: 7 },
  };
  return new Response(`data: ${JSON.stringify(event)}\n\n`, {
    status: 200, headers: { 'content-type': 'text/event-stream' },
  });
}
