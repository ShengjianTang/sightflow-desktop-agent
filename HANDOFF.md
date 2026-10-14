# SightFlow dev/tyz 恢复交接（含后续历史记录）

更新时间：2026-10-14（Asia/Shanghai）

当前状态：`dev/tyz` 在恢复的 122 项测试基线上修复了“点击未读联系人后卡在输入框复核、未进入内容回复”的布局校验问题，本次全量 125/125 通过并重新构建。当前 HEAD 为用户提交的 `7247b3c`，本轮修改尚未提交。后文微信专用运行时和 280 项结果属于已移出的开发历史，不代表当前源码。

## 2026-10-14：点击联系人后未进入回复的布局修复

- 用户日志返回历史框 `[343,171,660,708]`、输入框 `[350,720,840,849]`。历史框被模型截成可见气泡的窄区域，旧规则要求输入框右边界不超过历史框右边界 +100，因此拒绝了位置和高度有效的输入框，随后追加复核请求超时，未进入 Provider 内容识别。
- 修改仅在既有 `src/core/rpa/vision-utils.ts`：改为检查中心、左边界、高度和至少 60% 较窄区域的水平重叠；用已通过校验的编辑框右边界补全历史区域，且不推测到整个窗口宽度。提示词明确要求完整历史面板，不仅框气泡/图片。无重叠、过小输入框、网页等情况继续复核或拒绝。
- 新增两项坐标回归和一项流程回归：空页面 → 检测/点击未读联系人 → 生产布局解析 → 硅基流动 Provider 文本/图片解析 → 会话去重/发送 → 继续未读轮询。流程使用模型与发送替身，没有真实联系人发送。
- 验证：`npm test` 125/125；`npm run build`（含 node/web 类型检查）、忽略 `.local/` 的无缓存 ESLint、修改文件 Prettier 检查、`git diff --check` 全部通过。本次局部修复保留旧消息去重、连续消息批次与会话上下文，不重新引入已移出的微信专用运行时，也不改变个人密钥和模型配置。
- 未验证：实际模型响应时间、真实微信发送与回复质量。第一条视觉请求本身仍可能遇到网络或服务超时；本次去除了这组有效坐标导致的不必要第二次请求。

构建产物已更新。完全退出旧 SightFlow 实例后从项目目录运行 `npm start`，才能确保主进程使用本次布局逻辑。

## 0. 2026-10-14 目标节点恢复

- 目标会话 ID：`01a12eda-344e-7ae3-b778-cf418b30c6c8`；最终报告记录旧消息去重、自身回复拦截、连续消息批次和会话上下文，以及微信回复流程、Provider 调用链和手动配置方式。
- 恢复依据：`8bbc196ac372c9365f732bf8eb9d6fb83b3eb5e3` 的 Git 树，加上后续会话在任何源码编辑前创建的 `.local/repair-backup-20261013-1830/files`。该快照有 42 个受跟踪修改和 31 个未跟踪文件，73 项 SHA-256 全部匹配，最新文件修改时间早于目标报告。它不是目标时刻的完整独立快照，而是可校验的完整工作区增量重建。
- 恢复的文件：逐文件替换 25 项，包括 `.prettierignore`、`eslint.config.mjs`、`resources/providers/volcengine-ark/provider.bundle.js`、`scripts/test-cli.ts`、`src/core/{ai-client,generic-channel-session,http-request,siliconflow-client,vision-client,runtime-host,session-types}.ts`、`src/core/rpa/window-utils.ts`、`src/core/rpa/tests/test-{reply,screenshot,switch}.ts`、`src/main/{index,provider-bundle,settings,siliconflow-provider,skill-server}.ts`、`src/renderer/src/{App.tsx,index.css}` 和 `tests/{rpa-position,siliconflow,startup}.test.cjs`。完整逐项清单见项目外备份中的 `restore-plan.json`。
- 移出的目标节点后新增文件：33 项，包括五份 `docs/WECHAT_*.md`、`src/core/wechat/` 下 11 个文件、`src/main/wechat-vision.ts`、两个微信设置组件及 14 个 `tests/wechat-*.cjs`。原件保存在备份的 `post-target-files/`；完整清单同见 `restore-plan.json`。
- 保留：目标重建的 113 个代码文件、未改动的 Git 分支与 HEAD、被忽略的 `.local/` 用户数据和个人配置，以及本交接和 `docs/DEVELOPMENT_LOG.md` 两份后续历史文档。成功节点的去重、消息批次、上下文、Provider 和手动密钥配置功能均未重新开发。
- 实际复验：项目外重建目录及原工作区各执行 `npm test`，均 122/122 通过、失败 0；`npm run build`（含 node/web TypeScript）、历史范围 Prettier 检查、`git diff --check` 均通过。原目录 `npm run lint` 退出码 0，但因保留的 `.local/` 旧辅助脚本报告 1158 条格式警告；`eslint --no-cache . --ignore-pattern '.local/**'` 无输出、退出码 0。
- 未验证：真实火山方舟/硅基流动密钥请求、真实微信扫描与发送和模型回复质量。本次不恢复目标节点后的微信专用运行时；下文章节所述 233 至 280 项阶段性结果仅属历史记录。
- 回退前完整备份：`E:\codex\visualizations\2026\10\14\01a13953-132c-7651-92d4-93ec9b984f6f\backup-dev-tyz-20261014-153635`。包含 Git 状态、Diff、553 个逐文件哈希校验的项目文件和后续移出文件；只排除 `.git`、可重建的 `node_modules/`、`out/`、`.eslintcache`。备份可能含私有数据，不得上传。

