import { callGemini } from './gemini.js';
import { HttpError, readJsonLimited, selectApiKey } from './security.js';
import { assertModelAllowed } from './model_policy.js';

export async function handleAnthropic(request, { config, endpoint }) {
  if (request.method !== 'POST') {
    throw new HttpError('Method not allowed', 405, 'method_not_allowed');
  }
  const version = request.headers.get('anthropic-version');
  if (!version) throw new HttpError('anthropic-version header is required', 400, 'invalid_request_error');
  if (version !== '2023-06-01') {
    throw new HttpError(`Unsupported anthropic-version: ${version}`, 400, 'unsupported_version');
  }
  const req = await readJsonLimited(request, config.maxBodyBytes);
  const apiKey = selectApiKey(request, config, 'anthropic');
  if (endpoint === 'messages/count_tokens') {
    return countTokens(req, apiKey, config, request.signal);
  }
  if (endpoint !== 'messages') throw new HttpError('Not found', 404, 'not_found');
  return createMessage(req, apiKey, config, request.signal);
}

async function createMessage(req, apiKey, config, signal) {
  if (!Number.isInteger(req.max_tokens) || req.max_tokens < 1) {
    throw new HttpError('max_tokens must be a positive integer', 400, 'invalid_request_error');
  }
  const model = mapModel(req.model, config);
  assertModelAllowed(model, config);
  const body = toGeminiRequest(req);
  const task = req.stream ? 'streamGenerateContent?alt=sse' : 'generateContent';
  const response = await callGemini(`/v1beta/models/${encodeURIComponent(model)}:${task}`, {
    apiKey, body, config, signal,
  });
  if (!response.ok) return anthropicUpstreamError(response);
  if (req.stream) return anthropicStream(response, req.model || model);
  const data = await response.json();
  const candidate = data.candidates?.[0];
  const content = geminiPartsToClaude(candidate?.content?.parts ?? []);
  return jsonResponse({
    id: `msg_${randomId()}`,
    type: 'message',
    role: 'assistant',
    model: req.model || model,
    content,
    stop_reason: stopReason(candidate),
    stop_sequence: null,
    usage: {
      input_tokens: data.usageMetadata?.promptTokenCount ?? 0,
      output_tokens: data.usageMetadata?.candidatesTokenCount ?? 0,
    },
  });
}

async function countTokens(req, apiKey, config, signal) {
  const model = mapModel(req.model, config);
  assertModelAllowed(model, config);
  const body = toGeminiRequest({ ...req, max_tokens: req.max_tokens || 1 });
  const response = await callGemini(`/v1beta/models/${encodeURIComponent(model)}:countTokens`, {
    apiKey, body: { contents: body.contents, systemInstruction: body.systemInstruction, tools: body.tools }, config, signal,
  });
  if (!response.ok) return anthropicUpstreamError(response);
  const data = await response.json();
  return jsonResponse({ input_tokens: data.totalTokens ?? 0 });
}

function toGeminiRequest(req) {
  if (!Array.isArray(req.messages)) {
    throw new HttpError('messages must be an array', 400, 'invalid_request_error');
  }
  const toolNames = new Map();
  for (const message of req.messages) {
    if (!Array.isArray(message.content)) continue;
    for (const block of message.content) {
      if (block.type === 'tool_use') toolNames.set(block.id, block.name);
    }
  }
  const body = {
    contents: req.messages.map((message) => ({
      role: message.role === 'assistant' ? 'model' : 'user',
      parts: claudeContentToGemini(message.content, toolNames),
    })),
    generationConfig: {
      maxOutputTokens: req.max_tokens,
      temperature: req.temperature,
      topP: req.top_p,
      topK: req.top_k,
      stopSequences: req.stop_sequences,
    },
  };
  for (const key of Object.keys(body.generationConfig)) {
    if (body.generationConfig[key] == null) delete body.generationConfig[key];
  }
  if (req.system) {
    const blocks = typeof req.system === 'string' ? [{ type: 'text', text: req.system }] : req.system;
    body.systemInstruction = { parts: claudeContentToGemini(blocks) };
  }
  if (req.tools?.length) {
    body.tools = [{
      functionDeclarations: req.tools.map((tool) => ({
        name: tool.name, description: tool.description, parameters: tool.input_schema,
      })),
    }];
  }
  if (req.tool_choice) {
    const type = req.tool_choice.type;
    body.toolConfig = { functionCallingConfig: {
      mode: type === 'none' ? 'NONE' : type === 'auto' ? 'AUTO' : 'ANY',
      allowedFunctionNames: type === 'tool' ? [req.tool_choice.name] : undefined,
    } };
  }
  return body;
}

