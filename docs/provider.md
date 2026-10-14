# 聊天 Provider 接入

<p align="right"><b>中文</b> · <a href="./provider.en.md">English</a></p>

SightFlow 桌面端把“截图分析并生成回复”的聊天能力抽象为 Provider。外部技术使用者只需要提供一份 `manifest.json` 和一个 bundle 入口文件，应用会负责下载安装、读取配置、传入聊天截图，并消费 Provider 返回的事件。

## Provider 必须提供的结构

一个 Provider 包至少包含：

```text
provider-root/
  manifest.json
  provider.bundle.js
```

`manifest.json` 用来声明 Provider 元信息、入口文件、模块格式和配置表单：

```json
{
  "apiVersion": 1,
  "id": "your-provider-id",
  "name": "Your Chat Provider",
  "version": "1.0.0",
  "entry": "provider.bundle.js",
  "moduleType": "module",
  "capabilities": ["chat"],
  "configSchema": {
    "type": "object",
    "properties": {
      "apiKey": {
        "type": "password",
        "title": "接口密钥"
      },
      "model": {
        "type": "string",
        "title": "模型名称",
        "default": "your-model"
      }
    },
    "required": ["apiKey"]
  }
}
```

字段约束：

- `apiVersion` 当前固定为 `1`。
- `capabilities` 当前固定为 `["chat"]`。
- `entry` 是相对 `manifest.json` 的 bundle 文件路径。
- `moduleType` 支持 `module` 或 `commonjs`。如果省略，应用会按旧规则根据 `.mjs` / `.mts` 判断是否使用 ESM。
- `configSchema.properties` 支持 `string`、`password`、`select`、`boolean`。这些字段会显示在应用设置页，并作为 `providerConfig` 传给 Provider。

## Bundle 导出格式

ESM Provider 可以导出 `createProvider`：

```js
export function createProvider(context) {
  return {
    async *run(input) {
      yield { type: 'thinking', content: '正在分析聊天内容...' }

      const reply = await callYourModel({
        screenshot: input.screenshot,
        appType: input.appType,
        config: context.providerConfig
      })

      if (!reply) {
        yield { type: 'skip' }
        return
      }

      yield { type: 'reply_text', content: reply }
    }
  }
}
```

CommonJS Provider 可以使用：

```js
module.exports = {
  createProvider(context) {
    return {
      async *run(input) {
        yield { type: 'skip' }
      }
    }
  }
}
```

`createProvider(context)` 会收到：

- `context.providerConfig`：用户在设置页填写并保存的配置。
- `context.host.log(message)`：写入主进程日志。
- `context.host.platform`：当前运行平台。
- `context.host.appVersion`：当前应用版本。

`run(input)` 会收到：

```ts
interface ProviderInput {
  screenshot: string
  // 'wechat' | 'wework' | 'dingtalk' | 'lark' | 'slack' | 'telegram' | 'generic'
  appType: AppType
  currentContact?: string
  ocrText?: string
  captureContext?: 'full_window' | 'chat_area'
  observation?: { conversationId: string; historyId: string; chatAreaBbox?: BBox }
  recentSentMessages?: string[]
  conversationHistory?: ConversationMessage[]
  pendingIncomingMessages?: ConversationMessage[]
  // 运行时注入的经验卡片（工作记忆），Provider 可拼入 system prompt
  memoryCards?: MemoryCardBrief[]
}
```

其中 `screenshot` 是 `data:image/...;base64,...` 格式的截图字符串。Provider 如果调用 OpenAI 兼容视觉接口，通常可以直接把它作为 `image_url.url` 传入；如果目标 API 只接受裸 base64，需要自行去掉 `base64,` 前缀。

`memoryCards` 是工作记忆功能在运行时注入的经验卡片（每张含场景 / 怎么做 / 为什么）。Provider 可选择把它拼进 system prompt 来复用历史经验；不处理也不影响基本回复。详见 [README 的工作记忆引擎章节](../README.zh-CN.md)。

Provider 可以返回的事件：

```ts
type BBox = [number, number, number, number] // screenshot coordinates, 0–1000
interface ConversationMessage {
  sender: 'incoming' | 'self'
  kind: 'text' | 'image' | 'emoji'
  text: string
}

type ProviderEvent =
  | { type: 'thinking'; content: string }
  | {
      type: 'reply_text'
      content: string
      latestMessage?: string
      sender?: 'incoming' | 'self' | 'unknown'
      senderBbox?: BBox
      messages?: (ConversationMessage & { senderBbox: BBox })[]
    }
  | { type: 'skip' }
  | { type: 'error'; error: string }
```

- `thinking`：展示当前处理状态。
- `reply_text`：应用会把这段文本发送到当前聊天窗口。
- `skip`：本轮不回复，例如最后一条消息是自己发的、系统消息、无法判断等。
- `error`：本轮失败，错误会展示到运行日志。

`messages` 必须按截图从上到下的顺序包含发送方可确认的完整可见普通消息，包括自身气泡；顶部被裁切的历史消息可以省略，底部最新消息不得省略。每条记录提供自己的头像位置，不能把多条消息合成一个位置，也不能丢掉格式错误的自身消息。`latestMessage`、`sender`、`senderBbox` 必须对应列表最后一条。内置 Provider 从第一轮就要求这些证据；旧自定义 Provider 的纯文字输出仅保留首次回复兼容，本会话回复后缺少消息列表会被拦截。

`conversationHistory` 是已完成的会话上下文，`pendingIncomingMessages` 是上一次因画面变化取消发送后仍待回答的内容，均按会话隔离。结合截图中最新未回复批次生成一次连贯回复，不要仅回答最后一句；历史中已回答的内容不是新消息。宿主在通过消息边界检查后才调用发送，并只接受每轮一次终态结果。API Key 继续由用户在设置页或支持的环境变量中填写，不要放进消息或日志。

## 在应用中安装 Provider

启动应用后进入设置页，在“聊天服务配置清单地址”中填写 `manifest.json` 的地址，然后点击安装。

支持的地址格式：

```text
https://example.com/provider/manifest.json
file:///absolute/path/to/provider/manifest.json
```

注意这里填写的是 `manifest.json` 地址，不是 bundle 文件地址。应用会根据 manifest 中的 `entry` 下载或读取实际入口文件。

## Doubao Provider 示例

仓库内置示例位于：

```text
resources/providers/volcengine-ark/manifest.json
resources/providers/volcengine-ark/provider.bundle.js
```

它的接入方式是：

1. `manifest.json` 声明 `id = volcengine-ark`、`moduleType = module`、`capabilities = ["chat"]`，并暴露 `apiKey`、`model`、`systemPrompt` 三个配置项。
2. `provider.bundle.js` 导出 `createProvider(context)`，从 `context.providerConfig` 读取 API Key、模型名和系统提示词。
3. Provider 收到 `input.screenshot` 后，调用火山方舟 OpenAI 兼容接口：

```text
POST https://ark.cn-beijing.volces.com/api/v3/responses
```

4. 请求中使用 `input`，截图项为 `input_image`，文本项为 `input_text`，同时传入会话上下文和待回复批次。
5. 解析结构化判断；不确定或证据不足时复核一次，仍无法确认则 `skip`。通过检查的 `reply_text` 携带消息列表和发送方证据，由桌面端核对边界后发送。

本地开发时，可以在设置页填写类似下面的地址安装内置示例：

```text
file:///path/to/sightflow-dev-desktop/resources/providers/volcengine-ark/manifest.json
```

其他开发者需要把路径替换成自己机器上的仓库绝对路径，或者把 `manifest.json` 和 bundle 发布到可访问的 HTTPS 地址。
