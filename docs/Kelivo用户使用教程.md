# Kelivo 用户使用教程

这份教程面向收到管理员中转服务的普通用户。默认使用“后台中转”：你不需要拥有 Gemini API Key。

开始前，请向管理员索取：

- 中转网址，例如 `https://proxy.example`
- 用户令牌，例如 `ggp_...`

不要把用户令牌发给他人。它相当于你的访问凭证。

## 使用管理员提供的中转服务

1. 在 Kelivo 打开 **设置 → Providers（供应商）**，选择添加供应商。
2. 类型选择 **Gemini** 或 **Gemini 原生**。不要选择 OpenAI 或 Claude。
3. 按下表填写并保存。

| 字段 | 填写内容 |
|---|---|
| 名称 | 任意，例如 `我的 ggproxy` |
| Base URL / API 主机 | 管理员给的中转网址加 `/v1beta`，例如 `https://proxy.example/v1beta` |
| API Key | 管理员给的 `ggp_...` 用户令牌 |
| API Path | 保持 Gemini 供应商的默认值；不要改成 `/chat/completions` |

4. 点击 **Fetch models / 获取模型**。
5. 勾选要使用的模型，回到对话页选择该模型后发送测试消息。

这套配置发送的地址与 Gemini 官方地址一致。例如模型列表请求会访问 `https://proxy.example/v1beta/models`。`ggp_...` 令牌只能放在 Gemini 配置中，不能用于 `/openai`、`/gemini` 或 `/claude` 地址。

Kelivo 的通用操作可参阅 [Kelivo 使用手册](https://kelivo.psycheas.top/guide)。

## 使用自己的 Gemini API Key（BYOK）

如果你不使用管理员的 Key 池，而是使用自己的 Gemini API Key，请新建一个单独的供应商配置。选择的供应商类型、Base URL 和 API Key 必须对应：

| 供应商类型 | Base URL / API 主机 | API Key |
|---|---|---|
| OpenAI | `https://proxy.example/openai/v1` | 你自己的 Gemini API Key |
| Gemini | `https://proxy.example/gemini/v1beta` | 你自己的 Gemini API Key |
| Claude | `https://proxy.example/claude/v1` | 你自己的 Gemini API Key |

BYOK 不使用管理员后台的服务端 Key、轮询策略或模型限制。不要把 `ggp_...` 用户令牌填进这些配置。

## 常见问题

### 获取模型或聊天时提示 401

确认你选择的是 Gemini 供应商，且 API Key 是管理员提供的 `ggp_...` 令牌。删除 Key 前后的空格后重新保存。若之前可用、现在不可用，可能是管理员撤销了令牌，需要联系管理员重新创建。

### 提示 404

使用 `ggp_...` 时，Base URL 应是 `https://你的域名/v1beta`，不要添加 `/openai`、`/gemini` 或 `/claude`。使用自己的 Key 时，必须使用上表中与供应商类型一致的地址。

### 没有可选模型

先再次点击“获取模型”。若仍然为空，将错误提示截图发给管理员；管理员需要检查服务端是否有已启用的 Gemini API Key，以及后台模型限制是否允许该模型。

### 可以复制到另一台自己的设备吗？

可以用 Kelivo 的供应商配置导出或二维码功能。但其中包含用户令牌，只能在自己的设备之间传输。设备丢失或怀疑令牌泄露时，立即请管理员撤销该令牌。
