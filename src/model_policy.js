import { HttpError } from './security.js';

export function normalizeModelName(model) {
  return String(model || '').trim().replace(/^models\//, '').replace(/:(?:generateContent|streamGenerateContent|countTokens)$/, '');
}

export function assertModelAllowed(model, config) {
  const allowed = config.allowedModels || [];
  if (!allowed.length) return;
  const normalized = normalizeModelName(model);
  if (!allowed.includes(normalized)) {
    throw new HttpError(`Model is not enabled: ${normalized}`, 403, 'model_not_enabled');
  }
}

export function filterAllowedModels(models, config) {
  const allowed = config.allowedModels || [];
  if (!allowed.length) return models;
  return models.filter((model) => allowed.includes(normalizeModelName(model?.name || model?.id || model)));
}
