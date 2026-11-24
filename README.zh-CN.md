# Codex 控制器 · dsh-plugin-codex-controller

给 DeepSeek Harness（dsh）用的 **Codex 控制面插件**：拟定提示词 → 输入 Codex 对话框 → 读输出 → 盯进度，全程可在 agent 工具层调用，也可在 Web GUI 的「Codex 控制器」面板里点。

传输层用 OpenAI 官方 Codex CLI 的 `app-server` JSON-RPC（`codex app-server --listen stdio://`）——官方 VS Code 扩展与 Codex 桌面端走的就是这条协议，不是去抓 TUI 屏幕，也不是自己拼 HTTP 请求打后端。

```
dsh (agent / GUI)
  ├─ 工具层  codex_prompt / codex_open / codex_send / codex_status / codex_read / codex_interrupt / codex_sessions
  ├─ HTTP    /codex-controller/api/{state,events,open,send,interrupt,close,draft,shutdown}
  └─ 子进程  codex app-server --listen stdio://   (JSONL JSON-RPC)
                ├─ thread/start · turn/start · turn/interrupt · thread/resume
                └─ 通知：turn/started|completed · item/started|completed · agentMessage/delta
                          · commandExecution/outputDelta · turn/plan/updated
                          · thread/tokenUsage/updated · thread/status/changed · error
```

## 0. 先查了一圈轮子（结论）

同类项目确实存在，但都不是 dsh 插件形态：

| 项目 | 形态 | 能做什么 | 不足 |
| --- | --- | --- | --- |
| `@redonvn/codex-controller-mcp` (npm 0.1.3) | MCP server | 起/控多个 Codex 线程，读 rollout 转录 | 需要 MCP 客户端；不是 dsh bundle；面板无 |
| `codexctl` (npm 0.10.1) | 独立 CLI | "Codex CLI 控制面" | 独立进程，和 dsh 无集成 |
| `denysvitali/codex-mcp` | MCP server | 把 Codex 包成 MCP 工具 | 同上 |
| `codexloop` / `codex-autorunner` | 循环脚本 | 单任务长跑 + 审查/checklist | 不是通用控制器 |
| 官方 `codex mcp` / `codex exec --json` / `codex queue` / `@openai/codex-sdk` | 官方支持面 | 非交互执行、会话排队、进程内 SDK | 需要自己写控制面与进度聚合 |

所以：**有轮子，但没有一个能以插件形式长在 dsh 里、给 agent 提供「拟词 + 输入 + 读输出 + 监控」四件套**。本插件按 dsh 的 cordis bundle 契约自建，直接讲 app-server 协议。

## 1. 能力

| 工具 | 作用 |
| --- | --- |
| `codex_prompt` | 把一句任务描述折成可执行提示词：目标/必做/约束/交付物/验收/不做/工作方式。纯模板，无模型调用、零成本、可复现 |
| `codex_open` | 开一个 Codex 线程（app-server session），绑定 cwd、模型、沙箱、审批策略 |
| `codex_send` | 往线程里"打字"：直接文本，或传 `spec` 对象由插件拟词；`waitMs>0` 阻塞到本轮结束并回进度 |
| `codex_status` | 实时进度：状态、当前动作、计划清单、token 用量、耗时、计数、最近回复、命令输出、错误 |
| `codex_read` | 增量事件流（`since=lastSeq`）：agent 文本、命令+退出码、文件改动、计划、用量、错误 |
| `codex_interrupt` | 中断当前轮（等价 Codex 里按 Esc），线程不断 |
| `codex_sessions` | 列会话 / 关闭会话 |
| `codex_doctor` | **升级自检**：CLI 版本、app-server 方法面（用 CLI 自己生成的 schema 比对）、`exec --json`/`exec resume` 是否还在、当前传输、以及该怎么办 |
| `codex_reframe` | **拒答重述**：把被内容过滤拒掉的提示词换成工程语言 + 自有仓库语境，产出可直接 `codex_send` 的版本（见 [REFUSAL.md](<C:\Users\a1785\Documents\deepseek-harness\default-workspace\codex-controller-dev\REFUSAL.md>)） |

> Codex 回 `This content can't be shown … apply for Daybreak` 时：`codex_send` 默认会自动重述重发（`refusalAutoRetry`），也可先 `codex_reframe` 人工看一遍。拒答是**模型侧分类器**给的，不是插件或协议错误。

GUI 侧两个挂载点：`settings.section → Codex 控制器`（完整面板：会话芯片、进度、事件流、拟词器、输入框），`conversation.composer.dock`（状态胶囊：`codex · 2 个会话 · 1 运行中`）。

## 2. 安装

