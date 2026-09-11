//Author: PublicAffairs
//Project: https://github.com/PublicAffairs/openai-gemini
//MIT License : https://github.com/PublicAffairs/openai-gemini/blob/main/LICENSE


import {
  HttpError, copyRequestHeaders, copyResponseHeaders, fetchWithTimeout, readJsonLimited, selectApiKey,
} from "./security.js";
import { assertModelAllowed, filterAllowedModels } from './model_policy.js';

export default {
  async fetch (request, { config, endpoint, path }) {
    const errHandler = (err) => {
      throw err;
    };
    try {
      const apiKey = selectApiKey(request, config, 'openai');
      const assert = (success) => {
        if (!success) {
          throw new HttpError("The specified HTTP method is not allowed for the requested resource", 405, 'method_not_allowed');
        }
      };
      switch (endpoint) {
        case "chat/completions":
          assert(request.method === "POST");
          return handleCompletions(await readJsonLimited(request, config.maxBodyBytes), apiKey, config, request.signal)
            .catch(errHandler);
        case "completions":
          assert(request.method === "POST");
          return handleLegacyCompletions(await readJsonLimited(request, config.maxBodyBytes), apiKey, config, request.signal)
            .catch(errHandler);
        case "responses":
          assert(request.method === "POST");
          return handleResponses(await readJsonLimited(request, config.maxBodyBytes), apiKey, config, request.signal)
            .catch(errHandler);
        case "embeddings":
          assert(request.method === "POST");
          return handleEmbeddings(await readJsonLimited(request, config.maxBodyBytes), apiKey, config, request.signal)
            .catch(errHandler);
        case "models":
          assert(request.method === "GET");
          return handleModels(apiKey, config, request.signal)
            .catch(errHandler);
        case "passthrough":
          if (config.allowedModels?.length) throw new HttpError('This endpoint is disabled while a model policy is active', 403, 'model_policy_required');
          return proxyOfficialOpenAI(request, apiKey, config, path)
            .catch(errHandler);
        default:
          throw new HttpError("404 Not Found", 404, 'not_found');
      }
    } catch (err) {
      return errHandler(err);
    }
  }
};

const fixCors = ({ headers, status, statusText }) => {
  headers = new Headers(headers);
  return { headers, status, statusText };
};

const transformedHeaders = (response, contentType = "application/json; charset=utf-8") => {
  const headers = copyResponseHeaders(response.headers);
  headers.delete("content-length");
  headers.delete("content-encoding");
  headers.set("content-type", contentType);
  return headers;
};

const BASE_URL = "https://generativelanguage.googleapis.com";
const API_VERSION = "v1beta";

// https://github.com/google-gemini/generative-ai-js/blob/cf223ff4a1ee5a2d944c53cddb8976136382bee6/src/requests/request.ts#L71
const API_CLIENT = "genai-js/0.21.0"; // npm view @google/generative-ai version
const makeHeaders = (apiKey, more) => ({
  "x-goog-api-client": API_CLIENT,
  ...(apiKey && { "x-goog-api-key": apiKey }),
  ...more
});

async function handleModels (apiKey, config, signal) {
  const response = await fetchWithTimeout(`${BASE_URL}/${API_VERSION}/models`, {
    headers: makeHeaders(apiKey),
    signal,
  }, config.upstreamTimeoutMs);
  if (!response.ok) return openAIUpstreamError(response);
  let { body } = response;
  if (response.ok) {
    const { models } = JSON.parse(await response.text());
    body = JSON.stringify({
      object: "list",
      data: filterAllowedModels(models, config).map(({ name }) => ({
        id: name.replace("models/", ""),
        object: "model",
        created: 0,
        owned_by: "",
      })),
    }, null, "  ");
  }
  return new Response(body, response.ok
    ? { status: response.status, headers: transformedHeaders(response) }
    : fixCors(response));
}

