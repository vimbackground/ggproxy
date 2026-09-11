import {
  getAdminStore, loadClientTokens, loadServicePolicy, loadUpstreamKeys,
  saveClientTokens, saveServicePolicy, saveUpstreamKeys,
} from './admin_store.js';
import { HttpError, constantTimeEqual, readJsonLimited } from './security.js';

const MAX_ADMIN_BODY_BYTES = 32 * 1024;

export async function handleAdminRequest(request, env, config, path) {
  if (!config.adminToken) throw new HttpError('Admin is not enabled', 404, 'not_found');
  if (path === '/admin' && request.method === 'GET') return htmlResponse(adminPage());

  requireAdminToken(request, config);
  const store = getAdminStore(env, config);
  if (path === '/admin/api/overview' && request.method === 'GET') {
    const [tokens, upstreamKeys, policy] = store
      ? await Promise.all([loadClientTokens(store), loadUpstreamKeys(store), loadServicePolicy(store)])
      : [[], [], { strategy: 'random', allowedModels: [] }];
    return json({
      name: 'ggproxy',
      storage: store ? { enabled: true, type: store.type } : { enabled: false },
      encryptionConfigured: Boolean(config.adminEncryptionKey),
      clientTokenCount: tokens.length,
      upstreamKeyCount: upstreamKeys.length,
      activeUpstreamKeyCount: upstreamKeys.filter((item) => item.enabled).length,
      staticProxyTokenConfigured: config.proxyTokens.length > 0,
      environmentKeyPoolConfigured: config.geminiApiKeys.length > 0,
      defaultGeminiModel: config.defaultGeminiModel,
      policy: publicPolicy(policy),
    });
  }
  if (!store) throw new HttpError('Configure an admin KV store before using management APIs', 503, 'admin_storage_required');

  if (path === '/admin/api/tokens' && request.method === 'GET') {
    return json({ tokens: (await loadClientTokens(store)).map(publicToken) });
  }
  if (path === '/admin/api/tokens' && request.method === 'POST') {
    const body = await readJsonLimited(request, MAX_ADMIN_BODY_BYTES);
    const name = requiredName(body?.name, 'Token name');
    const rawToken = `ggp_${randomToken()}`;
    const records = await loadClientTokens(store);
    const record = { id: randomToken(12), name, hash: await hashToken(rawToken), createdAt: new Date().toISOString() };
    records.push(record);
    await saveClientTokens(store, records);
    return json({ token: rawToken, record: publicToken(record) }, 201);
  }
  const tokenMatch = path.match(/^\/admin\/api\/tokens\/([A-Za-z0-9_-]{8,128})$/);
  if (tokenMatch && request.method === 'DELETE') {
    const records = await loadClientTokens(store);
    const updated = records.filter((record) => record.id !== tokenMatch[1]);
    if (updated.length === records.length) throw new HttpError('Client token not found', 404, 'not_found');
    await saveClientTokens(store, updated);
    return new Response(null, { status: 204 });
  }

  if (path === '/admin/api/upstream-keys' && request.method === 'GET') {
    return json({ keys: (await loadUpstreamKeys(store)).map(publicUpstreamKey) });
  }
  if (path === '/admin/api/upstream-keys' && request.method === 'POST') {
    requireEncryption(config);
    const body = await readJsonLimited(request, MAX_ADMIN_BODY_BYTES);
    const name = requiredName(body?.name, 'Key name');
    const apiKey = String(body?.apiKey || '').trim();
    if (apiKey.length < 12 || apiKey.length > 1024) throw new HttpError('Invalid Gemini API key', 400, 'invalid_upstream_key');
    const records = await loadUpstreamKeys(store);
    const record = {
      id: randomToken(12), name, enabled: body?.enabled !== false, createdAt: new Date().toISOString(),
      secret: await encryptSecret(apiKey, config.adminEncryptionKey),
    };
    records.push(record);
    await saveUpstreamKeys(store, records);
    return json({ key: publicUpstreamKey(record) }, 201);
  }
  const keyMatch = path.match(/^\/admin\/api\/upstream-keys\/([A-Za-z0-9_-]{8,128})$/);
  if (keyMatch && request.method === 'PATCH') {
    const body = await readJsonLimited(request, MAX_ADMIN_BODY_BYTES);
    const records = await loadUpstreamKeys(store);
    const index = records.findIndex((record) => record.id === keyMatch[1]);
    if (index < 0) throw new HttpError('Upstream key not found', 404, 'not_found');
    const current = records[index];
    if (body?.name != null) current.name = requiredName(body.name, 'Key name');
    if (typeof body?.enabled === 'boolean') current.enabled = body.enabled;
    records[index] = current;
    await saveUpstreamKeys(store, records);
    return json({ key: publicUpstreamKey(current) });
  }
  if (keyMatch && request.method === 'DELETE') {
    const records = await loadUpstreamKeys(store);
    const updated = records.filter((record) => record.id !== keyMatch[1]);
    if (updated.length === records.length) throw new HttpError('Upstream key not found', 404, 'not_found');
    await saveUpstreamKeys(store, updated);
    return new Response(null, { status: 204 });
  }

  if (path === '/admin/api/policy' && request.method === 'GET') return json({ policy: publicPolicy(await loadServicePolicy(store)) });
  if (path === '/admin/api/policy' && request.method === 'PUT') {
    const body = await readJsonLimited(request, MAX_ADMIN_BODY_BYTES);
    const strategy = body?.strategy === 'round_robin' ? 'round_robin' : body?.strategy === 'random' ? 'random' : '';
    if (!strategy) throw new HttpError('Strategy must be random or round_robin', 400, 'invalid_strategy');
    if (!Array.isArray(body?.allowedModels) || body.allowedModels.some((model) => typeof model !== 'string' || model.trim().length > 128)) {
      throw new HttpError('allowedModels must be an array of model names', 400, 'invalid_model_policy');
    }
    const policy = {
      strategy,
      allowedModels: [...new Set(body.allowedModels.map((model) => model.trim().replace(/^models\//, '')).filter(Boolean))],
      nextIndex: 0,
    };
    await saveServicePolicy(store, policy);
    return json({ policy: publicPolicy(policy) });
  }
  throw new HttpError('Route not found', 404, 'not_found');
}

export async function isManagedTokenValid(actual, env, config) {
  const store = getAdminStore(env, config);
  if (!store || !actual) return false;
  const actualHash = await hashToken(actual);
  const records = await loadClientTokens(store);
  return records.some((record) => constantTimeEqual(record.hash, actualHash));
}

export async function resolveManagedGatewayConfig(env, config) {
  const store = getAdminStore(env, config);
  if (!store) return config;
  const [records, policy] = await Promise.all([loadUpstreamKeys(store), loadServicePolicy(store)]);
  const active = records.filter((record) => record.enabled);
  if (!active.length) {
    if (config.geminiApiKeys.length) return { ...config, allowedModels: policy.allowedModels };
    throw new HttpError('No enabled server Gemini API key is configured', 503, 'no_upstream_key');
  }
  requireEncryption(config);
  let index;
  if (policy.strategy === 'round_robin') {
    index = policy.nextIndex % active.length;
    await saveServicePolicy(store, { ...policy, nextIndex: (index + 1) % active.length });
  } else {
    const random = new Uint32Array(1);
    crypto.getRandomValues(random);
    index = random[0] % active.length;
  }
  const apiKey = await decryptSecret(active[index].secret, config.adminEncryptionKey);
  return { ...config, geminiApiKeys: [apiKey], allowedModels: policy.allowedModels };
}

function requireAdminToken(request, config) {
  const actual = request.headers.get('x-admin-token') || '';
  if (!actual || !constantTimeEqual(actual, config.adminToken)) throw new HttpError('Invalid admin credentials', 401, 'invalid_admin_token');
}

function requireEncryption(config) {
  if (config.adminEncryptionKey.length < 32) {
    throw new HttpError('Set an ADMIN_ENCRYPTION_KEY with at least 32 characters before managing server keys', 503, 'admin_encryption_required');
  }
}

function requiredName(input, label) {
  const name = String(input || '').trim();
  if (!name || name.length > 64) throw new HttpError(`${label} must contain 1 to 64 characters`, 400, 'invalid_name');
  return name;
}

function publicToken(record) { return { id: record.id, name: record.name, createdAt: record.createdAt }; }
function publicUpstreamKey(record) { return { id: record.id, name: record.name, enabled: record.enabled, createdAt: record.createdAt }; }
function publicPolicy(policy) { return { strategy: policy.strategy, allowedModels: policy.allowedModels }; }

async function hashToken(token) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(token));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

async function encryptSecret(value, passphrase) {
  const key = await encryptionKey(passphrase);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ciphertext = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, new TextEncoder().encode(value));
  return { iv: base64(iv), ciphertext: base64(new Uint8Array(ciphertext)) };
}

async function decryptSecret(secret, passphrase) {
  try {
    const key = await encryptionKey(passphrase);
    const bytes = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: fromBase64(secret.iv) }, key, fromBase64(secret.ciphertext));
    return new TextDecoder().decode(bytes);
  } catch {
    throw new HttpError('Unable to decrypt a managed server key', 503, 'upstream_key_unavailable');
  }
}

