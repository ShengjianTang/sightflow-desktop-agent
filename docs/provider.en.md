# Chat Provider integration

<p align="right"><a href="./provider.md">中文</a> · <b>English</b></p>

The SightFlow desktop client abstracts the "analyze a screenshot and generate a reply" chat capability into a Provider. As an external integrator you only need to supply a `manifest.json` and a bundle entry file; the app takes care of downloading and installing it, reading its config, passing in the chat screenshot, and consuming the events the Provider returns.

## Required structure of a Provider

A Provider package contains at least:

```text
provider-root/
  manifest.json
  provider.bundle.js
```

`manifest.json` declares the Provider's metadata, entry file, module format, and config form:

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
        "title": "API Key"
      },
      "model": {
        "type": "string",
        "title": "Model name",
        "default": "your-model"
      }
    },
    "required": ["apiKey"]
  }
}
```

Field constraints:

- `apiVersion` is currently fixed at `1`.
- `capabilities` is currently fixed at `["chat"]`.
- `entry` is the bundle file path relative to `manifest.json`.
- `moduleType` supports `module` or `commonjs`. If omitted, the app falls back to the legacy rule and infers ESM from a `.mjs` / `.mts` extension.
- `configSchema.properties` supports `string`, `password`, `select`, and `boolean`. These fields are shown on the app's settings page and passed to the Provider as `providerConfig`.

## Bundle export format

An ESM Provider can export `createProvider`:

```js
export function createProvider(context) {
  return {
    async *run(input) {
      yield { type: 'thinking', content: 'Analyzing the chat...' }

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

A CommonJS Provider can use:

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

`createProvider(context)` receives:

- `context.providerConfig` — the config the user filled in and saved on the settings page.
- `context.host.log(message)` — writes to the main-process log.
- `context.host.platform` — the current runtime platform.
- `context.host.appVersion` — the current app version.

`run(input)` receives:

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
  // Experience cards injected at runtime (work memory); a Provider may fold these into its system prompt
  memoryCards?: MemoryCardBrief[]
}
```

Here `screenshot` is a screenshot string in `data:image/...;base64,...` form. If your Provider calls an OpenAI-compatible vision API, you can usually pass it straight into `image_url.url`; if the target API only accepts raw base64, strip the `base64,` prefix yourself.

`memoryCards` are the experience cards injected at runtime by the Work Memory feature (each carries a scenario / guidance / rationale). A Provider may fold them into its system prompt to reuse past experience; ignoring them does not affect basic replies. See the Work Memory Runtime section in the [README](../README.md).

Events a Provider can return:

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

- `thinking` — surface the current processing status.
- `reply_text` — the app sends this text to the current chat window.
- `skip` — no reply this round, e.g. the last message was your own, a system message, or undecidable.
- `error` — this round failed; the error is shown in the run log.

`messages` must contain complete visible conversation bubbles with identifiable senders, including your own, in top-to-bottom order. Clipped history at the top can be omitted; the latest bubbles at the bottom cannot. Each entry carries its own avatar coordinates. The final entry must agree with `latestMessage`, `sender`, and `senderBbox`. Do not silently drop malformed entries: they may contain an outgoing reply. Built-in providers require this evidence from the first observation. Legacy text-only custom providers retain first-reply compatibility; subsequent replies need the ordered transcript and sender evidence.

`conversationHistory` contains completed turns; `pendingIncomingMessages` contains input retained after a cancelled send. Both are isolated by conversation. Combine pending input with the visible unanswered burst and generate one coherent reply using the earlier context, rather than answering only the last sentence. Completed history is not new input. The host validates message boundaries before sending and consumes each terminal result once. Users continue to enter credentials in settings or supported environment variables; never put credentials in messages or logs.

## Installing a Provider in the app

Launch the app, open the settings page, enter the address of your `manifest.json` under "Chat service config manifest URL", then click Install.

Supported address formats:

```text
https://example.com/provider/manifest.json
file:///absolute/path/to/provider/manifest.json
```

Note that this is the `manifest.json` address, not the bundle file address. The app downloads or reads the actual entry file based on the `entry` declared in the manifest.

## Doubao Provider example

The bundled example lives at:

```text
resources/providers/volcengine-ark/manifest.json
resources/providers/volcengine-ark/provider.bundle.js
```

It is wired up as follows:

1. `manifest.json` declares `id = volcengine-ark`, `moduleType = module`, `capabilities = ["chat"]`, and exposes three config fields: `apiKey`, `model`, and `systemPrompt`.
2. `provider.bundle.js` exports `createProvider(context)` and reads the API key, model name, and system prompt from `context.providerConfig`.
3. On receiving `input.screenshot`, the Provider calls the Volcengine Ark OpenAI-compatible API:

```text
POST https://ark.cn-beijing.volces.com/api/v3/responses
```

4. The request uses `input` with `input_image` and `input_text`, including completed context and the pending incoming batch.
5. Parse the structured decision, reviewing uncertain or incomplete evidence once. Valid replies include the transcript and sender evidence for host validation before sending; unresolved decisions return `skip`.

During local development you can install the bundled example by entering an address like the following on the settings page:

```text
file:///path/to/sightflow-dev-desktop/resources/providers/volcengine-ark/manifest.json
```

Other developers should replace the path with the absolute path of the repository on their own machine, or publish `manifest.json` and the bundle to a reachable HTTPS address.