const DEFAULT_EMBEDDINGS_MODEL = "text-embedding-004";
async function handleEmbeddings (req, apiKey, config, signal) {
  if (typeof req.model !== "string") {
    throw new HttpError("model is not specified", 400);
  }
  let model;
  if (req.model.startsWith("models/")) {
    model = req.model;
  } else {
    if (!req.model.startsWith("gemini-")) {
      req.model = DEFAULT_EMBEDDINGS_MODEL;
    }
    model = "models/" + req.model;
  }
  if (!Array.isArray(req.input)) {
    req.input = [ req.input ];
  }
  assertModelAllowed(req.model.replace(/^models\//, ''), config);
  const response = await fetchWithTimeout(`${BASE_URL}/${API_VERSION}/${model}:batchEmbedContents`, {
    method: "POST",
    headers: makeHeaders(apiKey, { "Content-Type": "application/json" }),
    body: JSON.stringify({
      "requests": req.input.map(text => ({
        model,
        content: { parts: { text } },
        outputDimensionality: req.dimensions,
      }))
    }),
    signal,
  }, config.upstreamTimeoutMs);
  if (!response.ok) return openAIUpstreamError(response);
  let { body } = response;
  if (response.ok) {
    const { embeddings } = JSON.parse(await response.text());
    body = JSON.stringify({
      object: "list",
      data: embeddings.map(({ values }, index) => ({
        object: "embedding",
        index,
        embedding: values,
      })),
      model: req.model,
    }, null, "  ");
  }
  return new Response(body, response.ok
    ? { status: response.status, headers: transformedHeaders(response) }
    : fixCors(response));
}

async function handleCompletions (req, apiKey, config, signal) {
  let model = config.defaultGeminiModel;
  switch (true) {
    case typeof req.model !== "string":
      break;
    case req.model.startsWith("models/"):
      model = req.model.substring(7);
      break;
    case req.model.startsWith("gemini-"):
    case req.model.startsWith("gemma-"):
    case req.model.startsWith("learnlm-"):
      model = req.model;
  }
  assertModelAllowed(model, config);
  let body = await transformRequest(req);
  const extra = req.extra_body?.google
  if (extra) {
    if (extra.safety_settings) {
      body.safetySettings = extra.safety_settings;
    }
    if (extra.cached_content) {
      body.cachedContent = extra.cached_content;
    }
    if (extra.thinking_config) {
      body.generationConfig.thinkingConfig = extra.thinking_config;
    }
  }
  switch (true) {
    case model.endsWith(":search"):
      model = model.substring(0, model.length - 7);
      // eslint-disable-next-line no-fallthrough
    case model.endsWith("-search-preview"):
    case req.tools?.some(tool => tool.function?.name === 'googleSearch'):
      body.tools = body.tools || [];
      body.tools.push({googleSearch: {}});
  }
  const TASK = req.stream ? "streamGenerateContent" : "generateContent";
  let url = `${BASE_URL}/${API_VERSION}/models/${model}:${TASK}`;
  if (req.stream) { url += "?alt=sse"; }
  const response = await fetchWithTimeout(url, {
    method: "POST",
    headers: makeHeaders(apiKey, { "Content-Type": "application/json" }),
    body: JSON.stringify(body),
    signal,
  }, config.upstreamTimeoutMs);

  if (!response.ok) return openAIUpstreamError(response);

  body = response.body;
  if (response.ok) {
    let id = "chatcmpl-" + generateId(); //"chatcmpl-8pMMaqXMK68B3nyDBrapTDrhkHBQK";
    const shared = {};
    if (req.stream) {
      body = response.body
        .pipeThrough(new TextDecoderStream())
        .pipeThrough(new TransformStream({
          transform: parseStream,
          flush: parseStreamFlush,
          buffer: "",
          shared,
        }))
        .pipeThrough(new TransformStream({
          transform: toOpenAiStream,
          flush: toOpenAiStreamFlush,
          streamIncludeUsage: req.stream_options?.include_usage,
          model, id, last: [],
          shared,
        }))
        .pipeThrough(new TextEncoderStream());
    } else {
      body = await response.text();
      try {
        body = JSON.parse(body);
        if (!body.candidates) {
          throw new Error("Invalid completion object");
        }
      } catch (err) {
        return new Response(body, fixCors(response)); // output as is
      }
      body = processCompletionsResponse(body, model, id);
    }
  }
  return new Response(body, response.ok
    ? { status: response.status, headers: transformedHeaders(response, req.stream ? "text/event-stream; charset=utf-8" : undefined) }
    : fixCors(response));
}

async function handleLegacyCompletions(req, apiKey, config, signal) {
  if (Array.isArray(req.prompt) && req.prompt.length !== 1) {
    throw new HttpError("Only one prompt is supported per request", 400, "unsupported_prompt_batch");
  }
  const prompt = Array.isArray(req.prompt) ? req.prompt[0] : req.prompt;
  if (typeof prompt !== "string") {
    throw new HttpError("prompt must be a string", 400, "invalid_prompt");
  }
  const response = await handleCompletions({
    ...req,
    messages: [{ role: "user", content: prompt }],
  }, apiKey, config, signal);
  if (!response.ok || req.stream) return response;
  const chat = await response.json();
  return new Response(JSON.stringify({
    id: chat.id,
    object: "text_completion",
    created: chat.created,
    model: chat.model,
    choices: chat.choices.map((choice) => ({
      text: choice.message?.content ?? "",
      index: choice.index,
      logprobs: choice.logprobs,
      finish_reason: choice.finish_reason,
    })),
    usage: chat.usage,
  }), { status: response.status, headers: transformedHeaders(response) });
}

async function handleResponses(req, apiKey, config, signal) {
  const chatRequest = responsesToChatRequest(req);
  const response = await handleCompletions(chatRequest, apiKey, config, signal);
  if (!response.ok) return response;
  if (req.stream) return responsesStream(response, req.model || config.defaultGeminiModel);
  const chat = await response.json();
  const output = [];
  for (const choice of chat.choices ?? []) {
    if (choice.message?.content != null) {
      output.push({
        id: "msg_" + generateId(), type: "message", status: "completed", role: "assistant",
        content: [{ type: "output_text", text: choice.message.content, annotations: [] }],
      });
    }
    for (const toolCall of choice.message?.tool_calls ?? []) {
      output.push({
        type: "function_call", id: toolCall.id, call_id: toolCall.id,
        name: toolCall.function.name, arguments: toolCall.function.arguments, status: "completed",
      });
    }
  }
  const body = {
    id: chat.id.replace(/^chatcmpl-/, "resp_"), object: "response",
    created_at: chat.created, status: "completed", model: chat.model,
    output, parallel_tool_calls: true,
    usage: chat.usage && {
      input_tokens: chat.usage.prompt_tokens,
      output_tokens: chat.usage.completion_tokens,
      total_tokens: chat.usage.total_tokens,
    },
    error: null,
  };
  return new Response(JSON.stringify(body), {
    status: response.status,
    headers: transformedHeaders(response),
  });
}

function responsesToChatRequest(req) {
  if (req.previous_response_id) {
    throw new HttpError("previous_response_id is not supported by this stateless gateway", 400, "unsupported_parameter");
  }
  const messages = [];
  if (req.instructions) messages.push({ role: "system", content: req.instructions });
  if (typeof req.input === "string") {
    messages.push({ role: "user", content: req.input });
  } else if (Array.isArray(req.input)) {
    for (const item of req.input) {
      if (item.type === "function_call_output") {
        messages.push({ role: "tool", tool_call_id: item.call_id, content: item.output });
        continue;
      }
      if (item.type === "function_call") {
        messages.push({
          role: "assistant", content: null,
          tool_calls: [{
            id: item.call_id || item.id, type: "function",
            function: { name: item.name, arguments: item.arguments || "{}" },
          }],
        });
        continue;
      }
      const role = item.role === "developer" ? "system" : (item.role || "user");
      messages.push({ role, content: responseContentToChat(item.content) });
    }
  } else {
    throw new HttpError("input must be a string or an array", 400, "invalid_input");
  }
  const tools = req.tools?.map((tool) => {
    if (tool.type === "web_search" || tool.type === "web_search_preview") {
      return { type: "function", function: { name: "googleSearch", parameters: { type: "object", properties: {} } } };
    }
    if (tool.type !== "function") {
      throw new HttpError(`Unsupported Responses tool type: ${tool.type}`, 400, "unsupported_tool_type");
    }
    return {
      type: "function",
      function: { name: tool.name, description: tool.description, parameters: tool.parameters },
    };
  });
  let toolChoice = req.tool_choice;
  if (toolChoice?.type === "function" && toolChoice.name) {
    toolChoice = { type: "function", function: { name: toolChoice.name } };
  }
  return {
    model: req.model,
    messages,
    tools,
    tool_choice: toolChoice,
    stream: Boolean(req.stream),
    stream_options: req.stream ? { include_usage: true } : undefined,
    temperature: req.temperature,
    top_p: req.top_p,
    max_completion_tokens: req.max_output_tokens,
    response_format: responsesFormatToChat(req.text?.format),
    reasoning_effort: req.reasoning?.effort,
  };
}

function responsesFormatToChat(format) {
  if (!format) return undefined;
  if (format.type !== "json_schema") return format;
  return {
    type: "json_schema",
    json_schema: {
      name: format.name, description: format.description, schema: format.schema, strict: format.strict,
    },
  };
}

function responseContentToChat(content) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content.map((part) => {
    if (part.type === "input_text" || part.type === "output_text") return { type: "text", text: part.text };
    if (part.type === "input_image") return { type: "image_url", image_url: { url: part.image_url } };
    throw new HttpError(`Unsupported Responses content type: ${part.type}`, 400, "unsupported_content_type");
  });
}

function responsesStream(response, model) {
  const id = "resp_" + generateId();
  const messageId = "msg_" + generateId();
  const reader = response.body
    .pipeThrough(new TextDecoderStream())
    .pipeThrough(new TransformStream({
      buffer: "", sequence: 0, started: false, completed: false, text: "", toolItems: [],
      transform(chunk, controller) {
        this.buffer += chunk;
        const records = this.buffer.split(/\r?\n\r?\n/);
        this.buffer = records.pop() || "";
        for (const record of records) {
          const dataLine = record.split(/\r?\n/).find((line) => line.startsWith("data: "));
          if (!dataLine || dataLine === "data: [DONE]") continue;
          let event;
          try { event = JSON.parse(dataLine.slice(6)); } catch { continue; }
          if (!this.started) {
            this.started = true;
            enqueueResponseEvent(controller, "response.created", this.sequence++, {
              response: { id, object: "response", status: "in_progress", model, output: [] },
            });
            enqueueResponseEvent(controller, "response.output_item.added", this.sequence++, {
              output_index: 0,
              item: { id: messageId, type: "message", status: "in_progress", role: "assistant", content: [] },
            });
            enqueueResponseEvent(controller, "response.content_part.added", this.sequence++, {
              item_id: messageId, output_index: 0, content_index: 0,
              part: { type: "output_text", text: "", annotations: [] },
            });
          }
          const delta = event.choices?.[0]?.delta?.content;
          if (delta) {
            this.text += delta;
            enqueueResponseEvent(controller, "response.output_text.delta", this.sequence++, {
              item_id: messageId, output_index: 0, content_index: 0, delta,
            });
          }
          for (const toolCall of event.choices?.[0]?.delta?.tool_calls ?? []) {
            const item = {
              type: "function_call", id: toolCall.id, call_id: toolCall.id,
              name: toolCall.function.name, arguments: toolCall.function.arguments, status: "completed",
            };
            const outputIndex = this.toolItems.length + 1;
            this.toolItems.push(item);
            enqueueResponseEvent(controller, "response.output_item.added", this.sequence++, {
              output_index: outputIndex, item: { ...item, arguments: "", status: "in_progress" },
            });
            enqueueResponseEvent(controller, "response.function_call_arguments.delta", this.sequence++, {
              item_id: item.id, output_index: outputIndex, delta: item.arguments,
            });
            enqueueResponseEvent(controller, "response.function_call_arguments.done", this.sequence++, {
              item_id: item.id, output_index: outputIndex, arguments: item.arguments,
            });
            enqueueResponseEvent(controller, "response.output_item.done", this.sequence++, {
              output_index: outputIndex, item,
            });
          }
          if (event.choices?.[0]?.finish_reason && !this.completed) {
            this.completed = true;
            const message = {
              id: messageId, type: "message", status: "completed", role: "assistant",
              content: [{ type: "output_text", text: this.text, annotations: [] }],
            };
            enqueueResponseEvent(controller, "response.output_text.done", this.sequence++, {
              item_id: messageId, output_index: 0, content_index: 0, text: this.text,
            });
            enqueueResponseEvent(controller, "response.content_part.done", this.sequence++, {
              item_id: messageId, output_index: 0, content_index: 0, part: message.content[0],
            });
            enqueueResponseEvent(controller, "response.output_item.done", this.sequence++, {
              output_index: 0, item: message,
            });
            enqueueResponseEvent(controller, "response.completed", this.sequence++, {
              response: {
                id, object: "response", status: "completed", model,
                output: [message, ...this.toolItems], error: null,
                usage: event.usage && {
                  input_tokens: event.usage.prompt_tokens,
                  output_tokens: event.usage.completion_tokens,
                  total_tokens: event.usage.total_tokens,
                },
              },
            });
          }
        }
      },
    }))
    .pipeThrough(new TextEncoderStream());
  return new Response(reader, { status: 200, headers: { "content-type": "text/event-stream; charset=utf-8", "cache-control": "no-cache" } });
}

function enqueueResponseEvent(controller, type, sequenceNumber, payload) {
  controller.enqueue(`event: ${type}\ndata: ${JSON.stringify({ type, sequence_number: sequenceNumber, ...payload })}\n\n`);
}

async function openAIUpstreamError(response) {
  let message = `Gemini upstream returned ${response.status}`;
  let code = 'upstream_error';
  try {
    const data = await response.json();
    message = data.error?.message || message;
    code = data.error?.status || code;
  } catch { /* ignore malformed upstream error bodies */ }
  return new Response(JSON.stringify({
    error: { message, type: code.toLowerCase(), param: null, code },
  }), {
    status: response.status,
    headers: { 'content-type': 'application/json; charset=utf-8' },
  });
}

const adjustProps = (schemaPart) => {
  if (typeof schemaPart !== "object" || schemaPart === null) {
    return;
  }
  if (Array.isArray(schemaPart)) {
    schemaPart.forEach(adjustProps);
  } else {
    if (schemaPart.type === "object" && schemaPart.properties && schemaPart.additionalProperties === false) {
      delete schemaPart.additionalProperties;
    }
    Object.values(schemaPart).forEach(adjustProps);
  }
};
const adjustSchema = (schema) => {
  const obj = schema[schema.type];
  delete obj.strict;
  return adjustProps(schema);
};

const fieldsMap = {
  frequency_penalty: "frequencyPenalty",
  max_completion_tokens: "maxOutputTokens",
  max_tokens: "maxOutputTokens",
  n: "candidateCount", // not for streaming
  presence_penalty: "presencePenalty",
  seed: "seed",
  stop: "stopSequences",
  temperature: "temperature",
  top_k: "topK", // non-standard
  top_p: "topP",
};
const thinkingBudgetMap = {
  low: 1024,
  medium: 8192,
  high: 24576,
};
const transformConfig = (req) => {
  let cfg = {};
  //if (typeof req.stop === "string") { req.stop = [req.stop]; } // no need
  for (let key in req) {
    const matchedKey = fieldsMap[key];
    if (matchedKey) {
      cfg[matchedKey] = req[key];
    }
  }
  if (req.response_format) {
    switch (req.response_format.type) {
      case "json_schema":
        adjustSchema(req.response_format);
        cfg.responseSchema = req.response_format.json_schema?.schema;
        if (cfg.responseSchema && "enum" in cfg.responseSchema) {
          cfg.responseMimeType = "text/x.enum";
          break;
        }
        // eslint-disable-next-line no-fallthrough
      case "json_object":
        cfg.responseMimeType = "application/json";
        break;
      case "text":
        cfg.responseMimeType = "text/plain";
        break;
      default:
        throw new HttpError("Unsupported response_format.type", 400);
    }
  }
  if (req.reasoning_effort) {
    cfg.thinkingConfig = { thinkingBudget: thinkingBudgetMap[req.reasoning_effort] };
  }
  return cfg;
};

const parseImg = async (url) => {
  let mimeType, data;
  if (url.startsWith("http://") || url.startsWith("https://")) {
    throw new HttpError("Remote image URLs are disabled; use a data URL", 400, "remote_media_disabled");
  } else {
    const match = url.match(/^data:(?<mimeType>[^;,]+);base64,(?<data>[A-Za-z0-9+/=\r\n]+)$/);
    if (!match) {
      throw new HttpError("Invalid image data: " + url, 400);
    }
    ({ mimeType, data } = match.groups);
  }
  return {
    inlineData: {
      mimeType,
      data,
    },
  };
};

const transformFnResponse = ({ content, tool_call_id }, parts) => {
  if (!parts.calls) {
    throw new HttpError("No function calls found in the previous message", 400);
  }
  let response;
  try {
    response = JSON.parse(content);
  } catch (err) {
    throw new HttpError("Invalid function response JSON", 400, "invalid_tool_result");
  }
  if (typeof response !== "object" || response === null || Array.isArray(response)) {
    response = { result: response };
  }
  if (!tool_call_id) {
    throw new HttpError("tool_call_id not specified", 400);
  }
  const { i, name } = parts.calls[tool_call_id] ?? {};
  if (!name) {
    throw new HttpError("Unknown tool_call_id: " + tool_call_id, 400);
  }
  if (parts[i]) {
    throw new HttpError("Duplicated tool_call_id: " + tool_call_id, 400);
  }
  parts[i] = {
    functionResponse: {
      id: tool_call_id.startsWith("call_") ? null : tool_call_id,
      name,
      response,
    }
  };
};

const transformFnCalls = ({ tool_calls }) => {
  const calls = {};
  const parts = tool_calls.map(({ function: { arguments: argstr, name }, id, type }, i) => {
    if (type !== "function") {
      throw new HttpError(`Unsupported tool_call type: "${type}"`, 400);
    }
    let args;
    try {
      args = JSON.parse(argstr);
    } catch (err) {
      throw new HttpError("Invalid function arguments JSON", 400, "invalid_tool_arguments");
    }
    calls[id] = {i, name};
    return {
      functionCall: {
        id: id.startsWith("call_") ? null : id,
        name,
        args,
      }
    };
  });
  parts.calls = calls;
  return parts;
};

const transformMsg = async ({ content }) => {
  const parts = [];
  if (!Array.isArray(content)) {
    // system, user: string
    // assistant: string or null (Required unless tool_calls is specified.)
    parts.push({ text: content });
    return parts;
  }
  // user:
  // An array of content parts with a defined type.
  // Supported options differ based on the model being used to generate the response.
  // Can contain text, image, or audio inputs.
  for (const item of content) {
    switch (item.type) {
      case "text":
        parts.push({ text: item.text });
        break;
      case "image_url":
        parts.push(await parseImg(item.image_url.url));
        break;
      case "input_audio":
        parts.push({
          inlineData: {
            mimeType: "audio/" + item.input_audio.format,
            data: item.input_audio.data,
          }
        });
        break;
      default:
        throw new HttpError(`Unknown "content" item type: "${item.type}"`, 400);
    }
  }
  if (content.every(item => item.type === "image_url")) {
    parts.push({ text: "" }); // to avoid "Unable to submit request because it must have a text parameter"
  }
  return parts;
};

const transformMessages = async (messages) => {
  if (!messages) { return; }
  const contents = [];
  let system_instruction;
  for (const item of messages) {
    switch (item.role) {
      case "system":
        system_instruction ??= { parts: [] };
        system_instruction.parts.push(...await transformMsg(item));
        continue;
      case "tool":
        // eslint-disable-next-line no-case-declarations
        let { role, parts } = contents[contents.length - 1] ?? {};
        if (role !== "user" || !parts?.calls) {
          const calls = parts?.calls;
          parts = []; parts.calls = calls;
          contents.push({
            role: "user",
            parts
          });
        }
        transformFnResponse(item, parts);
        continue;
      case "assistant":
        item.role = "model";
        break;
      case "user":
        break;
      default:
        throw new HttpError(`Unknown message role: "${item.role}"`, 400);
    }
    contents.push({
      role: item.role,
      parts: item.tool_calls ? transformFnCalls(item) : await transformMsg(item)
    });
  }
  if (system_instruction) {
    if (!contents[0]?.parts.some(part => part.text)) {
      contents.unshift({ role: "user", parts: { text: " " } });
    }
  }
  //console.info(JSON.stringify(contents, 2));
  return { system_instruction, contents };
};

const transformTools = (req) => {
  let tools, tool_config;
  if (req.tools) {
    const funcs = req.tools.filter(tool => tool.type === "function" && tool.function?.name !== 'googleSearch');
    if (funcs.length > 0) {
      funcs.forEach(adjustSchema);
      tools = [{ function_declarations: funcs.map(schema => schema.function) }];
    }
  }
  if (req.tool_choice) {
    const allowed_function_names = req.tool_choice?.type === "function" ? [ req.tool_choice?.function?.name ] : undefined;
    if (allowed_function_names || typeof req.tool_choice === "string") {
      tool_config = {
        function_calling_config: {
          mode: allowed_function_names ? "ANY" : req.tool_choice.toUpperCase(),
          allowed_function_names
        }
      };
    }
  }
  return { tools, tool_config };
};

const transformRequest = async (req) => ({
  ...await transformMessages(req.messages),
  generationConfig: transformConfig(req),
  ...transformTools(req),
});

async function proxyOfficialOpenAI(request, apiKey, config, path) {
  const suffix = path.replace(/^\/v1beta\/openai\/?/, '').replace(/^\/v1\/?/, '');
  const incoming = new URL(request.url);
  const target = new URL(`/v1beta/openai/${suffix}${incoming.search}`, BASE_URL);
  const headers = copyRequestHeaders(request.headers, { dropCredentials: true });
  headers.set('authorization', `Bearer ${apiKey}`);
  headers.set('x-goog-api-client', 'ggproxy-openai/2.0.0');
  const response = await fetchWithTimeout(target, {
    method: request.method,
    headers,
    body: ['GET', 'HEAD'].includes(request.method) ? undefined : request.body,
    signal: request.signal,
  }, config.upstreamTimeoutMs);
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers: copyResponseHeaders(response.headers),
  });
}

