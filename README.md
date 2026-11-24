# Codex Controller · dsh-plugin-codex-controller

A **Codex control plane as a DeepSeek Harness (dsh) plugin**: draft a prompt → type it into a Codex thread → read the output → watch live progress. Available both as agent tools and as a **Codex 控制器** panel in the web GUI.

Transport is the official Codex CLI `app-server` JSON-RPC (`codex app-server --listen stdio://`) — the same protocol the official VS Code extension and Codex desktop app speak. No TUI screen-scraping, no hand-rolled requests against undocumented endpoints.

## Existing work (checked first)

Codex controllers exist, but none ships as a dsh plugin: [`@redonvn/codex-controller-mcp`](https://www.npmjs.com/package/@redonvn/codex-controller-mcp) (MCP server: spawn/observe/tail threads), `codexctl` (standalone CLI control plane), [`denysvitali/codex-mcp`](https://github.com/denysvitali/codex-mcp), [`codexloop`](https://github.com/kunkunzhishan/codexloop) / [`codex-autorunner`](https://github.com/Git-on-my-level/codex-autorunner) (task loops). OpenAI itself ships `codex exec --json`, `codex queue`, `codex mcp`, and `@openai/codex-sdk`. This plugin is the dsh-native composite: prompt drafting + dialog input + output reading + progress monitoring, in one bundle.

## Tools

| Tool | Purpose |
| --- | --- |
| `codex_prompt` | Loose task → executable prompt (goal / must / constraints / deliverables / acceptance / non-goals / plan-first protocol). Deterministic, no model call. |
| `codex_open` | Open a Codex thread (app-server session) bound to cwd, model, sandbox, approval policy. |
| `codex_send` | Type into the thread: raw `text`, or a `spec` the plugin drafts for you. `waitMs>0` blocks until the turn settles and returns progress. |
| `codex_status` | Live progress: status, current item, plan checklist, tokens, elapsed, counters, last reply, command output, errors. |
| `codex_read` | Incremental event log (`since=lastSeq`): agent text, commands with exit codes, file edits, plan updates, usage, errors. |
| `codex_interrupt` | Interrupt the running turn (Esc equivalent); thread stays open. |
| `codex_sessions` | List / close sessions. |
| `codex_doctor` | **Upgrade self-check**: CLI version, app-server method surface (compared against the CLI's own generated schema), `exec --json` / `exec resume` availability, active transport, and what to do. |

Client surfaces: `settings.section → Codex 控制器` (sessions, progress, event log, prompt drafter, composer) and `conversation.composer.dock` (status pill).

## Install

```powershell
New-Item -ItemType Junction `
  -Path  "$env:USERPROFILE\.dsh\profiles\desktop\node_modules\dsh-plugin-codex-controller" `
  -Target "<repo>\codex-controller-dev"
# profile package.json: dependencies += "dsh-plugin-codex-controller": "link:<repo>/codex-controller-dev"
#                       dsh.profile.bundles += "dsh-plugin-codex-controller"
# then restart the DSH desktop app (host half is not hot-reloaded)
```

Options (`cordis.patch.yml` config): `codexBin`, `defaultCwd`, `model`, `sandbox` (`read-only|workspace-write|danger-full-access`), `approvalPolicy` (`untrusted|on-request|never`), `autoApprove`, `eventLimit`, `waitCapMs`, `transport` (`auto|app-server|exec`).

## Surviving updates

`transport: auto` prefers app-server and degrades to one-shot `codex exec --json` turns when the (experimental) app-server surface moves — a Codex update costs streaming/plan/approvals, not the plugin. Run the self-check after any upgrade: panel button, `codex_doctor`, or `node dev\compat-test.mjs doctor`; it compares the CLI's own generated JSON schema against the methods the plugin calls and reports `missingMethods` plus the fix. On the harness side the plugin only touches `defineTool`, `ctx.tools.register`, `ctx.webServer.register`, `ctx.effect`, `ctx.slots`; if a dsh update tightens parameter schemas the activation error names the offending line in `lib/index.js`. If an update rebuilds the profile, re-run the idempotent `install.ps1` (`-Restore` to roll back). Playbook: [UPGRADE.md](<C:\Users\a1785\Documents\deepseek-harness\default-workspace\codex-controller-dev\UPGRADE.md>).

## Verified on this machine

* handshake → `thread/start` (model `gpt-6.1-sol`) → `turn/start` → reply `PONG`, 17k tokens;
* `commandExecution` + `commandOutput` captured (`echo CONTROLLER_OK` → `CONTROLLER_OK`) then `DONE`;
* full HTTP chain in a real dsh host (separate profile on :32199): `open` → `send` → `state` (`running/inProgress`, tokens rising) → `events` → `idle/completed` with reply `PANEL_DONE`;
* client bundle registered in the served client-modules list; loader contract and slot registrations checked with a stub loader;
* transient WebSocket drop self-healed (retry 2/5…5/5), tracked as `retries` instead of a hard error.

## Account-risk assessment

**Low, and it does not come from automating Codex** — it comes from account-level usage.

- The plugin drives an officially supported surface: `app-server` is a shipped subcommand and the protocol behind the official IDE extension; `codex exec --json`, `codex queue`, `codex mcp` and `@openai/codex-sdk` exist precisely for programmatic use. The plugin reports its own `ClientInfo` instead of impersonating the official client.
- Auth stays with the official binary: no reads/writes of `~/.codex/auth.json`, no token refresh logic, no credentials leaving the machine.
- Traffic shape stays normal: one app-server, serialized turns, no auto-retry storms.

Risk goes **up** with: sharing/rotating one subscription across machines or people, batch-registering accounts, treating subscription quota as an API pool (dozens of parallel sessions 24/7), patching the binary to evade checks, or automating account-level abuse. Mitigations baked in: **serial turns, no auto-retry, surface failures to the operator**, and keep `sandbox`/`approvalPolicy` sane (`read-only` for unfamiliar repos, `workspace-write` for edits, leave `autoApprove:false` when you want to see approvals).

## Limits

`app-server` is marked `[experimental]`; unknown notifications are tolerated (`kind: other`) rather than fatal. The client half is a hand-written prebuilt bundle. Events live in an in-memory ring buffer (`eventLimit`); full transcripts remain in `~/.codex/sessions`. Sessions do not survive a DSH restart — reopen a thread, or resume the `threadId` with `codex resume`.
