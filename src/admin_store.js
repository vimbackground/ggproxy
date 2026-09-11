const TOKEN_RECORD_KEY = 'ggproxy:client-tokens:v1';
const UPSTREAM_KEY_RECORD_KEY = 'ggproxy:upstream-keys:v1';
const POLICY_RECORD_KEY = 'ggproxy:service-policy:v1';

const DEFAULT_POLICY = Object.freeze({ strategy: 'random', allowedModels: [], nextIndex: 0 });

export function getAdminStore(env, config) {
  const kv = env?.GGPROXY_ADMIN_KV;
  if (kv && typeof kv.get === 'function' && typeof kv.put === 'function') {
    return {
      type: 'cloudflare-kv',
      get: (key) => kv.get(key),
      put: (key, value) => kv.put(key, value),
    };
  }

  if (config.adminStoreUrl && config.adminStoreToken) {
    return createRestStore(config.adminStoreUrl, config.adminStoreToken);
  }
  return null;
}

function createRestStore(baseUrl, token) {
  const base = baseUrl.replace(/\/$/, '');
  const headers = { authorization: `Bearer ${token}` };
  return {
    type: 'rest-kv',
    async get(key) {
      const response = await fetch(`${base}/get/${encodeURIComponent(key)}`, { headers });
      const body = await parseStoreResponse(response);
      return body.result == null ? null : String(body.result);
    },
    async put(key, value) {
      const response = await fetch(`${base}/set/${encodeURIComponent(key)}`, {
        method: 'POST',
        headers: { ...headers, 'content-type': 'text/plain;charset=UTF-8' },
        body: value,
      });
      await parseStoreResponse(response);
    },
  };
}

async function parseStoreResponse(response) {
  let body;
  try {
    body = await response.json();
  } catch {
    throw new Error('Admin storage returned an invalid response');
  }
  if (!response.ok || body?.error) throw new Error('Admin storage request failed');
  return body;
}

export async function loadClientTokens(store) {
  if (!store) return [];
  const raw = await store.get(TOKEN_RECORD_KEY);
  if (!raw) return [];
  try {
    const records = JSON.parse(raw);
    return Array.isArray(records) ? records.filter(isTokenRecord) : [];
  } catch {
    return [];
  }
}

export async function saveClientTokens(store, records) {
  await store.put(TOKEN_RECORD_KEY, JSON.stringify(records));
}

export async function loadUpstreamKeys(store) {
  return loadRecords(store, UPSTREAM_KEY_RECORD_KEY, isUpstreamKeyRecord);
}

export async function saveUpstreamKeys(store, records) {
  await store.put(UPSTREAM_KEY_RECORD_KEY, JSON.stringify(records));
}

export async function loadServicePolicy(store) {
  if (!store) return { ...DEFAULT_POLICY };
  const raw = await store.get(POLICY_RECORD_KEY);
  if (!raw) return { ...DEFAULT_POLICY };
  try {
    const input = JSON.parse(raw);
    return {
      strategy: input?.strategy === 'round_robin' ? 'round_robin' : 'random',
      allowedModels: Array.isArray(input?.allowedModels)
        ? [...new Set(input.allowedModels.filter((item) => typeof item === 'string').map((item) => item.trim()).filter(Boolean))]
        : [],
      nextIndex: Number.isInteger(input?.nextIndex) && input.nextIndex >= 0 ? input.nextIndex : 0,
    };
  } catch {
    return { ...DEFAULT_POLICY };
  }
}

export async function saveServicePolicy(store, policy) {
  await store.put(POLICY_RECORD_KEY, JSON.stringify({
    strategy: policy.strategy === 'round_robin' ? 'round_robin' : 'random',
    allowedModels: policy.allowedModels || [],
    nextIndex: policy.nextIndex || 0,
  }));
}

async function loadRecords(store, key, predicate) {
  if (!store) return [];
  const raw = await store.get(key);
  if (!raw) return [];
  try {
    const records = JSON.parse(raw);
    return Array.isArray(records) ? records.filter(predicate) : [];
  } catch {
    return [];
  }
}

function isTokenRecord(record) {
  return record
    && typeof record.id === 'string'
    && typeof record.name === 'string'
    && typeof record.hash === 'string'
    && typeof record.createdAt === 'string';
}

function isUpstreamKeyRecord(record) {
  return record
    && typeof record.id === 'string'
    && typeof record.name === 'string'
    && typeof record.secret === 'object'
    && typeof record.secret.iv === 'string'
    && typeof record.secret.ciphertext === 'string'
    && typeof record.enabled === 'boolean'
    && typeof record.createdAt === 'string';
}
