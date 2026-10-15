# Development Log

本文件只记录能够由源码、Git 状态、旧会话 JSONL、备份清单或测试输出确认的事实。计划、代码写入和验证结果分别描述；未执行的真实微信操作不会标记为完成。

## 2026-10-15：回复批次实现完成，速度目标尚未验收

- 基线为用户提交的 `5ec504f`，只修改原始 `dev/tyz`，未写入 `dev/tyz-v2`。备份为 `E:\codex\visualizations\2026\10\14\01a13953-132c-7651-92d4-93ec9b984f6f\reply-batch-backup-20261014-221709`。
- 实现独立 `replyModel`、会话面板裁剪、统一有序消息协议、头像像素证据、发送前追加消息复核和停止取消传播。生成期间新增消息不会吞掉当前答案；发送后保留为下一批。
- 新增结构化性能字段：检测、回复请求、复核、发送前复核、发送和批次总耗时；不记录聊天正文或凭证。提供 `scripts/reply-latency-report.cjs` 统计真实验收数据。
- 自动回归 `npm test` 159/159；typecheck、build、源码 ESLint、Prettier 和 diff check 通过。
- 合成模型比较中 30B 为 30/40、中位 9.789 秒、P95 21.503 秒；8B 为 39/40、中位 9.391 秒、P95 17.384 秒。两种模型均未满足全部速度与正确性门槛，未自动修改回复模型配置。
- 未验证真实微信 30 批次、人工草稿交互的长期稳定性和真实端到端延迟；用户需在专用测试会话验收。

最终验证 159/159，隐藏 Electron smoke 通过；完整报告见 [REPLY_LATENCY_REPORT.md](REPLY_LATENCY_REPORT.md)。速度未达标，未自动切换模型，最后本地校验为离线重放。

## 2026-10-14：修复联系人打开后布局复核阻塞

- 基线已由用户提交为 `7247b3c`（`dev/tyz`），本轮开始工作区干净；`dev/tyz-v2` 仍在独立 Worktree，本轮不写入。
- 自动回复功能仍存在。用户日志的历史框 `[343,171,660,708]` 过窄，而编辑框 `[350,720,840,849]` 更宽；旧右边界 +100 判断触发多余输入框请求，超时后未进入内容识别。
- 在 `src/core/rpa/vision-utils.ts` 调整水平重叠判断和历史区域范围，并明确完整面板提示词。仍保留中心/高度/左边界校验及 `NO_CHAT_INPUT`、过小框和无重叠框的拒绝路径。
- `tests/rpa-position.test.cjs` 增加日志坐标一次请求成功和无重叠拒绝测试；`tests/bootstrap.test.cjs` 增加未读联系人打开后进入生产 Provider 文本/图片解析并发送一次的测试，模型响应与设备发送均为替身。
- 全量 `npm test` 125/125，`npm run build`（前后端类型检查）通过。日志在 `.local/reply-layout-{regression,tests,build}.log`。首次 lint 报测试空方法规则错误，随后修正；最终忽略 `.local/` 的无缓存 ESLint、修改文件 Prettier 检查和 `git diff --check` 均通过。
- 不修改个人密钥、模型设置或发送保护。没有真实云端请求与微信发送；不把测试替身通过视为真实微信端到端验收。

## 2026-10-14：恢复 dev/tyz 到 122 项测试成功节点