以下第 1 节起为目标节点之后的历史交接内容，当前源码不再包含其中的微信专用模块。

## 1. 恢复来源

- 旧会话标题：`SightFlow 微信多模态消息识别与智能自动回复系统：源码审计、故障修复及端到端验证...`
- 旧会话 ID：`01a134cf-1b92-7f72-8a1c-6af769a2582b`
- 唯一对应的本地记录：`E:\codex\sessions\2026\10\13\rollout-2026-10-13T18-29-10-01a134cf-1b92-7f72-8a1c-6af769a2582b.jsonl`
- 记录规模：15,571,908 bytes，3,589 行。恢复时按用户消息、压缩摘要、阶段结论、关键命令和失败输出分段读取，没有修改旧记录，也没有复制密钥或原始聊天内容。
- 默认目录 `C:\Users\tangyizuo\.codex\sessions` 中没有本次会话；当前 Codex 实际使用 `CODEX_HOME=E:\codex`。
- 项目中恢复前没有 `HANDOFF.md` 或 `docs/DEVELOPMENT_LOG.md`。项目及上级目录没有非空的项目级 `AGENTS.md`；已阅读 README 和现有五份 `docs/WECHAT_*.md`。

## 2. 工作区和 Git 状态

| 项目                 | 当前确认值                                                                     |
| -------------------- | ------------------------------------------------------------------------------ |
| 项目目录             | `F:\tech_konwledge_base\08-Projects\03-SightFlow-Fork\sightflow-desktop-agent` |
| 分支                 | `dev/tyz`                                                                      |
| HEAD                 | `8bbc196ac372c9365f732bf8eb9d6fb83b3eb5e3`                                     |
| 上游                 | `origin/dev/tyz`，当前与本地 HEAD 相同                                         |
| Remote               | `https://github.com/ShengjianTang/sightflow-desktop-agent.git`                 |
| Worktree             | 只有当前项目工作树，无额外挂载 worktree                                        |
| 恢复检查开始时的改动 | 43 个受跟踪修改，64 个未跟踪文件                                               |

这些改动包含用户原有修改和旧会话开发结果，不能全部归因于某一次 Codex 修改。本次恢复没有执行 reset、clean、checkout、revert、commit 或 push，也没有覆盖现有实现。

可恢复备份仍在磁盘：

- `.local/repair-backup-20261013-1830`
- `.local/startup-repair-backup-20261013-2227`
- `.local/layout-timeout-backup-2026-10-13T15-29-29-934Z`

最后一份布局超时修复前快照包含 22 个文件和 SHA-256 清单。当前有 16 个快照内文件发生了后续修改，另新增或继续修改了 `tests/wechat-layout.test.cjs`、`tests/wechat-timeout.test.cjs` 等测试文件。

## 3. 原始开发目标

原始目标是通过 Windows 微信桌面客户端的可见 GUI 自动化，形成安全、可验证的闭环：

