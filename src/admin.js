import { getAdminStore, loadClientTokens, saveClientTokens } from './admin_store.js';
import { HttpError, constantTimeEqual, readJsonLimited } from './security.js';

const MAX_ADMIN_BODY_BYTES = 16 * 1024;

export async function handleAdminRequest(request, env, config, path) {
  if (!config.adminToken) throw new HttpError('Admin is not enabled', 404, 'not_found');
  if (path === '/admin' && request.method === 'GET') return htmlResponse(adminPage());

  requireAdminToken(request, config);
  const store = getAdminStore(env, config);
  if (path === '/admin/api/overview' && request.method === 'GET') {
    const records = store ? await loadClientTokens(store) : [];
    return json({
      name: 'ggproxy',
      storage: store ? { enabled: true, type: store.type } : { enabled: false },
      clientTokenCount: records.length,
      staticProxyTokenConfigured: config.proxyTokens.length > 0,
      serverKeyPoolConfigured: config.geminiApiKeys.length > 0,
      defaultGeminiModel: config.defaultGeminiModel,
    });
  }
  if (!store) throw new HttpError('Configure an admin KV store before managing client tokens', 503, 'admin_storage_required');

  if (path === '/admin/api/tokens' && request.method === 'GET') {
    const records = await loadClientTokens(store);
    return json({ tokens: records.map(publicToken) });
  }
  if (path === '/admin/api/tokens' && request.method === 'POST') {
    const body = await readJsonLimited(request, MAX_ADMIN_BODY_BYTES);
    const name = String(body?.name || '').trim();
    if (!name || name.length > 64) throw new HttpError('Token name must contain 1 to 64 characters', 400, 'invalid_token_name');
    const rawToken = `ggp_${randomToken()}`;
    const records = await loadClientTokens(store);
    const record = {
      id: randomToken(12), name, hash: await hashToken(rawToken), createdAt: new Date().toISOString(),
    };
    records.push(record);
    await saveClientTokens(store, records);
    return json({ token: rawToken, record: publicToken(record) }, 201);
  }
  const match = path.match(/^\/admin\/api\/tokens\/([A-Za-z0-9_-]{8,128})$/);
  if (match && request.method === 'DELETE') {
    const records = await loadClientTokens(store);
    const updated = records.filter((record) => record.id !== match[1]);
    if (updated.length === records.length) throw new HttpError('Client token not found', 404, 'not_found');
    await saveClientTokens(store, updated);
    return new Response(null, { status: 204 });
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

function requireAdminToken(request, config) {
  const actual = request.headers.get('x-admin-token') || '';
  if (!actual || !constantTimeEqual(actual, config.adminToken)) {
    throw new HttpError('Invalid admin credentials', 401, 'invalid_admin_token');
  }
}

function publicToken(record) {
  return { id: record.id, name: record.name, createdAt: record.createdAt };
}

async function hashToken(token) {
  const input = new TextEncoder().encode(token);
  const digest = await crypto.subtle.digest('SHA-256', input);
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

function randomToken(bytes = 24) {
  const data = new Uint8Array(bytes);
  crypto.getRandomValues(data);
  return [...data].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

function json(body, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json; charset=utf-8' } });
}

function htmlResponse(body) {
  return new Response(body, { headers: {
    'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store', 'content-security-policy': "default-src 'self'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; base-uri 'none'; frame-ancestors 'none'",
  } });
}

function adminPage() {
  return `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>ggproxy 管理</title><style>body{max-width:760px;margin:40px auto;padding:0 18px;font:15px/1.5 system-ui,sans-serif;color:#172033;background:#f7f8fa}main{background:#fff;border:1px solid #e5e7eb;border-radius:12px;padding:28px}h1{margin-top:0}input,button{font:inherit;padding:9px;border:1px solid #cbd5e1;border-radius:7px}button{background:#0f766e;color:#fff;cursor:pointer}.row{display:flex;gap:8px;align-items:center;flex-wrap:wrap}.hidden{display:none}.notice{background:#ecfeff;padding:10px;border-radius:7px;word-break:break-all}li{margin:8px 0}small{color:#64748b}</style><main><h1>ggproxy 管理</h1><section id="login"><p>输入部署时设置的 <code>ADMIN_TOKEN</code>。</p><div class="row"><input id="adminToken" type="password" placeholder="ADMIN_TOKEN" autocomplete="current-password"><button id="loginButton">进入</button></div><p id="loginError"></p></section><section id="panel" class="hidden"><div class="row"><strong>运行状态</strong><button id="refresh">刷新</button><button id="logout">退出</button></div><p id="overview"></p><hr><h2>客户端访问令牌</h2><p><small>新令牌只显示一次。请发给用户时同时提供中转网址；撤销后会在存储同步后失效。</small></p><div class="row"><input id="tokenName" maxlength="64" placeholder="例如：Kelivo - 张三"><button id="create">创建令牌</button></div><p id="created" class="notice hidden"></p><ul id="tokens"></ul></section></main><script>let adminToken='';const $=id=>document.getElementById(id);async function api(path,options={}){const headers={...options.headers,'x-admin-token':adminToken};const r=await fetch(path,{...options,headers});if(!r.ok){const b=await r.json().catch(()=>({}));throw Error(b.error?.message||b.error?.error?.message||'请求失败');}return r.status===204?null:r.json()}function esc(s){const e=document.createElement('span');e.textContent=s;return e.innerHTML}async function load(){const o=await api('/admin/api/overview');$('overview').textContent='存储：'+(o.storage.enabled?o.storage.type:'未配置')+'；客户端令牌：'+o.clientTokenCount+'；服务端 Key 池：'+(o.serverKeyPoolConfigured?'已配置':'未配置')+'；默认模型：'+o.defaultGeminiModel;if(!o.storage.enabled){$('tokens').innerHTML='<li>请先按部署文档配置管理存储，之后才能创建或撤销令牌。</li>';$('create').disabled=true;return}$('create').disabled=false;const t=await api('/admin/api/tokens');$('tokens').innerHTML=t.tokens.map(x=>'<li><strong>'+esc(x.name)+'</strong> <small>'+esc(x.createdAt)+'</small> <button data-id="'+x.id+'">撤销</button></li>').join('')||'<li>尚无客户端令牌。</li>';document.querySelectorAll('[data-id]').forEach(b=>b.onclick=async()=>{if(confirm('确认撤销此令牌？')){await api('/admin/api/tokens/'+b.dataset.id,{method:'DELETE'});load()}})}$('loginButton').onclick=async()=>{adminToken=$('adminToken').value;try{await load();$('login').classList.add('hidden');$('panel').classList.remove('hidden')}catch(e){$('loginError').textContent=e.message}};$('refresh').onclick=load;$('logout').onclick=()=>location.reload();$('create').onclick=async()=>{try{const r=await api('/admin/api/tokens',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({name:$('tokenName').value})});$('created').textContent='请立即复制并安全发送：'+r.token;$('created').classList.remove('hidden');$('tokenName').value='';load()}catch(e){alert(e.message)}};</script></html>`;
}