- 目标是会话「修复火山方舟 API Key 认证失败」（`01a12eda-344e-7ae3-b778-cf418b30c6c8`）于 2026-10-13 15:21:44（Asia/Shanghai）的最终报告，不是该会话初始状态，也不是 `main` 的原始工作树。
- 先在项目外备份当前全部项目文件（553 项哈希核验）；`.local/` 等被忽略数据已保留，仅排除 `.git`、`node_modules/`、`out/` 和 `.eslintcache`。备份：`E:\codex\visualizations\2026\10\14\01a13953-132c-7651-92d4-93ec9b984f6f\backup-dev-tyz-20261014-153635`。
- 恢复来源为 `8bbc196` Git 树 + 后续会话首轮编辑前的 `.local/repair-backup-20261013-1830`：其 73 文件清单（42 个受跟踪修改、31 个未跟踪）哈希全部有效；目标会话在此之前完成 122/122 测试、构建、类型、lint 和格式检查。没有声称存在最终时刻的单体快照。
- 重建结果 113 个代码文件；25 个当前文件被目标版本替换，33 个后续新增文件移出到备份的 `post-target-files/`。完整替换、移出及保留文档清单在备份的 `restore-plan.json`；`HANDOFF.md` 第 0 节概述其范围。旧消息去重、自身回复拦截、连续消息上下文、Provider 与手动密钥配置被保留，微信专用运行时及其后续测试已移出。
- 项目外重建及原始 `dev/tyz` 各跑 `npm test`：122 通过、0 失败。原始目录的 `npm run build`（含 node/web 类型检查）、Prettier 历史范围检查和 `git diff --check` 通过；`npm run lint` 为 0 错误、1158 条来自保留 `.local/` 的格式警告；忽略 `.local/` 的无缓存 ESLint 通过且无警告。
- 当前分支仍为 `dev/tyz`，HEAD 仍为 `8bbc196`；未修改 `dev/tyz-v2` 工作区。未以真实密钥请求模型，也未实机验证微信扫描、回复和发送；不把历史 122 项结果替代本次复验。

以下记录是本次恢复之前的后续开发历史；其 233 至 280 项测试结果和微信专用模块描述不代表当前代码状态。

## 2026-10-13：初始全面审计与微信专用运行时

### 用户目标

- 审计既有 SightFlow 修改，修复微信多联系人未读识别、多模态消息理解、上下文回复、去重、安全发送和生命周期控制。
- 保留原有工作树，不使用破坏性 Git 操作。
- 交付故障审计、架构、测试、修改清单和 Windows 运行说明。
- 模拟验证和真实微信验证必须分开；未经授权不得真实发送。

### 已确认工作

- 分支保持为 `dev/tyz`，HEAD 为 `8bbc196ac372c9365f732bf8eb9d6fb83b3eb5e3`。
- 修复前工作树有 42 个受跟踪修改、31 个未跟踪文件，保存到 `.local/repair-backup-20261013-1830`，包含副本、SHA-256 清单和 Git patch。
- 审计确认原实现存在会话身份不稳定、内存去重、识别与回复耦合、直接发送和缺少发送后回显等问题。
- 新增微信专用 `WechatChannelSession`、统一消息类型、持久账本、`SafeSender`、脱敏诊断、设置 UI 和相关测试。
- 其他应用继续使用 `GenericChannelSession`；没有整体替换现有架构或引入大型框架。

### 当时验证结果

- 阶段性全量测试曾达到 233/233 通过。
- 当时 typecheck、lint、build 通过。
- 隔离 Electron 启动验证了 Renderer、Preload IPC 和安全默认设置。
- 只读窗口枚举找到一个标题为“微信”的主窗口。
- 真实截图授权超时，因此真实未读、消息理解和发送没有完成。

### 当时未完成

- 真实微信 A-F 端到端验收。
- 高清图片预览。
- 真实 DPI、窗口尺寸、视觉守卫和长期运行调优。

## 2026-10-13：启动后立即结束专项修复

### 用户反馈

用户报告“启动后就运行结束了，经过修改后反而运行不了”。

### 已确认原因

- 实际启用的是硅基流动视觉服务。
- 保存的错误模型 ID 为 `Qwen/Qwen/Qwen3.5-9B`，正确 ID 为 `Qwen/Qwen3.5-9B`。
- 旧连接测试覆盖的是其他 Provider，不能证明当前选中的硅基流动可用。
- 旧错误处理会把 HTTP 错误压缩成 `OPERATION_FAILED`，停止时还可能显示成 `CANCELLED`，丢失真正原因。

### 已写入的修复

