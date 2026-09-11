# 版本更新说明

## 当前版本

### 路由与认证

- 后台创建的 `ggp_...` 客户端令牌只用于 Gemini 原生协议。
- 使用 `ggp_...` 时，路径与 Gemini 官方 API 路径相同，例如 `/v1beta/models/...`；令牌通过 `x-goog-api-key` 请求头或 `key` 查询参数传入。
- 使用调用者自己的 Gemini API Key 时，必须使用带协议前缀的地址：`/openai/v1`、`/gemini/v1beta` 或 `/claude/v1`。
- `ggp_...` 令牌不能用于上述三个带协议前缀的地址。

### 后台管理

- 后台可加密保存多个服务端 Gemini API Key，并可启用、停用和删除。
- 后台可选择随机或轮询，并设置允许中转的 Gemini 模型。
- 后台可创建和撤销客户端令牌；令牌只在创建时显示明文一次。

### 平台与默认值

- 正式支持 Cloudflare Workers 和 Vercel Edge。
- Deno 与 Netlify 仅保留最小入口兼容层，不提供独立部署方案。
- 默认 Gemini 模型为 `gemini-3.5-flash-lite`。

## 历史说明

较早版本曾允许根据请求路径和认证头推断 OpenAI、Gemini 或 Claude 协议。当前版本不建议使用该规则：新配置应完全遵循上方的明确地址和认证方式。