function claudeContentToGemini(content, toolNames = new Map()) {
  const blocks = typeof content === 'string' ? [{ type: 'text', text: content }] : content;
  if (!Array.isArray(blocks)) throw new HttpError('Invalid message content', 400, 'invalid_request_error');
  return blocks.map((block) => {
    if (block.type === 'text') return { text: block.text };
    if (block.type === 'image') {
      if (block.source?.type !== 'base64') throw new HttpError('Only base64 image sources are supported', 400, 'unsupported_content_type');
      return { inlineData: { mimeType: block.source.media_type, data: block.source.data } };
    }
    if (block.type === 'document') {
      if (block.source?.type === 'base64') {
        return { inlineData: { mimeType: block.source.media_type || 'application/pdf', data: block.source.data } };
      }
      if (block.source?.type === 'text') return { text: block.source.data };
      throw new HttpError('Only base64 or text document sources are supported', 400, 'unsupported_content_type');
    }
    if (block.type === 'thinking') return { text: block.thinking || '' };
    if (block.type === 'redacted_thinking') return { text: '' };
    if (block.type === 'tool_use') {
      return { functionCall: { id: block.id, name: block.name, args: block.input || {} } };
    }
    if (block.type === 'tool_result') {
      return { functionResponse: {
        id: block.tool_use_id,
        name: block.name || toolNames.get(block.tool_use_id) || 'tool',
        response: normalizeToolResult(block.content, block.is_error),
      } };
    }
    throw new HttpError(`Unsupported Claude content type: ${block.type}`, 400, 'unsupported_content_type');
  });
}

function normalizeToolResult(content, isError) {
  let result = content;
  if (Array.isArray(content)) result = content.map((block) => block.text ?? block).join('\n');
  if (typeof result !== 'object' || result == null) result = { result };
  return isError ? { error: result } : result;
}

function geminiPartsToClaude(parts) {
  return parts.map((part) => {
    if (part.functionCall) {
      return {
        type: 'tool_use', id: part.functionCall.id || `toolu_${randomId()}`,
        name: part.functionCall.name, input: part.functionCall.args || {},
      };
    }
    return { type: 'text', text: part.text ?? '' };
  });
}

function anthropicStream(response, requestedModel) {
  const messageId = `msg_${randomId()}`;
  const stream = response.body
    .pipeThrough(new TextDecoderStream())
    .pipeThrough(new TransformStream({
      buffer: '', started: false, blockIndex: 0, outputTokens: 0,
      transform(chunk, controller) {
        this.buffer += chunk;
        const records = this.buffer.split(/\r?\n\r?\n/);
        this.buffer = records.pop() || '';
        for (const record of records) {
          const line = record.split(/\r?\n/).find((item) => item.startsWith('data: '));
          if (!line) continue;
          let data;
          try { data = JSON.parse(line.slice(6)); } catch { continue; }
          if (!this.started) {
            this.started = true;
            emit(controller, 'message_start', { type: 'message_start', message: {
              id: messageId, type: 'message', role: 'assistant', model: requestedModel,
              content: [], stop_reason: null, stop_sequence: null,
              usage: { input_tokens: data.usageMetadata?.promptTokenCount ?? 0, output_tokens: 0 },
            } });
          }
          for (const part of data.candidates?.[0]?.content?.parts ?? []) {
            const index = this.blockIndex++;
            if (part.functionCall) {
              const block = geminiPartsToClaude([part])[0];
              emit(controller, 'content_block_start', { type: 'content_block_start', index, content_block: { ...block, input: {} } });
              emit(controller, 'content_block_delta', { type: 'content_block_delta', index, delta: { type: 'input_json_delta', partial_json: JSON.stringify(block.input) } });
            } else {
              emit(controller, 'content_block_start', { type: 'content_block_start', index, content_block: { type: 'text', text: '' } });
              emit(controller, 'content_block_delta', { type: 'content_block_delta', index, delta: { type: 'text_delta', text: part.text ?? '' } });
            }
            emit(controller, 'content_block_stop', { type: 'content_block_stop', index });
          }
          this.outputTokens = data.usageMetadata?.candidatesTokenCount ?? this.outputTokens;
          if (data.candidates?.[0]?.finishReason) {
            emit(controller, 'message_delta', { type: 'message_delta', delta: { stop_reason: stopReason(data.candidates[0]), stop_sequence: null }, usage: { output_tokens: this.outputTokens } });
            emit(controller, 'message_stop', { type: 'message_stop' });
          }
        }
      },
    }))
    .pipeThrough(new TextEncoderStream());
  return new Response(stream, { headers: { 'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-cache' } });
}

function emit(controller, event, data) {
  controller.enqueue(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
}

async function anthropicUpstreamError(response) {
  let message = `Gemini upstream returned ${response.status}`;
  try { message = (await response.json()).error?.message || message; } catch { /* ignore malformed upstream errors */ }
  return jsonResponse({ type: 'error', error: { type: 'api_error', message } }, response.status);
}

function mapModel(model, config) {
  if (typeof model === 'string' && /^(gemini-|gemma-|learnlm-)/.test(model)) return model;
  return config.defaultGeminiModel;
}

function stopReason(candidate) {
  if (candidate?.content?.parts?.some((part) => part.functionCall)) return 'tool_use';
  return candidate?.finishReason === 'MAX_TOKENS' ? 'max_tokens' : 'end_turn';
}

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status, headers: { 'content-type': 'application/json; charset=utf-8' },
  });
}

function randomId() {
  return globalThis.crypto?.randomUUID?.().replaceAll('-', '') ?? Math.random().toString(36).slice(2);
}