- 私有备份用户设置后，只修正模型 ID；没有修改密钥、回复模式或会话授权。
- 增加统一视觉客户端工厂和“测试当前智能体视觉连接”入口。
- 增加固定错误码、失败阶段、次数、停止原因和有限重试策略。
- 终止流程保留原始 FAILED 状态，不再被普通取消覆盖。
- 新增启动、诊断、Provider 隔离和连接测试。

### 当时验证结果

- 错误模型 ID 的真实合成白图请求返回 HTTP 400。
- 正确模型 ID 的同类请求返回 HTTP 200 和有效 JSON。
- 阶段性全量测试达到 251/251 通过；typecheck、lint、build 和隔离 Electron smoke 通过。
- 真实聊天截图上传未获批准，没有点击、输入或发送。

## 2026-10-13 至 2026-10-14：布局识别超时和坐标校验回归

### 用户最新业务反馈

用户表示原先可以运行和正常回复，修改后问题明显扩大，要求认真修正。附件显示：

```text
FAILED · stopped_after_error
OPERATION_TIMEOUT
失败阶段：微信窗口布局识别
第 3/3 次失败，达到上限后停止
```

### 已确认原因

- `operationTimeoutMs=30000`，底层视觉 HTTP 默认期限为 90000。
- 三次真实诊断均在 prepare 约 30 秒时被外层取消，形成连续超时并停止。
- 另一次运行先出现 `VISION_INVALID_BOUNDS`，随后才出现超时或失焦；坐标无效和超时是不同问题。
- 合成界面请求可在约 6 至 7 秒返回，但 Provider 返回的矩形可能漏掉标题或第一条消息，或者左右区域关系不符合微信结构。

### 源码保护

- 修复前建立 `.local/layout-timeout-backup-2026-10-13T15-29-29-934Z`。
- `manifest.json` 保存 22 个相关文件及 SHA-256。
- 当前有 16 个快照内文件存在后续修改；快照本身未改动。

### 已写入的修复

- `WechatSettings` 新增 `visionTimeoutMs`，默认 90000，旧配置缺失时自动归一化。
- `visionPhaseTimeout` 将本地操作预算和视觉请求预算分开计算。
- prepare、scan、read、understand 和发送后多次视觉复核使用视觉阶段预算；本地点击、截图和窗口动作保留较短期限。
- 生产布局解析统一校验完整性、区域顺序、左右关系和坐标范围。
- 增加阶段耗时、期限和失败原因的安全诊断字段及 UI 展示。
- Provider 请求对 Qwen3.5 使用直接 JSON 输出路径，避免把接口成功误判为布局成功。
- 新增和扩展布局、超时、窗口、桌面适配器、Provider 和诊断测试。

### 阶段性验证

- 41 项针对性回归通过，包括慢视觉、卡死截图、暂停取消和发送前复核。
- 新增最终集成用例之前，全量测试为 274/274 通过。
- 一次 typecheck 曾因跨 await 的可选诊断对象 spread 报错；随后增加 `timingEvidence()`，当前 typecheck 已通过。
- lint 通过。
- 合成布局探针证明 HTTP 200/合法 JSON 仍可能是无效微信布局，因此真实布局没有被误报为 PASS。

### 暂停时的精确状态

旧会话最后新增了：

```text
production desktop adapter completes multimodal dry-run through the ledger and HTTP reply client; repeated frame never sends
```

该用例第一次运行即失败：期望 `COMPLETED`，实际为 `SKIPPED`。用户随后要求暂停。没有继续修复，也没有真实发送。

## 2026-10-14：新会话恢复和状态复核

### 会话恢复

- 通过 Codex 会话列表唯一匹配旧会话 ID `01a134cf-1b92-7f72-8a1c-6af769a2582b`。
- 默认 `~/.codex/sessions` 没有本会话；实际记录位于 `E:\codex\sessions\2026\10\13\rollout-2026-10-13T18-29-10-01a134cf-1b92-7f72-8a1c-6af769a2582b.jsonl`。
- 仅分段读取该文件，没有混入其他会话、修改记录或输出敏感凭据。
- 两次“继续”请求分别因 `stream disconnected before completion: response protection is unavailable` 失败，未执行任何后续开发。

