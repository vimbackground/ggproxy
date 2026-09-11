# ggproxy

一个以 Gemini API 为上游的轻量边缘网关。它支持 Gemini 原生格式、OpenAI 格式和 Anthropic Claude 格式，并尽可能保持官方 URL 路径不变。

## URL 兼容

通常只需要把官方域名替换为自己的部署域名：

```text
https://generativelanguage.googleapis.com/v1beta/models/...
https://proxy.example/v1beta/models/...

https://api.openai.com/v1/chat/completions
https://proxy.example/v1/chat/completions

https://api.anthropic.com/v1/messages
https://proxy.example/v1/messages
```

`/v1/models` 同时存在于 Gemini 和 OpenAI 协议中。网关按凭证头确定协议：

- `x-goog-api-key`：Gemini
- `Authorization: Bearer ...`：OpenAI

如客户端无法提供可判定的请求头，可使用明确的备用前缀：`/gemini`、`/openai` 或 `/anthropic`。

## 支持范围

### Gemini 原生格式

`/v1/*`、`/v1beta/*` 和 `/upload/v1/*`、`/upload/v1beta/*` 透明转发，包括：

- `generateContent` 和 `streamGenerateContent`
- 新版 Interactions API
- Models、Embeddings、Token Count、Files、Caches 等原生资源
- 普通 JSON、SSE 和二进制上传

原生请求不会经过协议转换，因此最能保留 Gemini 的完整能力。

### OpenAI 格式

- `POST /v1/chat/completions`
- `POST /v1/completions`
- `POST /v1/responses`
- `POST /v1/embeddings`
- `GET /v1/models`
- `POST /v1beta/openai/chat/completions` 等 Google 官方兼容路径

支持非流式和 SSE、文本、base64 图片、音频输入、函数工具、结构化输出及基础 usage 映射。

由于所有请求最终调用 Gemini，OpenAI 模型名会映射至 `DEFAULT_GEMINI_MODEL`。也可以直接填写 `gemini-*`、`gemma-*` 或 `learnlm-*` 模型名。

### Anthropic Claude 格式

- `POST /v1/messages`
- `POST /v1/messages/count_tokens`
- `anthropic-version: 2023-06-01`
- 非流式与 Claude 具名 SSE
- 文本、base64 图片/文档、工具调用与工具结果

Claude 模型名同样映射至 `DEFAULT_GEMINI_MODEL`。

## 安全配置

安全默认值：

- 不记录 API Key、Authorization、请求体或查询参数。
- CORS 默认关闭。
- `/verify` 默认关闭。
- 远程媒体 URL 默认拒绝，避免代理成为 SSRF 出口；请使用 base64 data URL。
- 默认最大请求体为 10 MiB。
- 默认上游超时为 120 秒。
- 上游错误不会向客户端返回网关堆栈。

建议公开部署时配置独立的网关访问令牌：

```text
PROXY_TOKEN=随机长令牌
```

旧版调用可继续增加：

```http
x-proxy-token: 随机长令牌
```

这个令牌与 Gemini API Key 分离，防止代理域名被第三方直接滥用。

如需向多个普通用户发放访问权，请配置 `ADMIN_TOKEN` 和管理存储，然后在 `/admin` 创建可单独撤销的客户端令牌。客户端可将该令牌直接填入 OpenAI 的 API Key 字段；网关会用已配置的服务端 Gemini Key 池请求上游，不会把该客户端令牌转发出去。

## 环境变量

| 变量 | 默认值 | 说明 |
|---|---:|---|
| `PROXY_TOKEN` | 空 | 可选的网关访问令牌，生产环境强烈建议配置 |
| `PROXY_TOKENS` | 空 | 可选的静态网关令牌，多个值以英文逗号分隔 |
| `GEMINI_API_KEYS` | 空 | 服务端 Gemini Key 池，多个 Key 用逗号分隔 |
| `ADMIN_TOKEN` | 空 | `/admin` 后台登录令牌；配置后才启用后台 |
| `GGPROXY_ADMIN_KV` | 无 | Cloudflare Workers KV 绑定，用于保存后台创建的客户端令牌哈希 |
| `ADMIN_KV_REST_URL` / `ADMIN_KV_REST_TOKEN` | 空 | Vercel Edge 等环境使用的 REST KV 地址与写入令牌；也识别标准 Upstash/Vercel KV 变量名 |
| `DEFAULT_GEMINI_MODEL` | `gemini-2.5-flash` | 非 Gemini 模型名的默认映射目标 |
| `MAX_BODY_BYTES` | `10485760` | JSON/请求体大小限制 |
| `UPSTREAM_TIMEOUT_MS` | `120000` | 上游超时 |
| `CORS_ORIGINS` | 空 | 允许的 Origin，逗号分隔；`*` 表示全部 |
| `VERIFY_ENABLED` | `false` | 是否启用 `/verify` |

