import { fetchWithTimeout, HttpError } from './security.js';

const VERIFY_URL = 'https://generativelanguage.googleapis.com/v1beta/models?pageSize=1';
const MAX_KEYS = 20;

async function verifyKey(key, controller, config) {
  let result;
  try {
    const response = await fetchWithTimeout(VERIFY_URL, {
      method: 'GET', headers: { 'x-goog-api-key': key },
    }, Math.min(config.upstreamTimeoutMs, 15_000));
    if (response.ok) {
      await response.body?.cancel();
      result = { key: maskKey(key), status: 'GOOD' };
    } else {
      let message = `HTTP ${response.status}`;
      try { message = (await response.json()).error?.message || message; } catch { /* ignore */ }
      result = { key: maskKey(key), status: 'BAD', error: message };
    }
  } catch (error) {
    result = { key: maskKey(key), status: 'ERROR', error: error.message };
  }
  controller.enqueue(new TextEncoder().encode(`data: ${JSON.stringify(result)}\n\n`));
}

export async function handleVerification(request, config) {
  if (request.method !== 'POST') throw new HttpError('Method not allowed', 405, 'method_not_allowed');
  const raw = request.headers.get('x-goog-api-key');
  if (!raw) throw new HttpError('Missing x-goog-api-key header', 400, 'missing_api_key');
  const keys = raw.split(',').map((key) => key.trim()).filter(Boolean);
  if (!keys.length || keys.length > MAX_KEYS) {
    throw new HttpError(`Provide between 1 and ${MAX_KEYS} keys`, 400, 'invalid_key_count');
  }
  const stream = new ReadableStream({
    async start(controller) {
      await Promise.all(keys.map((key) => verifyKey(key, controller, config)));
      controller.close();
    },
  });
  return new Response(stream, {
    headers: { 'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-cache' },
  });
}

function maskKey(key) {
  if (key.length < 12) return '***';
  return `${key.slice(0, 4)}...${key.slice(-4)}`;
}
