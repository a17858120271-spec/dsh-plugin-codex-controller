# 更新之后怎么办（Codex 升级 / Harness 升级）

先记住一句：**这个插件按"能力探测"写，不按"版本号"写。** 传输层优先 app-server，坏了自动降级 `codex exec --json`；事件字段是防御式提取；未知通知只记 `kind: other`。所以小版本升级通常什么都不用做，升级后跑一次自检就知道。

## 0. 自检（三选一，等价）

```powershell
# a) 面板：设置 → Codex 控制器 → 自检
# b) 工具：codex_doctor { probe: true }
# c) 命令行（不需要 DSH 在跑）：
node dev\compat-test.mjs doctor
```

输出解读：

| 字段 | 含义 | 不正常时 |
| --- | --- | --- |
| `codex.version` | 实际跑起来的 CLI 版本 | 空 = 二进制没了/换路径了 → 设 `codexBin` |
| `appServer` | 该版本还有没有 `app-server` 子命令 | false 且 `execJson: true` → 已降级，功能受限但可用 |
| `generateSchema` + `missingMethods` | 用 CLI 自己生成的 JSON Schema 对齐本插件依赖的方法/通知 | 有缺失 → 见下面「恢复 app-server」 |
| `execJson` | `codex exec --json` 还在不在 | false → 锁回旧版本（见「回滚」） |
| `execResume` | `codex exec resume <id>` 还在不在 | false → 多轮续接失效，每轮都是新线程 |
| `plugin.mode` | 当前真正用的传输 | `exec` = 走降级路径 |
| `plugin.transportError` | 降级原因（app-server 起不来 / 方法报错） | 这就是要修的点 |

## 1. Codex 升级后

**大概率：直接能用。** app-server 是实验性子命令，改动多为新增字段/通知，本插件对新增内容不敏感。

**少数情况会缺方法或参数改名**，表现是自检里 `missingMethods` 非空，或发送时报 `turn/start failed: ...`。此时：

1. 插件已经自动降级 exec（`codex_open` 走单轮，`codex_send` 每轮一个子进程，靠 `exec resume` 续接线程）。**流式输出、计划清单、审批交互会没有**，其他照旧。
2. 恢复 app-server 全功能：
   ```powershell
   # 用新版本自己的 schema 看真实协议
   codex app-server generate-json-schema --out .\schema-new
   # 比对插件依赖的方法
   node -e "const s=require('fs').readFileSync('schema-new/codex_app_server_protocol.schemas.json','utf8'); for (const m of (await import('./lib/controller.js')).REQUIRED_METHODS) if(!s.includes('\"'+m+'\"')) console.log('MISSING', m)"
   ```
   改 `lib/controller.js` 里对应调用点（`REQUIRED_METHODS` / `#onNotification` 的 case / `sendTurn` 的参数），重跑 `node dev\compat-test.mjs auto`。
3. **回滚最快**：
   ```powershell
   npm i -g @openai/codex@0.167.0      # 换成本机已知可用版本
   node dev\compat-test.mjs doctor
   ```
4. **想锁版本**：`npm i -g @openai/codex@<ver>` 之后，把 `codex update` 自动更新关掉（`codex --help` 里的 `update` 子命令默认不会自己跑，但桌面端会提示更新），或者用 `config.codexBin` 指向一个固定目录里的旧二进制。

## 2. Harness（DSH）升级后

DSH 插件契约里，本插件只依赖这几样：`defineTool`（`@deepseek-ai/dsh-tools`）、`ctx.tools.register`、`ctx.webServer.register({kind:'prefix',path,handler})`、`ctx.effect(fn,label)`、客户端 `ctx.slots.inject/register` + `window.__ModuleLoader__.load`。

升级后先看 DSH 启动日志有没有这行：

```
codex-controller loaded: codex bin = ... (sandbox=..., approval=..., transport=auto)
```

| 症状 | 原因 | 处理 |
| --- | --- | --- |
| 启动日志 `1 entry did not activate` + `JsonSchemaError: parameters.X ...` | 新版收紧了工具参数 schema（本插件已经踩过一次：`additionalProperties` 必须显式） | 按报错指到 `lib/index.js` 的参数声明补 `additionalProperties` / 类型 |
| 面板不出现，但日志里有 loaded | 客户端 slot 名变了或 bundle 没被服务 | 看 boot HTML 的 client-modules 列表有没有 `dsh-plugin-codex-controller/client.js`；没有就是 profile 的 `bundles` 丢了 |
| 面板在，点击 404 | `webServer.register` 契约变了 | 对照 `dsh-plugin-save-token/lib/index.js` 的最新写法改路由注册 |
| `/api/state` 通了但没 session | 工具没注册（`tools.register` 改名/签名变化） | 对照最新 `@deepseek-ai/dsh-tools` 的 `defineTool` 参数 |
| profile 被重建 / `dsh plugin install` 后插件消失 | 升级可能重建 profile | 重跑 `.\install.ps1`（幂等），或 `.\install.ps1 -Restore` 清理后重装 |

**回滚**：desktop profile 的 `package.json`、`cordis.patch.yml` 在安装时备份为 `*.bak-codex-controller`；把备份盖回去 + 删掉 `node_modules\dsh-plugin-codex-controller` 这条 junction，即回到安装前状态。

## 3. 日常建议

- **升级前**：`node dev\compat-test.mjs doctor` 存一份基线输出（版本 + methods 数量）。
- **升级后**：同一个命令再跑一次，比较 `missingMethods` 与 `plugin.mode`。
- **CI/批量**：把 `doctor` 的 `ok` 当健康探针，`/codex-controller/api/doctor` 是同一份 JSON。
- **不要**让插件自己去猜新协议：协议变了就改调用点，猜只会更难查。
- 沙箱/审批这两项是**行为契约**，跟版本无关：不熟悉的仓库用 `read-only`，改文件用 `workspace-write`，`autoApprove` 只在信任目录开。
