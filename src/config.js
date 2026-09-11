const DEFAULTS = Object.freeze({
  maxBodyBytes: 10 * 1024 * 1024,
  upstreamTimeoutMs: 120_000,
  corsOrigins: [],
  verifyEnabled: false,
});

function runtimeEnv() {
  return globalThis.process?.env ?? {};
}

function value(env, name) {
  return env?.[name] ?? env?.get?.(name) ?? runtimeEnv()[name];
}

function positiveInt(input, fallback) {
  const parsed = Number.parseInt(input, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function bool(input, fallback = false) {
  if (input == null || input === '') return fallback;
  return String(input).toLowerCase() === 'true' || input === '1';
}

function list(input) {
  return String(input ?? '')
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);
}

export function getConfig(env = {}) {
  return {
    geminiApiKeys: list(value(env, 'GEMINI_API_KEYS')),
    defaultGeminiModel: value(env, 'DEFAULT_GEMINI_MODEL') || 'gemini-3.5-flash-lite',
    // PROXY_TOKEN remains supported for existing deployments. PROXY_TOKENS is
    // useful when a small number of static client credentials is sufficient.
    proxyTokens: [...new Set([
      ...list(value(env, 'PROXY_TOKEN')),
      ...list(value(env, 'PROXY_TOKENS')),
    ])],
    adminToken: value(env, 'ADMIN_TOKEN') || '',
    adminEncryptionKey: value(env, 'ADMIN_ENCRYPTION_KEY') || '',
    adminStoreUrl: value(env, 'ADMIN_KV_REST_URL')
      || value(env, 'UPSTASH_REDIS_REST_URL')
      || value(env, 'KV_REST_API_URL')
      || '',
    adminStoreToken: value(env, 'ADMIN_KV_REST_TOKEN')
      || value(env, 'UPSTASH_REDIS_REST_TOKEN')
      || value(env, 'KV_REST_API_TOKEN')
      || '',
    maxBodyBytes: positiveInt(value(env, 'MAX_BODY_BYTES'), DEFAULTS.maxBodyBytes),
    upstreamTimeoutMs: positiveInt(value(env, 'UPSTREAM_TIMEOUT_MS'), DEFAULTS.upstreamTimeoutMs),
    corsOrigins: list(value(env, 'CORS_ORIGINS')),
    verifyEnabled: bool(value(env, 'VERIFY_ENABLED'), DEFAULTS.verifyEnabled),
  };
}