1. 扫描多个联系人或群聊并识别红点、未读数字。
2. 准确选择目标会话并再次验证标题、类型和辅助身份。
3. 读取文本、Unicode Emoji、图片、微信表情和静态表情包。
4. 区分接收消息、自身消息和群成员，组织近期上下文。
5. 通过多模态模型理解消息并生成相关回复。
6. 使用持久账本避免重复回复、重启重放和跨会话串线。
7. 在 Dry-run、人工确认或明确授权的自动模式下处理回复。
8. 发送前检查窗口、会话、草稿、焦点、粘贴内容和快捷键，发送后验证新增 outgoing 回显。
9. 支持多会话串行调度、暂停、恢复、停止、取消、有限重试和安全退出。
10. 任一关键证据不确定时不得猜测、不得继续发送。

用户还要求保护现有修改、先审计根因再修复、补充测试和交付文档，并严格区分模拟验证与真实微信验收。

## 4. 最新要求和中断点

旧会话中的最新业务反馈是：

> “我之前还是可以运行的，还能正常回复，只是有一点问题，现在修改后问题变得特别大了，请你认真的改正”

附件显示：

```text
FAILED · stopped_after_error
OPERATION_TIMEOUT
失败阶段：微信窗口布局识别
第 3/3 次失败，达到上限后停止
```

旧会话据此确认了两类独立问题：

- 外层普通操作期限为 30 秒，底层视觉请求期限为 90 秒，布局识别仍在等待时会被外层提前取消。
- 模型即使返回 HTTP 200 和合法 JSON，也可能返回不满足微信窗口结构的矩形，不能把“接口成功”当成“布局定位成功”。

用户在 2026-10-14 00:15（Asia/Shanghai）要求暂停。之后在 10:22 和 10:24 两次发送“继续”，两次均在助手开始工作前因以下错误失败：

```text
stream disconnected before completion: response protection is unavailable
```

因此，真正的中断点是：新增的生产级多模态 Dry-run 集成测试失败，尚未进入修复。

## 5. 已写入磁盘的设计和实现

以下为代码实际存在的能力，不代表全部经过真实微信验证：

| 能力           | 代码实际状态                                                                                                           |
| -------------- | ---------------------------------------------------------------------------------------------------------------------- |
| 微信专用状态机 | `WechatChannelSession` 已接入扫描、身份复核、账本、多模态理解、Provider、Dry-run/人工/auto 和诊断流程。                |
| 统一消息模型   | 文本、图片、Emoji/表情、方向、群成员、置信度和视觉描述使用统一类型。                                                   |
| 持久去重       | `MessageLedger` 包含首次基线、序列锚点、本地消息实例 ID、终态和不确定发送恢复。                                        |
| 安全发送       | `SafeSender` 检查会话、窗口、草稿、焦点、剪贴板、快捷键和发送后回显；不确定结果不自动重发。                            |
| 串行和取消     | Runtime/Channel 对 GUI 操作串行化，支持暂停、停止、AbortSignal、有限重试和错误上限。                                   |
| 诊断和隐私     | 保存固定错误码、失败阶段、次数、停止原因和耗时，不持久化原始 Provider 异常文本或聊天明文。                             |
| Provider 修复  | 硅基流动模型 ID 已从错误的 `Qwen/Qwen/Qwen3.5-9B` 修正为 `Qwen/Qwen3.5-9B`；运行和连接测试使用同一客户端工厂。         |
| 独立期限       | `visionTimeoutMs` 默认 90 秒；普通本地操作默认 30 秒；回复 Provider 默认 90 秒。视觉阶段按请求数和本地操作数计算预算。 |
| 布局校验       | 生产布局解析要求区域完整、顺序和左右关系合理；格式/坐标/结构失败时，仅在本地像素同时证明四条持续分隔线后生成容器回退。 |
| 设置和 UI      | 设置界面提供视觉期限、模式、授权会话、云视觉许可和发送门禁；状态界面展示阶段、错误、次数和耗时。                       |

最新布局超时阶段实际改动涉及：

```text
src/core/ai-client.ts
src/core/siliconflow-client.ts
src/core/wechat/channel-session.ts
src/core/wechat/config.ts
src/core/wechat/desktop-gui.ts
src/core/wechat/diagnostics.ts
src/core/wechat/operation.ts
src/core/wechat/recognition.ts
src/core/wechat/types.ts
src/main/siliconflow-provider.ts
src/main/wechat-vision.ts
src/renderer/src/WechatControls.tsx
src/renderer/src/WechatSettingsPanel.tsx
tests/siliconflow.test.cjs
tests/wechat-desktop.test.cjs
tests/wechat-diagnostics.test.cjs
tests/wechat-layout.test.cjs
tests/wechat-timeout.test.cjs
```