const generateId = () => {
  const characters = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  const randomChar = () => characters[Math.floor(Math.random() * characters.length)];
  return Array.from({ length: 29 }, randomChar).join("");
};

const reasonsMap = { //https://ai.google.dev/api/rest/v1/GenerateContentResponse#finishreason
  //"FINISH_REASON_UNSPECIFIED": // Default value. This value is unused.
  "STOP": "stop",
  "MAX_TOKENS": "length",
  "SAFETY": "content_filter",
  "RECITATION": "content_filter",
  //"OTHER": "OTHER",
};
const SEP = "\n\n|>";
const transformCandidates = (key, cand) => {
  const message = { role: "assistant", content: [] };
  for (const part of cand.content?.parts ?? []) {
    if (part.functionCall) {
      const fc = part.functionCall;
      message.tool_calls = message.tool_calls ?? [];
      message.tool_calls.push({
        id: fc.id ?? "call_" + generateId(),
        type: "function",
        function: {
          name: fc.name,
          arguments: JSON.stringify(fc.args),
        }
      });
    } else {
      message.content.push(part.text);
    }
  }
  message.content = message.content.join(SEP) || null;
  return {
    index: cand.index || 0, // 0-index is absent in new -002 models response
    [key]: message,
    logprobs: null,
    finish_reason: message.tool_calls ? "tool_calls" : reasonsMap[cand.finishReason] || cand.finishReason,
    //original_finish_reason: cand.finishReason,
  };
};
const transformCandidatesMessage = transformCandidates.bind(null, "message");
const transformCandidatesDelta = transformCandidates.bind(null, "delta");

