const TOKEN_RECORD_KEY = 'ggproxy:client-tokens:v1';

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

function isTokenRecord(record) {
  return record
    && typeof record.id === 'string'
    && typeof record.name === 'string'
    && typeof record.hash === 'string'
    && typeof record.createdAt === 'string';
}