## 6. 计划、实现和验证状态

| 项目               | 旧会话计划                                          | 代码实际实现                        | 当前验证状态                                           |
| ------------------ | --------------------------------------------------- | ----------------------------------- | ------------------------------------------------------ |
| 保护工作树         | 完成备份和哈希清单                                  | 三阶段备份均存在                    | `[PASS]` 已核对路径与清单                              |
| 修复错误模型 ID    | 使用实际启用的 Provider 验证                        | 当前设置为 `Qwen/Qwen3.5-9B`        | `[PASS]` 旧会话用合成白图真实 HTTP 200；本次未重新联网 |
| 分离本地/视觉期限  | 慢视觉不再被 30 秒提前取消                          | 已增加 `visionTimeoutMs` 和阶段预算 | `[PASS]` 当前相关自动化测试通过                        |
| 严格布局结构校验   | HTTP 200/JSON 不等于可点击布局                      | 已提取并复用生产布局解析            | `[PASS]` 合成和 Mock 校验；`[BLOCKED]` 真实微信布局    |
| 完整多模态 Dry-run | DesktopGui → 账本 → HTTP Provider → proposal → 去重 | 集成用例已补齐调度轮次和结构化响应  | `[PASS]` 合成 Desktop/HTTP 闭环及重复帧去重            |
| 安全发送           | 发送前后均有证据和不确定态保护                      | 已实现                              | `[PASS]` 模拟测试；`[BLOCKED]` 真实发送                |
| 多联系人连续运行   | 公平调度且不漏当前会话新消息                        | 已有分页/公平调度                   | `[PASS]` 模拟回归；`[PENDING]` 真实轮询时延验收        |
| 图片高清预览       | 受控打开、识别、关闭                                | 尚未实现，只分析可见裁剪            | `[PENDING]`                                            |
| 真实微信 A-F       | 未读到回复确认的授权闭环                            | 未执行                              | `[BLOCKED]` 缺明确截图云传、指定会话及发送授权         |

## 7. 当前测试基线

2026-10-14 在本工作区重新执行：

| 命令                                                                                                    | 当前结果                                                                                   |
| ------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------ |
| `node --require ./tests/register.cjs --test tests/wechat-layout.test.cjs tests/wechat-desktop.test.cjs` | 26 项全部通过，进程退出 0                                                                  |
| `npm test`                                                                                              | 280 项全部通过，fail/cancelled/skipped/todo 均为 0，进程退出 0                             |
| `npm run typecheck`                                                                                     | `[PASS]` Node/Main 与 Web/Renderer 均通过                                                  |
| `npm run lint`                                                                                          | `[PASS]`                                                                                   |
| `npm run build`                                                                                         | `[PASS]` Main、Preload、Renderer 构建通过；保留 screenshot-utils 静态/动态导入的 Vite 警告 |

旧会话在新增最后一个集成用例之前执行的全量结果为 274/274 通过；恢复检查时曾为 274/275，恢复后先达到 275/275。本轮布局回退新增 5 项覆盖，当前基线为 280/280。

### 已解决的中断点

文件：`tests/wechat-desktop.test.cjs:234`，修正后的主要状态断言约为第 296 行。

```text
production desktop adapter completes multimodal dry-run through the ledger and HTTP reply client; repeated frame never sends

expected: COMPLETED
actual:   SKIPPED
```

恢复后的探针与测试确认，生产调度的单页时序是：

```text
第一次 tick: CHECKING_DUPLICATES -> SKIPPED(initial_baseline)
第二次 tick: SCANNING_UNREAD -> SKIPPED(no_authorized_unread)
```

第一次 tick 后会话 ID 被加入 `scannedOnPage`。第二次扫描按公平调度过滤该会话并清空本页标记；第三次 tick 才重新读取并处理新增图文。这是现有分页公平契约，运行时相关测试也按多个 tick 驱动。