const transformUsage = (data) => ({
  completion_tokens: data.candidatesTokenCount,
  prompt_tokens: data.promptTokenCount,
  total_tokens: data.totalTokenCount
});

const checkPromptBlock = (choices, promptFeedback, key) => {
  if (choices.length) { return; }
  if (promptFeedback?.blockReason) {
    choices.push({
      index: 0,
      [key]: null,
      finish_reason: "content_filter",
      //original_finish_reason: data.promptFeedback.blockReason,
    });
  }
  return true;
};

const processCompletionsResponse = (data, model, id) => {
  const obj = {
    id,
    choices: data.candidates.map(transformCandidatesMessage),
    created: Math.floor(Date.now()/1000),
    model: data.modelVersion ?? model,
    //system_fingerprint: "fp_69829325d0",
    object: "chat.completion",
    usage: data.usageMetadata && transformUsage(data.usageMetadata),
  };
  if (obj.choices.length === 0 ) {
    checkPromptBlock(obj.choices, data.promptFeedback, "message");
  }
  return JSON.stringify(obj);
};

const responseLineRE = /^data: (.*)(?:\n\n|\r\r|\r\n\r\n)/;
function parseStream (chunk, controller) {
  this.buffer += chunk;
  do {
    const match = this.buffer.match(responseLineRE);
    if (!match) { break; }
    controller.enqueue(match[1]);
    this.buffer = this.buffer.substring(match[0].length);
  } while (true); // eslint-disable-line no-constant-condition
}
function parseStreamFlush (controller) {
  if (this.buffer) {
    controller.enqueue(this.buffer);
    this.shared.is_buffers_rest = true;
  }
}