async function encryptionKey(passphrase) {
  const material = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(passphrase));
  return crypto.subtle.importKey('raw', material, 'AES-GCM', false, ['encrypt', 'decrypt']);
}

function base64(bytes) { return btoa(String.fromCharCode(...bytes)); }
function fromBase64(value) { return Uint8Array.from(atob(value), (char) => char.charCodeAt(0)); }
function randomToken(bytes = 24) { const data = crypto.getRandomValues(new Uint8Array(bytes)); return [...data].map((byte) => byte.toString(16).padStart(2, '0')).join(''); }
function json(body, status = 200) { return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json; charset=utf-8' } }); }
function htmlResponse(body) { return new Response(body, { headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store', 'content-security-policy': "default-src 'self'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; base-uri 'none'; frame-ancestors 'none'" } }); }

function adminPage() {
  return `<!doctype html>
<html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>ggproxy 管理</title>
<style>
body{max-width:860px;margin:32px auto;padding:0 18px;font:15px/1.5 system-ui,sans-serif;color:#172033;background:#f7f8fa}main{background:#fff;border:1px solid #e5e7eb;border-radius:12px;padding:28px}h1{margin-top:0}h2{margin-top:28px}input,select,textarea,button{font:inherit;padding:9px;border:1px solid #cbd5e1;border-radius:7px}textarea{width:100%;min-height:70px;box-sizing:border-box}button{background:#0f766e;color:#fff;cursor:pointer}.row{display:flex;gap:8px;align-items:center;flex-wrap:wrap}.hidden{display:none}.notice{background:#ecfeff;padding:10px;border-radius:7px;word-break:break-all}.warn{background:#fff7ed;padding:10px;border-radius:7px}li{margin:8px 0}small{color:#64748b}
</style>
<main><h1>ggproxy 管理</h1>
<section id="login"><p>输入部署时设置的 <code>ADMIN_TOKEN</code>。</p><div class="row"><input id="adminToken" type="password" placeholder="ADMIN_TOKEN"><button id="loginButton">进入</button></div><p id="loginError"></p></section>
<section id="panel" class="hidden"><div class="row"><strong>运行状态</strong><button id="refresh">刷新</button><button id="logout">退出</button></div><p id="overview"></p><p id="setup" class="warn hidden"></p><hr>
<h2>服务端 Gemini Key 池</h2><p><small>Key 会用 <code>ADMIN_ENCRYPTION_KEY</code> 加密后存储；明文不会再次显示。</small></p><div class="row"><input id="keyName" maxlength="64" placeholder="例如：主账号"><input id="upstreamKey" type="password" placeholder="Gemini API Key"><button id="addKey">添加 Key</button></div><ul id="upstreamKeys"></ul>
<h2>中转策略与模型</h2><div class="row"><label>策略 <select id="strategy"><option value="random">随机</option><option value="round_robin">轮询</option></select></label><button id="savePolicy">保存策略</button></div><p><small>每行一个允许中转的 Gemini 模型；留空表示不限制模型。</small></p><textarea id="allowedModels" placeholder="gemini-3.5-flash-lite"></textarea>
<h2>客户端访问令牌</h2><p><small>用户选择 Gemini 原生客户端，使用中转网址的 Gemini 原生路径（例如 <code>/v1beta</code>）和该令牌。新令牌只显示一次。</small></p><div class="row"><input id="tokenName" maxlength="64" placeholder="例如：Kelivo - 张三"><button id="createToken">创建令牌</button></div><p id="created" class="notice hidden"></p><ul id="tokens"></ul>
</section></main>
<script>
let adminToken = '';
const el = (id) => document.getElementById(id);
async function api(path, options = {}) {
  const response = await fetch(path, { ...options, headers: { ...options.headers, 'x-admin-token': adminToken } });
  if (!response.ok) {
    const body = await response.json().catch(() => ({}));
    throw Error(body.error?.message || body.error?.error?.message || '请求失败');
  }
  return response.status === 204 ? null : response.json();
}
function listItem(text, buttons) {
  const item = document.createElement('li');
  const label = document.createElement('strong');
  label.textContent = text;
  item.append(label, document.createTextNode(' '));
  buttons.forEach((button) => item.append(button));
  return item;
}
function button(text, action) {
  const result = document.createElement('button');
  result.textContent = text;
  result.onclick = action;
  return result;
}
async function load() {
  const overview = await api('/admin/api/overview');
  el('overview').textContent = '存储：' + (overview.storage.enabled ? overview.storage.type : '未配置') + '；客户端令牌：' + overview.clientTokenCount + '；启用 Key：' + overview.activeUpstreamKeyCount + '；默认模型：' + overview.defaultGeminiModel;
  el('setup').textContent = !overview.storage.enabled ? '请先配置管理存储，才能使用后台管理功能。' : (!overview.encryptionConfigured ? '需要先在平台设置至少 32 位的 ADMIN_ENCRYPTION_KEY，才能保存服务端 Gemini Key。' : '');
  el('setup').classList.toggle('hidden', overview.storage.enabled && overview.encryptionConfigured);
  if (!overview.storage.enabled) return;
  const results = await Promise.all([api('/admin/api/upstream-keys'), api('/admin/api/policy'), api('/admin/api/tokens')]);
  const keys = results[0].keys, policy = results[1].policy, tokens = results[2].tokens;
  const keyList = el('upstreamKeys'); keyList.replaceChildren();
  keys.forEach((key) => keyList.append(listItem(key.name + '（' + (key.enabled ? '已启用' : '已停用') + '）', [button(key.enabled ? '停用' : '启用', async () => { await api('/admin/api/upstream-keys/' + key.id, { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ enabled: !key.enabled }) }); load(); }), button('删除', async () => { if (confirm('删除此服务端 Key？')) { await api('/admin/api/upstream-keys/' + key.id, { method: 'DELETE' }); load(); } })])));
  if (!keys.length) keyList.textContent = '尚无后台 Key。';
  el('strategy').value = policy.strategy;
  el('allowedModels').value = policy.allowedModels.join(String.fromCharCode(10));
  const tokenList = el('tokens'); tokenList.replaceChildren();
  tokens.forEach((token) => tokenList.append(listItem(token.name + '（' + token.createdAt + '）', [button('撤销', async () => { if (confirm('撤销此客户端令牌？')) { await api('/admin/api/tokens/' + token.id, { method: 'DELETE' }); load(); } })])));
  if (!tokens.length) tokenList.textContent = '尚无客户端令牌。';
}
el('loginButton').onclick = async () => { adminToken = el('adminToken').value; try { await load(); el('login').classList.add('hidden'); el('panel').classList.remove('hidden'); } catch (error) { el('loginError').textContent = error.message; } };
el('refresh').onclick = load;
el('logout').onclick = () => location.reload();
el('addKey').onclick = async () => { try { await api('/admin/api/upstream-keys', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: el('keyName').value, apiKey: el('upstreamKey').value }) }); el('keyName').value = ''; el('upstreamKey').value = ''; load(); } catch (error) { alert(error.message); } };
el('savePolicy').onclick = async () => { try { await api('/admin/api/policy', { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ strategy: el('strategy').value, allowedModels: el('allowedModels').value.split(String.fromCharCode(10)) }) }); load(); } catch (error) { alert(error.message); } };
el('createToken').onclick = async () => { try { const result = await api('/admin/api/tokens', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: el('tokenName').value }) }); el('created').textContent = '请立即复制并安全发送：' + result.token; el('created').classList.remove('hidden'); el('tokenName').value = ''; load(); } catch (error) { alert(error.message); } };
</script></html>`;
}
