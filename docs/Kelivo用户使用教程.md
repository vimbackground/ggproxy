# Kelivo 用户使用教程

这份教程只面向使用者。你只需要从管理员获得两项内容：

- **中转网址**，例如 `https://proxy.example`
- **用户令牌**，通常以 `ggp_` 开头

不要向管理员索取 Gemini API Key，也不要把自己的用户令牌发给其他人。

## 设置步骤

1. 打开 Kelivo，进入 **设置 / Providers（供应商）**，点击添加供应商。
2. 类型选择 **OpenAI** 或 **OpenAI 兼容**。
3. 按下面填写：

| 字段 | 填写内容 |
|---|---|
| 名称 | 任意，例如 `我的 ggproxy` |
| Base URL / API 主机 | 管理员给的中转网址加 `/v1`，例如 `https://proxy.example/v1` |
| API Key | 管理员给的用户令牌（`ggp_...`） |
| API 路径 | 保持默认 `/chat/completions`，不要清空 |

4. 保存后点击 **获取模型**，在返回的列表中启用一个模型。
5. 回到对话页，选中刚启用的模型，发送一句测试消息。

Kelivo 的官方指南也建议 OpenAI 兼容服务的 Base URL 通常以 `/v1` 结尾，填完 Key 后使用“获取模型”；默认请求路径应保持 `/chat/completions`。[查看 Kelivo 使用手册](https://kelivo.psycheas.top/guide)

## 使用自己的 Gemini Key（BYOK）

这是与本站中转令牌明确分开的高级模式。管理员允许你使用时，类型仍选 OpenAI / OpenAI 兼容，但改为：

| 字段 | 填写内容 |
|---|---|
| Base URL / API 主机 | 中转网址加 `/byok/v1`，例如 `https://proxy.example/byok/v1` |
| API Key | 你自己的 Gemini API Key |

BYOK 不使用管理员后台的 Key 池，也不占用后台客户端令牌。不要把本站客户端令牌填进 BYOK 配置。

## 常见问题

### 获取模型或聊天时提示 401

确认 API Key 填的是管理员给的用户令牌，不是 Gemini Key；检查是否多复制了空格。若此前能用而现在不行，令牌可能已被撤销，请联系管理员重新创建。

### 提示 404

Base URL 必须是管理员给的域名加 `/v1`，不要填成 Gemini、OpenAI 或 Anthropic 官方域名；“API 路径”保持默认即可。

### 没有可选模型

先重新点击“获取模型”。如果仍为空，请把错误提示截图发给管理员；管理员需要检查中转服务的模型设置。

### 可以把配置复制到另一台设备吗？

可以使用 Kelivo 的供应商配置导出/二维码功能，但二维码里含有用户令牌，只应在你自己的设备之间传输。丢失设备或怀疑泄露时，立即联系管理员撤销该令牌。