const delimiter = "\n\n";
const sseline = (obj) => {
  obj.created = Math.floor(Date.now()/1000);
  return "data: " + JSON.stringify(obj) + delimiter;
};
function toOpenAiStream (line, controller) {
  let data;
  try {
    data = JSON.parse(line);
    if (!data.candidates) {
      throw new Error("Invalid completion chunk object");
    }
  } catch (err) {
    if (!this.shared.is_buffers_rest) { line += delimiter; }
    controller.enqueue(line); // output as is
    return;
  }
  const obj = {
    id: this.id,
    choices: data.candidates.map(transformCandidatesDelta),
    //created: Math.floor(Date.now()/1000),
    model: data.modelVersion ?? this.model,
    //system_fingerprint: "fp_69829325d0",
    object: "chat.completion.chunk",
    usage: data.usageMetadata && this.streamIncludeUsage ? null : undefined,
  };
  if (checkPromptBlock(obj.choices, data.promptFeedback, "delta")) {
    controller.enqueue(sseline(obj));
    return;
  }
  console.assert(data.candidates.length === 1, "Unexpected candidates count: %d", data.candidates.length);
  const cand = obj.choices[0];
  cand.index = cand.index || 0; // absent in new -002 models response
  const finish_reason = cand.finish_reason;
  cand.finish_reason = null;
  if (!this.last[cand.index]) { // first
    controller.enqueue(sseline({
      ...obj,
      choices: [{ ...cand, tool_calls: undefined, delta: { role: "assistant", content: "" } }],
    }));
  }
  delete cand.delta.role;
  if ("content" in cand.delta) { // prevent empty data (e.g. when MAX_TOKENS)
    controller.enqueue(sseline(obj));
  }
  cand.finish_reason = finish_reason;
  if (data.usageMetadata && this.streamIncludeUsage) {
    obj.usage = transformUsage(data.usageMetadata);
  }
  cand.delta = {};
  this.last[cand.index] = obj;
}
function toOpenAiStreamFlush (controller) {
  if (this.last.length > 0) {
    for (const obj of this.last) {
      controller.enqueue(sseline(obj));
    }
    controller.enqueue("data: [DONE]" + delimiter);
  }
}