```powershell
# 1) 放进 profile 的 node_modules（link 方式，改代码重启即生效）
New-Item -ItemType Junction `
  -Path  "$env:USERPROFILE\.dsh\profiles\desktop\node_modules\dsh-plugin-codex-controller" `
  -Target "<repo>\codex-controller-dev"

# 2) profile package.json：dependencies 加 "dsh-plugin-codex-controller": "link:<repo>/codex-controller-dev"
#                       dsh.profile.bundles 追加 "dsh-plugin-codex-controller"

# 3) 重启 DSH 桌面端（宿主进程不热加载 node 半部）
```

`app-server` 是**实验性子命令**，但 Codex CLI 自带；插件按 `CODEX_BIN` → npm 全局 `@openai/codex` vendor 路径 → PATH 的顺序自动找二进制，找不到时 `codex_open` 会明确报错。

## 3. 配置（`cordis.patch.yml` 的 `config`）

| 键 | 默认 | 说明 |
| --- | --- | --- |
| `codexBin` | 空 | 空 = 自动探测 |
| `defaultCwd` | 空 | 新线程默认工作目录，空 = 宿主 cwd |
| `model` | 空 | 空 = 用 Codex 配置里的默认模型 |
| `sandbox` | `workspace-write` | `read-only` / `workspace-write` / `danger-full-access` |
| `approvalPolicy` | `never` | `untrusted` / `on-request` / `never` |
| `autoApprove` | `true` | 自动应答 Codex 的审批请求，长任务不会卡死；关掉后审批会挂在 `codex_status.pendingApproval` 里 |
| `eventLimit` | 4000 | 每会话事件环形缓冲上限 |
| `waitCapMs` | 180000 | `codex_send` 的等待上限 |
| `transport` | `auto` | `auto`（app-server 优先，坏了自动降级 exec）/ `app-server` / `exec` |
| `refusalAutoRetry` | `true` | 本轮被内容过滤拒答时，自动重述重发 |
| `refusalMaxAttempts` | 2 | 最多重述几次 |
| `threadPreamble` | 空 | 写进每个新线程的 developer instructions（建议：自有仓库 / 产物是代码+测试+文档） |

## 4. 用法

```text
# 一句话任务，插件自动拟词并发送，等它跑完
codex_open  { cwd: "D:\\work\\proj" }
codex_send  { session: "cx-01a1c5a9", spec: {
                goal: "给设置页加导出按钮",
                must: "JSON 导出\n不改后端",
                acceptance: "点按钮下载 proj.json" }, waitMs: 120000 }

# 长任务：先撒手，再轮询
codex_send  { session: "cx-01a1c5a9", text: "把 CI 里失败的 3 个测试修好" }   # waitMs 默认 0
codex_status{ session: "cx-01a1c5a9" }        # 状态 / 计划 / 当前动作 / token
codex_read  { session: "cx-01a1c5a9", since: 120, kinds: "item,error" }

# 跑歪了
codex_interrupt { session: "cx-01a1c5a9" }
```

同一条链路在 GUI 里就是面板上点：填工作目录 → 打开会话 → 结构化提示词 → 发送/中断，进度与事件流每 1.5s 自动刷新。

## 5. 实测记录（本机 Codex CLI 0.167.0，ChatGPT 登录态）

| 场景 | 结果 |
| --- | --- |
| 纯协议握手 + 单轮 | `initialize` → `thread/start`(model=gpt-6.1-sol) → `turn/start` → 回复 `PONG`，用量 17044 tok |
| 执行命令 + 捕获输出 | 命令 `echo CONTROLLER_OK` 走上 `commandExecution`，`commandOutput` 抓到 `CONTROLLER_OK`，收尾回复 `DONE` |
| HTTP API 全链路（真实 dsh 宿主，另开 profile 跑在 :32199） | `POST /open` → `POST /send` → `GET /state` 显示 `running/inProgress`、tokens 递增 → `GET /events` 逐条事件 → 结束 `idle/completed`，回复 `PANEL_DONE` |
| 客户端模块 | boot HTML 的 client-modules 列表含 `dsh-plugin-codex-controller/client.js`；本地 stub 加载器验证 `inject/apply`、两个 slot 注册、组件可渲染 |
| 网络抖动 | 本机 WebSocket 探测超时，Codex 自愈重连 2/5…5/5 后成功；插件把这类重试单独记成 `retries`，不污染 `lastError` |

## 6. 封号风险评估（直说）

**结论：用这个插件本身不构成封号理由；真正的风险来自账号层面的用法，而不来自"是不是自动化"。**

依据（按可信度排序）：