### 当前工作区复核

- 当前目录、分支、HEAD、remote 和唯一 worktree 与旧会话一致。
- 恢复检查开始时为 43 个受跟踪修改、64 个未跟踪文件。
- `git diff --check` 没有补丁格式错误，只显示现有 LF/CRLF 转换警告。
- 当前非敏感设置：`manual-confirm`、自动回复开关开启、云视觉开启、授权会话数 0、模型 `Qwen/Qwen3.5-9B`。旧设置未显式保存 `visionTimeoutMs`，代码会归一化为 90000。

### 恢复检查时重新执行的验证

| 检查                | 结果                           |
| ------------------- | ------------------------------ |
| Desktop 定向测试    | 11 项中 10 通过、1 失败        |
| 全量 `npm test`     | 275 项中 274 通过、1 失败      |
| `npm run typecheck` | 通过                           |
| `npm run lint`      | 通过                           |
| `npm run build`     | 通过；保留已知 Vite chunk 警告 |

### 恢复检查时唯一失败的根因证据

只读内存探针记录：

```text
tick 1 -> SKIPPED(initial_baseline)
tick 2 -> SKIPPED(no_authorized_unread)
```

第一次 tick 后，会话 ID 已加入 `scannedOnPage`。第二次扫描过滤该会话，因此没有进入新消息读取、多模态理解或 Provider。下一步需要先明确同一已选会话连续观察与多会话公平调度的契约，再修改代码或测试。

### 恢复阶段结论（修复前）

- `[PASS]` 旧会话修改已写入磁盘；当前 typecheck、lint、build 通过。
- `[FAIL]` 恢复检查时完整测试集不是全绿：275 项中 1 项失败；后续修复结果见下一节。
- `[BLOCKED]` 真实微信布局、真实文本/图片/表情识别和真实发送仍未验证。
- `[PENDING]` 当时仍需调度契约修复、五份 WECHAT 文档同步、高清预览和实机稳定性验收；前两项已在下一阶段完成。

恢复阶段没有修改业务代码。后续工作从 `HANDOFF.md` 第 9 节继续，并在每个阶段更新本日志。

## 2026-10-14：用户确认后的中断点修复

### 调度契约核对

- `tests/wechat-runtime.test.cjs` 的首次基线、重复快照和分页公平场景均以多个 tick 驱动同一会话。
- `WechatChannelSession` 会把已处理会话加入 `scannedOnPage`；当前页没有其他候选时，下一次空扫描清除该集合，再下一次 tick 才重新观察同一会话。
- 因此恢复时的 `SKIPPED(no_authorized_unread)` 是现有公平调度轮次，不是视觉超时、网络错误或 Provider 未调用的生产缺陷。

### 新发现的测试夹具问题

- 补齐调度 tick 后，用例首次真正进入生产 SiliconFlow Provider，随后安全失败为 `PROVIDER_FAILED`。
- 原因是 HTTP mock 返回裸文本 `这只猫很可爱😂`，但生产 `parseNormalizedReply()` 明确只接受结构化 JSON 回复或 skip；裸文本被拒绝符合安全设计。

### 实际修改

- 仅修改 `tests/wechat-desktop.test.cjs`，没有修改生产调度、账本、Provider 或发送代码。
- 用例现在显式覆盖 `initial_baseline → no_authorized_unread → COMPLETED`。
- HTTP mock 返回 `{type:"reply_text",text:string}` JSON 字符串，符合生产协议。
- 完成后再经过公平清标和账本观察，断言重复帧为 `no_new_incoming`、Provider HTTP 请求仍只有一次，且 Dry-run 没有点击或按键。

### 验证结果

| 检查                                                                       | 结果                                                                |
| -------------------------------------------------------------------------- | ------------------------------------------------------------------- |
| Desktop 单用例                                                             | 1/1 通过                                                            |
| `node --require ./tests/register.cjs --test tests/wechat-desktop.test.cjs` | 11/11 通过                                                          |
| `npm test`                                                                 | 275/275 通过；fail/cancelled/skipped/todo 均为 0                    |
| `npm run typecheck`                                                        | 通过                                                                |
| `npm run lint`                                                             | 通过                                                                |
| `npm run build`                                                            | 通过；保留既有 screenshot-utils 同时静态/动态导入的 Vite chunk 警告 |