API Key 来源按顺序包括官方请求头和可选的 `GEMINI_API_KEYS`。为了兼容旧版本，官方 Key 头仍支持逗号分隔多个 Key，但新部署更推荐使用服务端 Key 池。

### 轻量后台

后台刻意只保留三项基础能力：查看是否已配置服务端 Key 池/存储、创建客户端访问令牌、撤销客户端访问令牌。它不记录对话、请求内容、上游 Key 或用量。

1. 设置高强度的 `ADMIN_TOKEN`。
2. Cloudflare Workers：创建 KV namespace 并以 `GGPROXY_ADMIN_KV` 绑定给 Worker；Vercel Edge：配置兼容 Upstash REST 的 `ADMIN_KV_REST_URL` 和 `ADMIN_KV_REST_TOKEN`。
3. 打开 `https://你的域名/admin`，输入 `ADMIN_TOKEN`，创建用户令牌。

新令牌只会在创建时显示一次；请保存后再交给用户。若希望用户只需填“中转网址 + 用户令牌”，还必须配置 `GEMINI_API_KEYS`，这样用户令牌不会被当成 Gemini Key 使用。

## 调用示例

### Gemini

```bash
curl "https://proxy.example/v1beta/models/gemini-2.5-flash:generateContent" \
  -H "x-goog-api-key: $GEMINI_API_KEY" \
  -H "content-type: application/json" \
  -d '{"contents":[{"parts":[{"text":"Hello"}]}]}'
```

### OpenAI

```bash
curl "https://proxy.example/v1/chat/completions" \
  -H "Authorization: Bearer $GEMINI_API_KEY" \
  -H "content-type: application/json" \
  -d '{"model":"gemini-2.5-flash","messages":[{"role":"user","content":"Hello"}]}'
```

### Claude

```bash
curl "https://proxy.example/v1/messages" \
  -H "x-api-key: $GEMINI_API_KEY" \
  -H "anthropic-version: 2023-06-01" \
  -H "content-type: application/json" \
  -d '{"model":"claude-compatible","max_tokens":512,"messages":[{"role":"user","content":"Hello"}]}'
```

## 部署

项目的正式部署目标为两个边缘平台：

- Cloudflare Workers：`src/index.js` / `wrangler.toml`
- Vercel Edge：`api/vercel_index.js` / `vercel.json`

`src/deno_index.ts` 与 `netlify/functions/api.js` 仅保留为极薄的兼容适配器，方便将来增加正式方案；不再提供 Deno 或 Netlify 的部署配置、测试承诺或操作文档。

详细文档：

- [手动部署操作手册](docs/手动部署操作手册.md)
- [自动化部署操作指南（连接现有仓库）](docs/一键自动化部署操作指南.md)
- [Kelivo 用户使用教程（只需中转网址和用户令牌）](docs/Kelivo用户使用教程.md)

## 本地检查

```bash
npm test
npm run check
```

测试使用 Node.js 内置测试框架，不增加运行时依赖，也不会调用真实 Gemini API。

## 兼容性边界

三家协议并非一一对应。当前实现遵循以下规则：

- Gemini 原生请求优先无损透传。
- 可可靠映射的字段进行转换。
- 不支持的内容类型返回明确的 4xx，而不是静默丢弃。
- OpenAI/Claude 的厂商专属托管工具不伪装成已支持。
- 远程图片 URL 默认拒绝；base64 图片可正常转换。
- Responses 流式接口覆盖文本输出；复杂多工具流仍建议优先使用 Chat Completions 或 Gemini 原生协议。

## License

MIT