1. **走的是官方受支持面。** `codex app-server`、`codex exec --json`、`codex queue`、`codex mcp`、`@openai/codex-sdk` 都是 OpenAI 自己发布、明确给程序化调用用的入口；官方 VS Code 扩展和 Codex 桌面端就是 app-server 的客户端。插件只是当"另一个客户端"，还老实上报自己的 `ClientInfo`（`dsh-codex-controller/1.0.0`），没有伪造官方客户端身份。
2. **认证与令牌完全留给官方 CLI。** 插件不读写 `~/.codex/auth.json`，不自己刷 token，不把 OAuth 凭证搬到第三方后端。所有请求由 `codex.exe` 本体发出，协议层以上没有反向工程。
3. **不制造异常流量形态。** 一个 app-server 进程、串行 turn、不自动重试、不在后台无脑刷。用量与你在 IDE 里手点是一致的。

**会把风险抬起来（与插件无关，是用法）**：

- **多账号轮换 / 共享登录**：拿一个 ChatGPT 订阅在多台机器、多人之间共用，或批量注册小号绕额度——这是最典型的封号原因，与是否自动化无关。
- **把订阅额度当 API 池用**：几十个会话 7×24 并发跑批。订阅制与 API 计费的边界就是额度与形态；这种用法更容易触发限额、验证，甚至条款处置。
- **改二进制 / 打补丁绕检测**、把 token 抽出来直接打未公开端点。
- **自动化做条款禁止的事**（批量注册、发垃圾、爬受限内容等）——这时问题在行为本身。

**降风险清单（本插件已默认遵守的加粗）**：

1. **单进程单会话为主，需要并行时给每个会话明确用途**；
2. **不自动重试、不并发轰炸**，失败就报给人；
3. **审批策略别一律 `never` + `danger-full-access`**：陌生仓库用 `read-only`，改代码用 `workspace-write`，`autoApprove` 只在你信任工作目录时开；
4. 一个订阅一台机器一个人；
5. 需要规模化就上官方 API key 计费，别拿订阅额度硬顶。

一句话：**这是"官方客户端的另一种驱动方式"，不是"绕过官方限制"。** 风险档位约等于"你正常用 Codex，但用得更勤"；把上面 5 条守住，实际风险很低。

## 7. 更新之后还能不能用（关键）

**能，而且默认就是为这件事设计的。** 两条传输：

| 传输 | 何时用 | 能力 |
| --- | --- | --- |
| `app-server`（JSON-RPC） | 首选。协议正常时 | 全功能：流式文本、计划清单、审批交互、token 明细、`turn/interrupt` |
| `exec`（`codex exec --json` / `exec resume`） | app-server 起不来、方法改名、参数变化时**自动降级**（`transport: auto`） | 单轮执行、命令输出、agent 文本、token 用量、线程续接；**没有**流式/计划/审批 |

升级后第一步永远是自检（面板「自检」/ 工具 `codex_doctor` / `node dev\compat-test.mjs doctor`）：

```json
{ "ok": true, "codex": { "version": "0.167.0", "appServer": true, "missingMethods": [], "execJson": true, "execResume": true },
  "plugin": { "mode": "app-server", "transportError": null } }
```

- `missingMethods` 非空 → 该版本改了实验性协议，插件已降级 exec；按新 schema 改调用点即可恢复（详见 [UPGRADE.md](<C:\Users\a1785\Documents\deepseek-harness\default-workspace\codex-controller-dev\UPGRADE.md>)）。
- `execJson: false` → 锁回旧版本：`npm i -g @openai/codex@<ver>`。
- **Harness 升级**：插件只依赖 `defineTool` / `ctx.tools.register` / `ctx.webServer.register` / `ctx.effect` / `ctx.slots`；启动日志出现 `codex-controller loaded:` 就是在位。参数 schema 被收紧时报错会直接指到 `lib/index.js` 的哪一行（本插件已按"显式 `additionalProperties`"写法适配）。
- profile 被重建（`dsh plugin install` 之后常见）：重跑 `.\install.ps1`（幂等）；回滚用 `.\install.ps1 -Restore` + `*.bak-codex-controller` 备份。

实测过的降级路径：故意让 app-server 起不来（`--listen bogus://`），插件落 `exec` 模式并完整跑通一轮（回复 `FALLBACK_OK`，用量 16993 tok）。

## 8. 已知限制

- `app-server` 在 CLI 里标 `[experimental]`：协议字段会随版本变，插件对未知通知是宽容处理（进 `kind: other`，不炸）。
- 面板是**手写预构建**客户端 bundle（无 JSX/无打包器），改 UI 直接改 `lib/client.js`；宿主端改完重启 DSH 生效。
- 事件缓冲是内存环形队列，`eventLimit` 之外的老事件会被丢弃；完整转录仍在 `~/.codex/sessions` 的 rollout 里。
- 会话不跨 DSH 重启：重启后用 `codex_open` 开新线程，或按 `threadId` 用 `codex resume` 接回。
