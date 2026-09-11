# ggproxy

ggproxy 是以 Gemini API 为上游的边缘网关，正式支持 Cloudflare Workers 和 Vercel Edge。

它有两种互不混用的调用方式：

| 方式 | 谁提供 Gemini API Key | 客户端使用的协议 |
|---|---|---|
| 后台中转 | 管理员在 `/admin` 保存的服务端 Key 池 | **仅 Gemini 原生协议** |
| 自带 Key（BYOK） | 调用者自己的 Gemini API Key | OpenAI、Gemini 或 Claude 兼容协议 |

## 先看地址和 Key

将 `https://proxy.example` 替换成自己的部署域名。

| 使用目的 | 地址 | 客户端填写的 Key | 说明 |
|---|---|---|---|
| 后台中转 | 与 Gemini 官方地址的路径完全相同，例如 `https://proxy.example/v1beta/models/...` | 后台创建的 `ggp_...` 客户端令牌 | 只适用于 Gemini 原生客户端 |
| BYOK：OpenAI | `https://proxy.example/openai/v1` | 自己的 Gemini API Key | 使用 OpenAI 兼容格式 |
| BYOK：Gemini | `https://proxy.example/gemini/v1beta` | 自己的 Gemini API Key | 使用 Gemini 原生格式 |
| BYOK：Claude | `https://proxy.example/claude/v1` | 自己的 Gemini API Key | 使用 Claude 兼容格式 |

### 后台中转的准确规则

这是向普通用户发放访问令牌时使用的方式。

1. 管理员在后台创建 `ggp_...` 客户端令牌，并提供中转域名。
2. 客户端选择 **Gemini** 或 **Gemini 原生**供应商。
3. 客户端请求路径保持与 Gemini 官方一致。举例：Google 的 `https://generativelanguage.googleapis.com/v1beta/models/...`，在 ggproxy 中就是 `https://proxy.example/v1beta/models/...`。
4. 将 `ggp_...` 放入 Gemini 的 `x-goog-api-key` 请求头，或 `key` 查询参数。

网关会验证该令牌，再从后台已启用的服务端 Key 中选择一个请求 Gemini。`ggp_...` **不能**用于 `/openai`、`/gemini` 或 `/claude` 前缀地址。

### 自带 Key（BYOK）的准确规则

这是调用者已经拥有 Gemini API Key 时使用的方式。必须选择与客户端协议相符的地址：

- OpenAI 客户端：Base URL 为 `https://proxy.example/openai/v1`，Key 填自己的 Gemini API Key。
- Gemini 客户端：Base URL 为 `https://proxy.example/gemini/v1beta`，Key 填自己的 Gemini API Key。
- Claude 客户端：Base URL 为 `https://proxy.example/claude/v1`，Key 填自己的 Gemini API Key。

BYOK 请求不会使用后台 Key 池、轮询策略或模型白名单。不要将 `ggp_...` 令牌填进 BYOK 配置。

## 支持的接口

### Gemini 原生

支持 `/v1/*`、`/v1beta/*`、`/upload/v1/*` 和 `/upload/v1beta/*` 的 Gemini 原生请求，包括模型列表、内容生成、流式响应、Embedding、Token Count、Files 和 Caches。原生请求不转换格式。

### OpenAI 兼容

支持：

- `POST /v1/chat/completions`
- `POST /v1/completions`
- `POST /v1/responses`
- `POST /v1/embeddings`
- `GET /v1/models`

OpenAI 请求最终由 Gemini 处理。模型名为 `gemini-*`、`gemma-*` 或 `learnlm-*` 时使用该模型；其他模型名使用 `DEFAULT_GEMINI_MODEL`，默认值为 `gemini-3.5-flash-lite`。

### Claude 兼容

支持：

- `POST /v1/messages`
- `POST /v1/messages/count_tokens`

支持文本、base64 图片或文档、工具调用和流式响应。Claude 厂商专属的托管工具不在支持范围内。

OpenAI 和 Claude 与 Gemini 的字段并不完全相同。网关只转换已实现的接口和字段；无法处理的请求会返回 4xx 错误，不会悄悄删除内容后继续请求。远程图片 URL 默认拒绝，请使用 base64 data URL。