原集成用例还包含第二个潜在失败：HTTP mock 返回裸文本，但生产 `parseNormalizedReply()` 只接受 `{type:"reply_text",text:string}` 或 skip JSON。进入 Provider 后，裸文本会被安全地拒绝为 `PROVIDER_FAILED`。

本轮只修改 `tests/wechat-desktop.test.cjs`：

- 显式断言 `initial_baseline → no_authorized_unread → COMPLETED` 的调度轮次。
- HTTP mock 改为生产协议要求的结构化回复 JSON。
- 再执行一次公平清标和一次账本观察，断言重复帧落到 `no_new_incoming`。
- 断言只发生一次 Provider HTTP 调用，且 Dry-run 没有点击或按键。

生产 `scannedOnPage`、分页公平逻辑、账本和 Provider 安全解析均未放宽或删除。

## 8. 当前安全配置快照

恢复时仅读取非敏感字段，未输出或修改任何密钥：

```text
replyMode: manual-confirm
autoReplyEnabled: true
scanOnly: false
cloudVisionEnabled: true
allowedConversations: 0
debugCapture: true
operationTimeoutMs: 30000
visionTimeoutMs: 未写入旧 settings.json，运行时归一化为默认 90000
providerTimeoutMs: 90000
siliconFlow.model: Qwen/Qwen3.5-9B
```

授权会话数量为 0，因此当前配置即使启动，也不应读取或回复具体联系人。旧会话和本次恢复均未向真实微信联系人点击、输入或发送消息。

## 9. 后续计划与授权边界

1. 当前中断点修复、`VISION_INVALID_BOUNDS` 本地像素回退、全量工程验证和五份微信专项文档同步已完成。
2. 图片高清预览仍未实现；当前只分析聊天区内可见裁剪，后续实现前需要重新审计真实微信的打开/关闭和窗口证据链。
3. 真实微信 A-F 验收仍未执行。读取真实聊天并上传截图到云端模型需要明确截图授权和指定测试会话。
4. 真实人工确认或有限自动发送还需要独立的发送授权、允许的联系人/群、次数上限和停止条件；不能由截图授权推导。

本轮没有点击、输入或发送任何真实微信消息，也没有重新联网调用硅基流动。

## 10. 2026-10-14 `VISION_INVALID_BOUNDS` 修复

用户新附件显示微信主窗口已打开，但布局识别连续三次失败为 `VISION_INVALID_BOUNDS`。最新脱敏诊断确认 prepare 分别在约 6.9 秒、8.9 秒和 16.6 秒返回坐标错误，并非 150 秒视觉阶段预算耗尽。Provider 探针还证明 Qwen3.5 可能返回嵌套联系人行框、单条气泡框或左右区域错误；不能通过合并嵌套框或放宽坐标校验来修复。

代码实际实现：

- `src/core/wechat/recognition.ts` 新增纯函数 `detectLocalWechatLayout()`，从 RGBA 像素检测导航/会话列表竖向分隔、标题底边和编辑区顶边。
- 四条边均要求在限定比例范围内跨绝大多数采样线持续存在，并同时满足最小窗口、列表宽度、聊天面板宽度、消息区高度和编辑区高度约束；任一证据缺失即返回 `undefined`。
- `WechatDesktopGui.prepare()` 只在 `VISION_INVALID_JSON`、`VISION_INVALID_BOUNDS` 或 `LAYOUT_INVALID` 时尝试该回退；`LAYOUT_UNCERTAIN`、非主窗口、低置信度、窗口变化、前台丢失仍按原逻辑拒绝。
- 本地回退整体替换无效 VLM 容器，不读取或合并模型返回的行框；联系人行、标题、消息和编辑框内容仍由后续 VLM 严格识别。缓存来源标记为 `derived`，有效模型布局仍标记为 `vlm`。

用户附件仅在本机做像素分析，没有上传。对其中约 `903×516` 的微信可见区域，检测得到会话列表右边界约 30.9%、标题底边约 13.6%、编辑区顶边约 72.3%，与截图可见分隔一致。该证据证明回退能处理本次截图形态，但不等于 Electron 运行中的真实微信端到端验收。

本轮验证：布局/Desktop 定向 26/26、全量 280/280、typecheck、lint、build 全部通过；构建只保留既有 screenshot-utils 动静态导入提示。没有启动真实联系人扫描，没有云端上传、点击、输入或发送。
