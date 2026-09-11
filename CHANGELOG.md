# 版本更新说明

本文档记录 ggproxy 的重要功能变化、安全修复和兼容性调整。

版本格式遵循[语义化版本](https://semver.org/lang/zh-CN/)，更新分类参考 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)。

## [未发布]

### 新增

- 后台新增加密服务端 Gemini Key 池、Key 启用/停用、随机或轮询策略和允许模型列表。
- 新增明确的 `/byok/...` 入口；`/v1` 保持本站客户端令牌模式。
- 新增 `/admin` 轻量后台：可查看安全配置状态，并创建或撤销客户端访问令牌。
- 新增 Cloudflare Workers KV 与兼容 Upstash REST 的 KV 存储适配；令牌仅保存 SHA-256 哈希，明文仅在创建时返回一次。
- 新增面向普通用户的 Kelivo 接入教程。

### 变更

- 正式部署范围收敛为 Cloudflare Workers 与 Vercel Edge；Deno 和 Netlify 仅保留未承诺的最小入口兼容层。
- `PROXY_TOKEN` 保持兼容；新增 `PROXY_TOKENS` 静态令牌列表，并允许已验证的网关令牌出现在 OpenAI 的 `Authorization: Bearer` 中，以支持普通客户端直接配置。
- 默认 Gemini 模型改为 `gemini-3.5-flash-lite`。

## [2.0.0] - 2026-09-11

### 新增

- 新增统一协议网关，可自动识别 Gemini、OpenAI 和 Anthropic Claude 请求。
- 新增 Gemini `/v1`、`/v1beta`、Interactions API 和上传路径的透明转发。
- 新增 OpenAI Responses API 兼容，包括非流式和文本流式响应。
- 新增 Anthropic Claude Messages API、Token Count、工具调用和具名 SSE 支持。
- 新增 `/gemini`、`/openai`、`/anthropic` 显式协议前缀，供路径存在歧义时使用。
- 新增 `PROXY_TOKEN` 独立网关访问认证。
- 新增服务端 Gemini Key 池和 `DEFAULT_GEMINI_MODEL` 模型映射配置。
- 新增请求体大小、上游超时和 CORS 来源配置。
- 新增 `/healthz` 健康检查端点。
- 新增基于 Node.js 内置测试框架的协议与安全契约测试。

### 优化

- Gemini 原生请求改为尽量无损透传，减少协议转换造成的能力损失。
- OpenAI 未由本地适配器实现的资源会转发至 Google 官方 OpenAI 兼容入口。
- `/v1/models` 根据认证头区分 Gemini 与 OpenAI 请求。
- 调用方提供的 API Key 优先于服务端 Key 池，避免意外消耗服务端额度。
- OpenAI、Claude 和 Gemini 分别返回符合对应协议的错误结构。
- Netlify 路由由仅转发根路径改为转发全部路径。
- 多平台入口统一传递部署环境配置。

### 安全修复

- 移除完整 API Key、Authorization、请求头、请求体及上游响应内容日志。
- 不再向客户端返回内部异常堆栈。
- CORS 默认关闭，仅对配置的来源开放。
- `/verify` 默认关闭；启用后限制单次验证的 Key 数量。
- Key 验证改用 Models 接口，避免通过内容生成验证而产生不必要消耗。
- 默认拒绝由网关抓取远程媒体 URL，降低 SSRF 和内部网络探测风险。
- 转发请求时移除 hop-by-hop、代理认证及平台转发头。
- 增加安全响应头、请求 ID、超时和客户端取消传播。
- 移除代理强制设置 Gemini `BLOCK_NONE` 的行为，保留上游默认安全策略。

### 兼容性变化

- 项目名称统一为 `ggproxy`，版本提升至 `2.0.0`，并声明使用 ES Modules。
- OpenAI 或 Claude 模型名默认映射到 `DEFAULT_GEMINI_MODEL`；Gemini 模型名保持原值。
- Claude 请求必须携带 `anthropic-version: 2023-06-01`。
- 远程图片 URL 不再由网关下载；OpenAI 图片输入应使用 base64 data URL，Claude 图片或文档应使用 base64 source。
- `/verify` 如需继续使用，必须显式配置 `VERIFY_ENABLED=true`。
- 配置 `PROXY_TOKEN` 后，业务请求必须携带 `x-proxy-token`。

### 已知限制

- OpenAI Responses 的复杂多工具流式事件仅提供基础兼容，复杂场景优先使用 Chat Completions 或 Gemini 原生协议。
- OpenAI 和 Gemini 的 `/v1/models` 路径相同；无法通过认证头判定时应使用 `/gemini` 或 `/openai` 前缀。
- 三家协议并非完全一一对应，厂商专属托管工具不会被伪装为已支持。
- 本版本已通过本地语法检查和 17 项模拟上游测试，尚未完成携带真实 API Key 的端到端验证。
- Cloudflare Wrangler dry-run 因当前开发环境依赖安装异常尚未完成。

## [1.x]

### 原始能力

- 提供 Gemini API 基础反向代理。
- 支持通过逗号分隔多个 Gemini API Key 并随机选择。
- 支持基础 OpenAI Chat Completions、Embeddings 和 Models 格式转换。
- 提供 Vercel、Cloudflare Workers、Deno Deploy 和 Netlify 部署入口。
- 提供批量 API Key 验证端点。