### 当前边界

- `[PASS]` 中断时唯一自动化失败已解决，完整自动化基线恢复为 275/275。
- `[PASS]` 五份 `docs/WECHAT_*.md` 和 `HANDOFF.md` 已同步当前结论。
- `[BLOCKED]` 真实微信布局、真实文本/图片/表情识别和真实发送仍未授权执行。
- `[PENDING]` 图片高清预览和实机轮询时延调优仍未完成。

本阶段没有读取或上传真实聊天截图，没有点击、输入或发送真实微信消息，也没有重新联网调用硅基流动。

## 2026-10-14：`VISION_INVALID_BOUNDS` 本地布局回退

### 用户复现与诊断

- 新附件中微信主窗口可见，SightFlow 在“微信窗口布局识别”阶段连续报告 `VISION_INVALID_BOUNDS`。
- 最新脱敏运行记录中，prepare 在约 6.9 秒、8.9 秒和 16.6 秒返回该错误；视觉阶段预算为 150 秒，因此本次不是超时复发。
- 已有真实 Provider 合成探针显示 Qwen3.5 会把 `contactList` 返回为多个嵌套行框、把 `history` 缩成单个气泡或交换左右区域。直接合并、裁平或放宽校验会扩大误点风险。

### 实际修改

- 在 `src/core/wechat/recognition.ts` 增加纯函数 `detectLocalWechatLayout()`。
- 检测器只接收本地 RGBA 像素，要求在固定比例区间内同时找到导航/列表、列表/聊天面板两条纵向持续边缘，以及标题/消息、消息/编辑区两条横向持续边缘。
- 增加窗口最小尺寸、列表宽度、聊天面板宽度、消息区高度和编辑区高度约束；证据不足返回 `undefined`。
- 在 `src/core/wechat/desktop-gui.ts` 的 `prepare()` 中，仅对 `VISION_INVALID_JSON`、`VISION_INVALID_BOUNDS`、`LAYOUT_INVALID` 使用本地回退。
- `LAYOUT_UNCERTAIN`、模型明确非主窗口、窗口/前台变化继续拒绝；本地回退不会合并模型嵌套行框，也不会直接产生联系人点击行。
- 有效 VLM 布局缓存来源保持 `vlm`；本地结构结果标记为 `derived`。

### 测试与本地附件验证

- `tests/wechat-layout.test.cjs` 增加 `938×530` 微信结构恢复和无分隔线 fail-closed 用例。
- `tests/wechat-desktop.test.cjs` 增加有效 VLM 保持优先、嵌套坐标经完整结构恢复、低置信度/非主窗口不回退等用例。
- 用户附件只在本机读取。对约 `903×516` 的微信可见区域，检测结果为 `contactList=[43,136,309,1000]`、`history=[309,136,1000,723]`、`editor=[309,723,1000,1000]`，与可见分隔一致；没有上传附件或聊天内容。

| 检查                  | 结果                                             |
| --------------------- | ------------------------------------------------ |
| 布局/Desktop 定向测试 | 26/26 通过                                       |
| `npm test`            | 280/280 通过，fail/cancelled/skipped/todo 均为 0 |
| `npm run typecheck`   | 通过                                             |
| `npm run lint`        | 通过                                             |
| `npm run build`       | 通过；保留既有 screenshot-utils 动静态导入提示   |

### 尚未验证

- 没有在本轮启动真实微信扫描或重新请求硅基流动，因此真实联系人行、标题、消息内容及长期稳定性仍未实机验证。
- 没有点击、输入或发送；发送安全门禁只由既有自动化回归确认。
- 若真实主题或未来微信版本缺少四条持续分隔边缘，回退会继续 fail closed，需要基于新的脱敏证据调整，而不是降低阈值猜测。