## 后台管理

后台地址为 `https://你的域名/admin`。它用于：

- 添加、启用、停用或删除服务端 Gemini API Key；
- 选择随机或轮询；
- 设置允许中转的 Gemini 模型；模型列表留空表示不限制；
- 创建或撤销 `ggp_...` 客户端令牌。

后台不会提供用户账户、计费、余额、用量统计或请求日志。服务端 Gemini API Key 使用 `ADMIN_ENCRYPTION_KEY` 加密保存；客户端令牌仅保存哈希，令牌明文只在创建时显示一次。

要启用后台中转，必须配置：

| 变量或绑定 | 作用 |
|---|---|
| `ADMIN_TOKEN` | `/admin` 的登录口令；未配置时 `/admin` 返回 404 |
| `ADMIN_ENCRYPTION_KEY` | 至少 32 个字符；用于加密服务端 Gemini API Key，必须妥善备份 |
| `GGPROXY_ADMIN_KV` | Cloudflare Workers 的 KV 绑定 |
| `ADMIN_KV_REST_URL` 和 `ADMIN_KV_REST_TOKEN` | Vercel Edge 的 REST KV 配置；也支持对应的 Upstash/Vercel KV 变量名 |

`GEMINI_API_KEYS` 是兼容回退：后台没有启用的服务端 Key 时，后台中转会使用它；新部署建议直接在后台管理 Key。

## 环境变量

| 变量 | 默认值 | 作用 |
|---|---:|---|
| `GEMINI_API_KEYS` | 空 | 兼容回退的服务端 Gemini API Key；多个 Key 用英文逗号分隔 |
| `PROXY_TOKEN` / `PROXY_TOKENS` | 空 | 可选的静态网关令牌；用于既有部署兼容 |
| `DEFAULT_GEMINI_MODEL` | `gemini-3.5-flash-lite` | OpenAI/Claude 请求中非 Gemini 模型名的默认上游模型 |
| `MAX_BODY_BYTES` | `10485760` | 最大请求体大小，单位为字节 |
| `UPSTREAM_TIMEOUT_MS` | `120000` | 上游超时，单位为毫秒 |
| `CORS_ORIGINS` | 空 | 允许跨域的 Origin，多个值用英文逗号分隔；`*` 表示所有来源 |
| `VERIFY_ENABLED` | `false` | 是否开启 `/verify` |

## 调用示例

### 后台中转：Gemini 原生

```bash
curl "https://proxy.example/v1beta/models/gemini-3.5-flash-lite:generateContent" \
  -H "x-goog-api-key: $GGP_CLIENT_TOKEN" \
  -H "content-type: application/json" \
  -d '{"contents":[{"parts":[{"text":"Hello"}]}]}'
```

### BYOK：OpenAI

```bash
curl "https://proxy.example/openai/v1/chat/completions" \
  -H "Authorization: Bearer $GEMINI_API_KEY" \
  -H "content-type: application/json" \
  -d '{"model":"gemini-3.5-flash-lite","messages":[{"role":"user","content":"Hello"}]}'
```

### BYOK：Claude

```bash
curl "https://proxy.example/claude/v1/messages" \
  -H "x-api-key: $GEMINI_API_KEY" \
  -H "anthropic-version: 2023-06-01" \
  -H "content-type: application/json" \
  -d '{"model":"gemini-3.5-flash-lite","max_tokens":512,"messages":[{"role":"user","content":"Hello"}]}'
```

## 部署与文档

正式部署目标：

- Cloudflare Workers：`src/index.js` 与 `wrangler.toml`
- Vercel Edge：`api/vercel_index.js` 与 `vercel.json`

Deno 和 Netlify 仅保留最小入口兼容层，不提供独立部署说明或测试承诺。

- [手动部署操作手册](docs/手动部署操作手册.md)
- [自动化部署操作指南](docs/一键自动化部署操作指南.md)
- [Kelivo 用户使用教程](docs/Kelivo用户使用教程.md)

## 本地检查

```bash
npm test
npm run check
```

## License

MIT
