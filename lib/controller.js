/*!
 * codex-controller — Codex app-server driver (transport + session state).
 *
 * Pure Node ESM, zero dependencies. Speaks the Codex CLI `app-server` JSON-RPC
 * protocol (newline-delimited JSON on stdio) — the same protocol the official
 * VS Code extension and the Codex desktop app use, which is why it is the most
 * stable automation surface available:
 *
 *   client -> server requests : initialize, thread/start, turn/start,
 *                               turn/interrupt, thread/read, thread/list
 *   server -> client notifs   : turn/started, turn/completed, item/started,
 *                               item/completed, item/agentMessage/delta,
 *                               item/commandExecution/outputDelta,
 *                               turn/plan/updated, thread/tokenUsage/updated,
 *                               thread/status/changed, error
 *   server -> client requests : *Approval (answered by the controller)
 */

import { spawn } from 'node:child_process'
import { EventEmitter } from 'node:events'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import readline from 'node:readline'
import { isRefusal } from './prompt.js'

export const SANDBOX_MODES = ['read-only', 'workspace-write', 'danger-full-access']
export const APPROVAL_POLICIES = ['untrusted', 'on-request', 'never']

const DEFAULT_TIMEOUTS = { request: 30000, init: 60000, turn: 0 }

/** Locate the codex binary without relying on PATH-only shims. */
export function resolveCodexBin(explicit) {
  const candidates = []
  if (explicit) candidates.push(explicit)
  if (process.env.CODEX_BIN) candidates.push(process.env.CODEX_BIN)
  if (process.platform === 'win32') {
    const npmPrefix = process.env.APPDATA ? path.join(process.env.APPDATA, 'npm') : ''
    const roots = [
      npmPrefix && path.join(npmPrefix, 'node_modules', '@openai', 'codex', 'node_modules', '@openai'),
      npmPrefix && path.join(npmPrefix, 'node_modules', '@openai', 'codex')
    ].filter(Boolean)
    for (const root of roots) {
      const vendor = path.join(root, 'codex-win32-x64', 'vendor', 'x86_64-pc-windows-msvc', 'bin', 'codex.exe')
      candidates.push(vendor)
    }
    candidates.push(path.join(npmPrefix || 'C:\\Program Files\\nodejs', 'codex.cmd'))
    candidates.push('codex.cmd', 'codex.exe')
  } else {
    candidates.push('/usr/local/bin/codex', '/opt/homebrew/bin/codex', path.join(os.homedir(), '.local', 'bin', 'codex'), 'codex')
  }
  for (const c of candidates) {
    if (!c) continue
    try {
      if (path.isAbsolute(c)) {
        if (fs.existsSync(c)) return c
      } else {
        // relative / bare name: trust spawn resolution
        return c
      }
    } catch { /* keep trying */ }
  }
  return 'codex'
}

function num(v) { return typeof v === 'number' && Number.isFinite(v) ? v : 0 }

function clip(s, n) {
  const str = typeof s === 'string' ? s : s === undefined || s === null ? '' : String(s)
  return str.length > n ? str.slice(0, n) + `…(+${str.length - n})` : str
}

/** Depth-first hunt for token counters inside an arbitrary usage object.
 *  Normalizes the exec transport's snake_case counters to the app-server
 *  camelCase shape so panels/tools read one vocabulary. */
function harvestUsage(node, out, depth = 0) {
  if (!node || typeof node !== 'object' || depth > 6) return out
  for (const [k, v] of Object.entries(node)) {
    if (typeof v === 'number' && /token/i.test(k)) {
      const key = /_tokens$/.test(k) ? k.replace(/_([a-z])/g, (_m, c) => c.toUpperCase()) : k
      out[key] = Math.max(out[key] || 0, v)
    } else if (v && typeof v === 'object') harvestUsage(v, out, depth + 1)
  }
  if (!out.totalTokens && (out.inputTokens || out.outputTokens)) out.totalTokens = (out.inputTokens || 0) + (out.outputTokens || 0)
  return out
}

let SEQ = 0

export class CodexController extends EventEmitter {
  constructor(options = {}) {
    super()
    this.opts = {
      codexBin: options.codexBin || resolveCodexBin(),
      cwd: options.cwd || process.cwd(),
      model: options.model || null,
      approvalPolicy: options.approvalPolicy || 'never',
      sandbox: options.sandbox || 'workspace-write',
      autoApprove: options.autoApprove !== false,
      extraArgs: Array.isArray(options.extraArgs) ? options.extraArgs : [],
      clientName: options.clientName || 'dsh-codex-controller',
      clientVersion: options.clientVersion || '1.0.0',
      env: options.env || process.env,
      eventLimit: options.eventLimit || 4000,
      // 'auto'   — app-server first, fall back to `codex exec --json` if the
      //            (experimental) app-server surface changed or is missing;
      // 'app-server' / 'exec' — pin one transport.
      transport: options.transport || 'auto',
      timeouts: { ...DEFAULT_TIMEOUTS, ...(options.timeouts || {}) }
    }
    this.child = null
    this.rl = null
    this.pending = new Map()
    this.nextId = 1
    this.ready = false
    this.mode = null
    this.transportError = null
    this.starting = null
    this.stderrTail = []
    this.sessions = new Map()
    this.stats = { notifications: 0, requests: 0, approvals: 0, errors: 0 }
    this.startedAt = Date.now()
  }

  // ---------------------------------------------------------------- transport

  /**
   * Boot the transport. 'auto' prefers the app-server JSON-RPC surface and
   * degrades to one-shot `codex exec --json` turns when that surface moved or
   * vanished (app-server is marked [experimental] in the CLI), so a Codex
   * update degrades the plugin instead of killing it.
   */
  async start() {
    if (this.ready) return this
    if (this.starting) return this.starting
    this.starting = (async () => {
      if (this.opts.transport === 'exec') {
        this.#startExec()
        return this
      }
      try {
        await this.#startAppServer()
        this.mode = 'app-server'
        return this
      } catch (error) {
        this.transportError = String(error && error.message || error)
        this.emit('transport-error', { error: this.transportError })
        if (this.opts.transport === 'auto') {
          this.#startExec()
          return this
        }
        throw error
      }
    })()
    try {
      return await this.starting
    } finally {
      this.starting = null
    }
  }

  #startExec() {
    this.mode = 'exec'
    this.ready = true
    this.emit('ready', { mode: 'exec', fallbackReason: this.transportError })
    return this
  }

  async #startAppServer() {
    const bin = this.opts.codexBin
    const args = ['app-server', '--listen', 'stdio://', ...this.opts.extraArgs]
    let child
    try {
      child = spawn(bin, args, {
        cwd: this.opts.cwd,
        env: this.opts.env,
        stdio: ['pipe', 'pipe', 'pipe'],
        windowsHide: true
      })
    } catch (error) {
      throw new Error(`cannot spawn codex (${bin}): ${error.message}`)
    }
    this.child = child
    const spawned = new Promise((resolve, reject) => {
      child.once('spawn', resolve)
      child.once('error', (error) => reject(new Error(`codex app-server failed to start: ${error.message}`)))
    })
    child.stdin.setDefaultEncoding('utf8')
    child.stderr.setEncoding('utf8')
    child.stderr.on('data', (chunk) => {
      for (const line of String(chunk).split(/\r?\n/)) {
        if (!line.trim()) continue
        this.stderrTail.push(line)
        if (this.stderrTail.length > 200) this.stderrTail.shift()
      }
    })
    this.rl = readline.createInterface({ input: child.stdout })
    this.rl.on('line', (line) => this.#onLine(line))
    child.on('exit', (code, signal) => {
      this.ready = false
      for (const [id, entry] of this.pending) {
        entry.reject(new Error(`codex app-server exited (code=${code} signal=${signal})`))
        this.pending.delete(id)
      }
      for (const s of this.sessions.values()) {
        if (s.status === 'running') s.status = 'error'
        s.lastError = s.lastError || `app-server exited (code=${code})`
      }
      this.emit('exit', { code, signal, stderr: this.stderrTail.slice(-5) })
    })
    await spawned
    const info = await this.#rpc('initialize', {
      clientInfo: {
        name: this.opts.clientName,
        title: 'DSH Codex Controller',
        version: this.opts.clientVersion
      },
      capabilities: { experimentalApi: false }
    }, this.opts.timeouts.init)
    this.#notify('initialized')
    this.ready = true
    this.serverInfo = info
    this.emit('ready', info)
    return this
  }

  #send(message) {
    if (!this.child || !this.child.stdin.writable) throw new Error('codex app-server is not writable')
    this.child.stdin.write(JSON.stringify(message) + '\n')
  }

  #notify(method, params) {
    const msg = params === undefined ? { method } : { method, params }
    this.#send(msg)
  }

  #rpc(method, params, timeoutMs) {
    const id = this.nextId++
    this.stats.requests++
    return new Promise((resolve, reject) => {
      const timer = timeoutMs
        ? setTimeout(() => {
          this.pending.delete(id)
          reject(new Error(`codex rpc timeout: ${method} (${timeoutMs}ms)`))
        }, timeoutMs)
        : null
      this.pending.set(id, {
        method,
        resolve: (value) => { if (timer) clearTimeout(timer); resolve(value) },
        reject: (error) => { if (timer) clearTimeout(timer); reject(error) }
      })
      try {
        this.#send({ id, method, params: params || {} })
      } catch (error) {
        this.pending.delete(id)
        if (timer) clearTimeout(timer)
        reject(error)
      }
    })
  }

  /** Answer a server-initiated request (approvals, elicitation, user input). */
  #answerServerRequest(id, method, params) {
    const decide = (result) => this.#send({ id, result })
    if (/requestApproval$|ApprovalRequest$/.test(method)) {
      const session = this.#sessionByThread(params && params.threadId)
      const approved = this.opts.autoApprove !== false
      if (session) {
        session.pendingApproval = {
          approvalId: (params && params.approvalId) || null,
          method,
          command: (params && params.command) || null,
          cwd: (params && params.cwd && (params.cwd.path || params.cwd)) || null,
          reason: (params && params.reason) || null,
          at: Date.now()
        }
        if (approved) session.pendingApproval = null
        this.#push(session, {
          kind: 'approval',
          type: method,
          text: `${approved ? 'auto-approved' : 'pending approval'}: ${clip((params && params.command) || method, 200)}`
        })
      }
      this.stats.approvals++
      if (approved) return decide({ decision: 'accept' })
      return decide({ decision: 'decline' })
    }
    if (/elicit/i.test(method)) return decide({ action: 'decline' })
    if (/requestUserInput|toolRequest/i.test(method)) return decide({ answers: {} })
    if (/attestation/i.test(method)) return decide({})
    return decide({})
  }

  #onLine(line) {
    const text = String(line).trim()
    if (!text) return
    let msg
    try { msg = JSON.parse(text) } catch {
      this.emit('garbage', text)
      return
    }
    if (msg.id !== undefined && msg.method) return this.#answerServerRequest(msg.id, msg.method, msg.params)
    if (msg.id !== undefined) {
      const entry = this.pending.get(msg.id)
      if (!entry) return
      this.pending.delete(msg.id)
      if (msg.error) entry.reject(new Error(`${entry.method}: ${msg.error.message || JSON.stringify(msg.error)}`))
      else entry.resolve(msg.result)
      return
    }
    if (!msg.method) return
    this.stats.notifications++
    try { this.#onNotification(msg.method, msg.params || {}) } catch (error) {
      this.stats.errors++
      this.emit('internal-error', { method: msg.method, error })
    }
  }

  #sessionByThread(threadId) {
    if (!threadId) return null
    for (const s of this.sessions.values()) if (s.threadId === threadId) return s
    return null
  }

  #push(session, entry) {
    if (!session) return null
    const record = { seq: ++SEQ, ts: Date.now(), ...entry }
    session.events.push(record)
    if (session.events.length > this.opts.eventLimit) session.events.splice(0, session.events.length - this.opts.eventLimit)
    session.lastActivity = record.ts
    this.emit('event', { session: session.key, event: record })
    return record
  }

  #onNotification(method, params) {
    const session = this.#sessionByThread(params.threadId)
    switch (method) {
      case 'thread/started': {
        if (session && params.thread) session.thread = params.thread
        return
      }
      case 'thread/status/changed': {
        if (!session) return
        const status = params.status || {}
        const type = status.type || 'unknown'
        session.threadStatus = type
        if (type === 'active') session.status = 'running'
        else if (session.status === 'running' && type !== 'systemError') session.status = 'idle'
        if (type === 'systemError') { session.status = 'error'; session.lastError = status.message || 'system error' }
        this.#push(session, { kind: 'status', type, text: `thread status → ${type}` })
        return
      }
      case 'turn/started': {
        if (!session) return
        const turn = params.turn || {}
        session.turnId = turn.id || null
        session.turnStatus = turn.status || 'inProgress'
        session.status = 'running'
        session.turnStartedAt = Date.now()
        session.current = null
        session.refusalActive = false
        this.#push(session, { kind: 'turn', type: 'started', turnId: session.turnId, text: `turn started (${session.turnId || '?'})` })
        return
      }
      case 'turn/completed': {
        if (!session) return
        const turn = params.turn || {}
        session.turnStatus = turn.status || 'completed'
        session.status = turn.status === 'failed' ? 'error' : 'idle'
        session.current = null
        session.elapsedMs = session.turnStartedAt ? Date.now() - session.turnStartedAt : session.elapsedMs
        const err = turn.error && (turn.error.message || turn.error.type)
        if (err) session.lastError = String(err)
        this.#push(session, {
          kind: 'turn',
          type: 'completed',
          turnId: turn.id || session.turnId,
          text: `turn ${session.turnStatus}${err ? `: ${clip(err, 300)}` : ''}`
        })
        this.emit('turn-completed', { session: session.key, status: session.turnStatus, error: err || null })
        return
      }
      case 'item/started': {
        if (!session) return
        const item = params.item || {}
        session.items.set(item.id, { ...item, _state: 'running', _startedAt: params.startedAtMs || Date.now() })
        session.counters.items++
        this.#trackItem(session, item, 'started')
        this.#push(session, { kind: 'item', type: item.type, phase: 'started', itemId: item.id, text: describeItem(item) })
        return
      }
      case 'item/completed': {
        if (!session) return
        const item = params.item || {}
        const prev = session.items.get(item.id) || {}
        session.items.set(item.id, { ...prev, ...item, _state: 'done', _completedAt: params.completedAtMs || Date.now() })
        this.#trackItem(session, item, 'completed')
        this.#push(session, {
          kind: 'item',
          type: item.type,
          phase: 'completed',
          itemId: item.id,
          text: describeItem(item),
          detail: itemDetail(item)
        })
        return
      }
      case 'item/agentMessage/delta': {
        if (!session) return
        session.messageBuffers.set(params.itemId, (session.messageBuffers.get(params.itemId) || '') + String(params.delta || ''))
        session.streamingText = (session.streamingText || '') + String(params.delta || '')
        if (session.streamingText.length > 20000) session.streamingText = session.streamingText.slice(-12000)
        this.#push(session, { kind: 'delta', type: 'agentMessage', itemId: params.itemId, text: String(params.delta || '') })
        return
      }
      case 'item/commandExecution/outputDelta': {
        if (!session) return
        const out = String(params.delta || '')
        session.commandOutput = (session.commandOutput || '') + out
        if (session.commandOutput.length > 20000) session.commandOutput = session.commandOutput.slice(-12000)
        this.#push(session, { kind: 'delta', type: 'commandOutput', itemId: params.itemId, text: out })
        return
      }
      case 'turn/plan/updated': {
        if (!session) return
        session.plan = Array.isArray(params.plan) ? params.plan : session.plan
        session.planExplanation = params.explanation || null
        this.#push(session, {
          kind: 'plan',
          type: 'updated',
          text: 'plan: ' + (session.plan || []).map((p) => `${p.status || '?'}: ${clip(p.step || p.text || '', 80)}`).join(' | ')
        })
        return
      }
      case 'thread/tokenUsage/updated': {
        if (!session) return
        session.usage = harvestUsage(params.tokenUsage, {})
        this.#push(session, { kind: 'usage', type: 'updated', text: `tokens: ${JSON.stringify(session.usage)}` })
        return
      }
      case 'thread/settings/updated': {
        if (!session) return
        session.settings = params.settings || params
        return
      }
      case 'error': {
        const err = params.error || {}
        const message = err.message || err.type || 'unknown error'
        if (session) {
          if (isRefusal(String(message))) {
            session.refusalCount = (session.refusalCount || 0) + 1
            session.lastRefusal = { at: Date.now(), turnId: session.turnId || null, text: String(message).slice(0, 1200) }
            this.#push(session, { kind: 'refusal', type: 'error', text: clip(String(message), 240) })
            this.emit('refusal', { session: session.key, text: clip(String(message), 500) })
            return
          }
          if (params.willRetry) {
            session.lastRetry = String(message)
            session.retries = (session.retries || 0) + 1
          } else {
            session.lastError = String(message)
            session.status = 'error'
          }
          this.#push(session, { kind: 'error', type: err.type || 'error', text: String(message) + (params.willRetry ? ' (retrying)' : '') })
        }
        this.stats.errors++
        this.emit('codex-error', { session: session && session.key, error: err, willRetry: params.willRetry })
        return
      }
      case 'mcpServer/startupStatus/updated': {
        if (!session) return
        session.mcpServers = session.mcpServers || {}
        session.mcpServers[params.name || '?'] = params.status || 'unknown'
        return
      }
      default: {
        if (!session) {
          this.emit('notification', { method, params })
          return
        }
        if (/delta$|updated$|started$|completed$/.test(method)) {
          this.#push(session, { kind: 'other', type: method, text: clip(JSON.stringify(params), 300) })
        }
      }
    }
  }

  #trackItem(session, item, phase) {
    const type = item.type
    if (phase === 'started') {
      session.current = { kind: type, label: describeItem(item), at: Date.now() }
      if (type === 'commandExecution') session.counters.commands++
      if (type === 'fileChange') session.counters.files++
      if (type === 'mcpToolCall') session.counters.mcp++
      if (type === 'webSearch') session.counters.webSearch++
      return
    }
    if (session.current && session.current.kind === type) session.current = null
    if (type === 'agentMessage' && item.text) {
      session.lastMessage = item.text
      session.messages.push({ at: Date.now(), text: item.text })
      if (session.messages.length > 200) session.messages.shift()
      session.streamingText = ''
      // Codex's safety classifier answers inside a normal assistant message
      // ("This content can't be shown … Daybreak"), so refusal is textual.
      if (isRefusal(item.text)) {
        session.refusalCount = (session.refusalCount || 0) + 1
        session.lastRefusal = {
          at: Date.now(),
          turnId: session.turnId || null,
          text: clip(item.text, 1200)
        }
        session.refusalActive = true
        this.#push(session, { kind: 'refusal', type: 'agentMessage', text: clip(item.text, 240) })
        this.emit('refusal', { session: session.key, text: clip(item.text, 500) })
      }
    }
    if (type === 'plan' && item.text) session.planText = item.text
  }

  // ------------------------------------------------------------------ sessions

  #newSession(fields) {
    return {
      key: fields.key,
      threadId: fields.threadId || null,
      transport: this.mode,
      cwd: fields.cwd,
      model: fields.model || null,
      approvalPolicy: fields.approvalPolicy,
      sandbox: fields.sandbox,
      createdAt: Date.now(),
      lastActivity: Date.now(),
      status: 'idle',
      threadStatus: 'idle',
      turnId: null,
      turnStatus: null,
      turnStartedAt: null,
      elapsedMs: 0,
      events: [],
      items: new Map(),
      messages: [],
      messageBuffers: new Map(),
      streamingText: '',
      commandOutput: '',
      plan: [],
      planExplanation: null,
      planText: null,
      usage: {},
      settings: null,
      lastError: null,
      pendingApproval: null,
      current: null,
      counters: { turns: 0, items: 0, commands: 0, files: 0, mcp: 0, webSearch: 0 },
      execChild: null,
      thread: fields.thread || null
    }
  }

  async openSession(options = {}) {
    await this.start()
    const cwd = options.cwd || this.opts.cwd
    const sandbox = options.sandbox || this.opts.sandbox
    const approvalPolicy = options.approvalPolicy || this.opts.approvalPolicy
    const model = options.model || this.opts.model || null
    if (this.mode === 'exec') {
      // exec transport: no thread exists until the first turn reports one
      const key = options.name && !this.sessions.has(options.name) ? options.name : 'cx-exec-' + (++SEQ)
      const session = this.#newSession({ key, cwd, sandbox, approvalPolicy, model })
      this.sessions.set(key, session)
      this.#push(session, { kind: 'session', type: 'opened', text: `exec session in ${cwd} (sandbox=${sandbox}, approval=${approvalPolicy}) — transport=exec fallback` })
      return this.describe(key)
    }
    const params = {
      cwd,
      model,
      approvalPolicy,
      sandbox,
      ephemeral: options.ephemeral === true,
      baseInstructions: options.baseInstructions || null,
      developerInstructions: options.developerInstructions || null
    }
    for (const k of Object.keys(params)) if (params[k] === null) delete params[k]
    const result = await this.#rpc('thread/start', params, this.opts.timeouts.init)
    const thread = result && result.thread ? result.thread : result
    const threadId = thread && thread.id
    if (!threadId) throw new Error('thread/start returned no thread id: ' + JSON.stringify(result).slice(0, 300))
    const key = options.name && !this.sessions.has(options.name) ? options.name : 'cx-' + String(threadId).slice(0, 8)
    const session = this.#newSession({
      key, threadId, cwd, sandbox, approvalPolicy,
      model: params.model || (thread && thread.model) || null, thread
    })
    this.sessions.set(key, session)
    this.#push(session, { kind: 'session', type: 'opened', text: `thread ${threadId} in ${cwd} (sandbox=${sandbox}, approval=${approvalPolicy})` })
    return this.describe(key)
  }

  async attachSession(threadId, options = {}) {
    await this.start()
    if (this.mode === 'exec') {
      const key = options.name || 'cx-' + String(threadId).slice(0, 8)
      const session = this.#newSession({
        key, threadId,
        cwd: options.cwd || this.opts.cwd,
        sandbox: options.sandbox || this.opts.sandbox,
        approvalPolicy: options.approvalPolicy || this.opts.approvalPolicy,
        model: options.model || this.opts.model || null
      })
      this.sessions.set(key, session)
      this.#push(session, { kind: 'session', type: 'resumed', text: `resumed ${threadId} via exec resume` })
      return this.describe(key)
    }
    const result = await this.#rpc('thread/resume', { threadId }, this.opts.timeouts.init)
    const thread = result && result.thread ? result.thread : result
    const key = options.name || 'cx-' + String(threadId).slice(0, 8)
    const session = this.#newSession({
      key, threadId,
      cwd: options.cwd || (thread && thread.cwd) || this.opts.cwd,
      sandbox: options.sandbox || this.opts.sandbox,
      approvalPolicy: options.approvalPolicy || this.opts.approvalPolicy,
      model: (thread && thread.model) || options.model || null,
      thread: thread || null
    })
    this.sessions.set(key, session)
    this.#push(session, { kind: 'session', type: 'resumed', text: `resumed thread ${threadId}` })
    return this.describe(key)
  }

  async sendTurn(key, payload) {
    await this.start()
    const session = this.#require(key)
    const text = typeof payload === 'string' ? payload : (payload && (payload.text || payload.prompt))
    if (!text || !String(text).trim()) throw new Error('sendTurn needs non-empty text')
    if (this.mode === 'exec' || session.transport === 'exec') return this.#execTurn(session, String(text), payload)
    const input = Array.isArray(payload && payload.input) ? payload.input : [{ type: 'text', text: String(text) }]
    const params = { threadId: session.threadId, input }
    if (payload && payload.model) params.model = payload.model
    let result
    try {
      result = await this.#rpc('turn/start', params, this.opts.timeouts.turn || 0)
    } catch (error) {
      // the experimental surface moved mid-flight: degrade this session to exec
      // instead of failing the whole controller
      if (this.opts.transport === 'auto') {
        this.transportError = `turn/start failed: ${error.message}`
        session.transport = 'exec'
        this.#push(session, { kind: 'session', type: 'transport-fallback', text: `turn/start failed (${error.message}) → exec fallback for this session` })
        return this.#execTurn(session, String(text), payload)
      }
      throw error
    }
    const turn = (result && result.turn) || {}
    session.turnId = turn.id || session.turnId
    session.turnStatus = turn.status || 'inProgress'
    session.status = 'running'
    session.turnStartedAt = Date.now()
    session.counters.turns++
    this.#push(session, {
      kind: 'turn',
      type: 'input',
      turnId: session.turnId,
      text: clip(String(text), 400),
      detail: { chars: String(text).length }
    })
    return { session: key, turnId: session.turnId, status: session.status, transport: session.transport || this.mode }
  }

  /** One-shot `codex exec --json` turn: the compat fallback transport. */
  #execTurn(session, text, payload) {
    if (session.execChild) throw new Error(`session ${session.key} already has a running turn — interrupt it first`)
    const args = ['exec']
    if (session.threadId) args.push('resume', session.threadId)
    args.push('--json', '--skip-git-repo-check')
    if (session.cwd) args.push('-C', session.cwd)
    if (session.sandbox) args.push('-s', session.sandbox)
    const model = (payload && payload.model) || session.model
    if (model) args.push('-m', model)
    args.push('-') // prompt from stdin: immune to quoting/flags in the text
    const child = spawn(this.opts.codexBin, args, {
      cwd: session.cwd || this.opts.cwd,
      env: this.opts.env,
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true
    })
    session.execChild = child
    session.transport = 'exec'
    session.status = 'running'
    session.turnStatus = 'inProgress'
    session.turnStartedAt = Date.now()
    session.counters.turns++
    session.execStderr = []
    this.#push(session, {
      kind: 'turn', type: 'input', turnId: session.turnId,
      text: clip(text, 400), detail: { chars: text.length, transport: 'exec' }
    })
    const started = new Promise((resolve, reject) => {
      child.once('spawn', resolve)
      child.once('error', (error) => reject(new Error(`codex exec failed to start: ${error.message}`)))
    })
    child.stdin.on('error', () => {})
    try { child.stdin.end(text) } catch { /* ignore */ }
    child.stderr.setEncoding('utf8')
    child.stderr.on('data', (chunk) => {
      for (const line of String(chunk).split(/\r?\n/)) {
        if (!line.trim()) continue
        session.execStderr.push(line)
        if (session.execStderr.length > 100) session.execStderr.shift()
      }
    })
    const rl = readline.createInterface({ input: child.stdout })
    let sawCompleted = false
    rl.on('line', (line) => {
      const trimmed = String(line).trim()
      if (!trimmed) return
      let ev
      try { ev = JSON.parse(trimmed) } catch { return }
      if (ev.type === 'turn.completed') sawCompleted = true
      this.#mapExecEvent(session, ev)
    })
    child.on('exit', (code) => {
      session.execChild = null
      rl.close()
      if (!sawCompleted) {
        const tail = session.execStderr.slice(-3).join(' | ')
        session.status = 'error'
        session.turnStatus = 'failed'
        session.lastError = `codex exec exited ${code}${tail ? ': ' + clip(tail, 300) : ''}`
        this.#push(session, { kind: 'error', type: 'exec-exit', text: session.lastError })
      }
      this.emit('turn-completed', { session: session.key, status: session.turnStatus, error: session.lastError || null })
    })
    return started.then(() => ({ session: session.key, turnId: session.turnId, status: 'running', transport: 'exec' }))
  }

  /** Map a `codex exec --json` JSONL event onto the shared session model. */
  #mapExecEvent(session, ev) {
    const type = ev.type || ''
    if (type === 'thread.started') {
      if (ev.thread_id && !session.threadId) session.threadId = ev.thread_id
      this.#push(session, { kind: 'session', type: 'thread', text: `thread ${session.threadId || '?'}` })
      return
    }
    if (type === 'turn.started') {
      session.status = 'running'
      session.refusalActive = false
      this.#push(session, { kind: 'turn', type: 'started', text: 'turn started (exec)' })
      return
    }
    if (type === 'error') {
      const message = String(ev.message || 'error')
      if (/^Reconnecting/i.test(message)) {
        session.lastRetry = message
        session.retries = (session.retries || 0) + 1
        this.#push(session, { kind: 'error', type: 'retry', text: message + ' (retrying)' })
      } else {
        session.lastError = message
        this.#push(session, { kind: 'error', type: 'exec', text: message })
      }
      return
    }
    if (type === 'item.started' || type === 'item.updated' || type === 'item.completed' || type === 'item.delta') {
      const item = ev.item || (ev.delta ? { id: ev.item_id, type: 'agent_message', text: ev.delta } : null)
      if (!item) return
      const phase = type.replace('item.', '')
      const mapped = normalizeExecItem(item)
      if (phase === 'started') {
        session.items.set(item.id, { ...mapped, _state: 'running' })
        session.counters.items++
        this.#trackItem(session, mapped, 'started')
        this.#push(session, { kind: 'item', type: mapped.type, phase: 'started', itemId: item.id, text: describeItem(mapped) })
      } else if (phase === 'completed') {
        const prev = session.items.get(item.id) || {}
        session.items.set(item.id, { ...prev, ...mapped, _state: 'done' })
        this.#trackItem(session, mapped, 'completed')
        if (mapped.type === 'commandExecution' && mapped.aggregatedOutput) session.commandOutput = String(mapped.aggregatedOutput).slice(-12000)
        this.#push(session, { kind: 'item', type: mapped.type, phase: 'completed', itemId: item.id, text: describeItem(mapped), detail: itemDetail(mapped) })
      } else if (mapped.type === 'agentMessage' && item.text) {
        session.streamingText = (session.streamingText || '') + String(item.text)
        this.#push(session, { kind: 'delta', type: 'agentMessage', itemId: item.id, text: String(item.text) })
      }
      return
    }
    if (type === 'turn.completed') {
      session.usage = harvestUsage(ev.usage || {}, {})
      session.turnStatus = 'completed'
      session.status = 'idle'
      session.elapsedMs = session.turnStartedAt ? Date.now() - session.turnStartedAt : session.elapsedMs
      this.#push(session, { kind: 'usage', type: 'updated', text: `tokens: ${JSON.stringify(session.usage)}` })
      this.#push(session, { kind: 'turn', type: 'completed', text: 'turn completed (exec)' })
      return
    }
    this.#push(session, { kind: 'other', type: type || 'exec-event', text: clip(JSON.stringify(ev), 300) })
  }

  async interrupt(key) {
    const session = this.#require(key)
    if (session.transport === 'exec' || this.mode === 'exec') {
      if (!session.execChild) return { ok: false, reason: 'no active turn' }
      const pid = session.execChild.pid
      try {
        if (process.platform === 'win32' && pid) spawn('taskkill', ['/pid', String(pid), '/T', '/F'], { windowsHide: true })
        else session.execChild.kill('SIGTERM')
      } catch { /* ignore */ }
      this.#push(session, { kind: 'turn', type: 'interrupt-requested', text: 'interrupt requested (exec: process killed)' })
      return { ok: true, transport: 'exec', pid }
    }
    if (!session.turnId) return { ok: false, reason: 'no active turn' }
    const result = await this.#rpc('turn/interrupt', { threadId: session.threadId, turnId: session.turnId }, this.opts.timeouts.request)
    this.#push(session, { kind: 'turn', type: 'interrupt-requested', turnId: session.turnId, text: 'interrupt requested' })
    return { ok: true, result }
  }

  readEvents(key, options = {}) {
    const session = this.#require(key)
    const since = Number.isFinite(options.since) ? options.since : 0
    const limit = Number.isFinite(options.limit) ? Math.min(Math.max(options.limit, 1), 1000) : 200
    const all = session.events.filter((e) => e.seq > since)
    const slice = all.slice(-limit)
    return {
      session: key,
      events: slice,
      dropped: all.length - slice.length,
      lastSeq: slice.length ? slice[slice.length - 1].seq : since,
      total: session.events.length
    }
  }

  describe(key) {
    const session = this.#require(key)
    const plan = Array.isArray(session.plan) ? session.plan : []
    const planDone = plan.filter((p) => /completed|done/i.test(String(p.status))).length
    return {
      key: session.key,
      threadId: session.threadId,
      transport: session.transport || this.mode,
      cwd: session.cwd,
      model: session.model,
      sandbox: session.sandbox,
      approvalPolicy: session.approvalPolicy,
      status: session.status,
      threadStatus: session.threadStatus,
      turnId: session.turnId,
      turnStatus: session.turnStatus,
      elapsedMs: session.turnStartedAt && session.status === 'running' ? Date.now() - session.turnStartedAt : session.elapsedMs,
      idleMs: Date.now() - session.lastActivity,
      counters: { ...session.counters },
      plan: plan.map((p) => ({ step: p.step || p.text || '', status: p.status || 'pending' })),
      planProgress: plan.length ? `${planDone}/${plan.length}` : (session.planText ? session.planText.split(/\r?\n/).length + ' lines' : null),
      current: session.current,
      usage: session.usage,
      pendingApproval: session.pendingApproval,
      lastError: session.lastError,
      lastRetry: session.lastRetry || null,
      retries: session.retries || 0,
      lastRefusal: session.lastRefusal || null,
      refusalCount: session.refusalCount || 0,
      refusalActive: !!session.refusalActive,
      mcpServers: session.mcpServers || null,
      lastMessage: session.lastMessage ? clip(session.lastMessage, 1200) : null,
      streaming: clip(session.streamingText || '', 1200),
      commandOutput: clip(session.commandOutput || '', 2000),
      eventCount: session.events.length,
      lastSeq: session.events.length ? session.events[session.events.length - 1].seq : 0,
      messages: session.messages.slice(-8).map((m) => ({ at: m.at, text: clip(m.text, 1500) }))
    }
  }

  listSessions() {
    return [...this.sessions.keys()].map((k) => this.describe(k))
  }

  /** Wait until the session's current turn settles or the timeout elapses. */
  async waitForIdle(key, timeoutMs = 60000, pollMs = 500) {
    const session = this.#require(key)
    const started = Date.now()
    while (Date.now() - started < timeoutMs) {
      if (session.status !== 'running') return this.describe(key)
      await new Promise((r) => setTimeout(r, pollMs))
    }
    return this.describe(key)
  }

  closeSession(key) {
    const session = this.sessions.get(key)
    if (!session) return { ok: false, reason: 'unknown session' }
    session.status = 'closed'
    this.sessions.delete(key)
    return { ok: true, key }
  }

  async dispose() {
    for (const s of this.sessions.values()) {
      s.status = 'closed'
      if (s.execChild) { try { s.execChild.kill() } catch { /* ignore */ } }
    }
    this.sessions.clear()
    if (this.rl) { try { this.rl.close() } catch { /* ignore */ } }
    if (this.child) {
      try { this.child.stdin.end() } catch { /* ignore */ }
      try { this.child.kill() } catch { /* ignore */ }
    }
    this.child = null
    this.ready = false
  }

  // -------------------------------------------------------------------- doctor

  /**
   * Compatibility self-check for "Codex updated / DSH updated" mornings:
   * probes the installed binary, the app-server method surface (via the CLI's
   * own generated JSON schema), the exec fallback, and this plugin's own
   * transport decision — then says what to do.
   */
  async doctor(options = {}) {
    const result = {
      plugin: { name: 'dsh-plugin-codex-controller', version: '1.1.0', transport: this.opts.transport, mode: this.mode || 'not-started', transportError: this.transportError },
      dsh: { tools: options.toolCount !== undefined ? options.toolCount : null, api: options.api === undefined ? null : options.api },
      codex: { bin: this.opts.codexBin, path: null, version: null, appServer: false, generateSchema: false, missingMethods: [], execJson: false, execResume: false },
      ok: false,
      advice: []
    }
    const bin = this.opts.codexBin
    result.codex.path = path.isAbsolute(bin)
      ? (fs.existsSync(bin) ? bin : null)
      : bin
    const versionRun = await this.#run(['--version'], 15000)
    const vMatch = /(\d+\.\d+\.\d+(?:[-+][\w.]+)?)/.exec(String(versionRun.stdout || versionRun.stderr || ''))
    result.codex.version = vMatch ? vMatch[1] : null
    if (!result.codex.version) {
      result.advice.push(`无法执行 codex --version（bin=${bin}）。确认 Codex CLI 已安装，或把 config.codexBin 指到真实二进制。`)
    }

    const help = await this.#run(['--help'], 20000)
    const helpText = String(help.stdout || '')
    result.codex.appServer = /\bapp-server\b/.test(helpText)
    const execHelp = await this.#run(['exec', '--help'], 20000)
    result.codex.execJson = /--json\b/.test(String(execHelp.stdout || ''))
    const resumeHelp = await this.#run(['exec', 'resume', '--help'], 20000)
    result.codex.execResume = resumeHelp.code === 0

    // app-server protocol surface: ask the CLI for its own schema and check the
    // methods this plugin calls. Additive changes pass; renames show up here.
    if (result.codex.appServer) {
      const outDir = path.join(os.tmpdir(), 'dsh-codex-controller-schema-' + Date.now())
      try {
        fs.mkdirSync(outDir, { recursive: true })
        const gen = await this.#run(['app-server', 'generate-json-schema', '--out', outDir], 120000)
        result.codex.generateSchema = gen.code === 0
        if (gen.code === 0) {
          const schemaPath = path.join(outDir, 'codex_app_server_protocol.schemas.json')
          const raw = fs.existsSync(schemaPath) ? fs.readFileSync(schemaPath, 'utf8') : ''
          result.codex.missingMethods = REQUIRED_METHODS.filter((m) => raw.indexOf(`"${m}"`) < 0)
          result.codex.schemaBytes = raw.length
        }
      } catch (error) {
        result.codex.schemaError = String(error && error.message || error)
      } finally {
        try { fs.rmSync(outDir, { recursive: true, force: true }) } catch { /* ignore */ }
      }
    }

    if (options.probe) {
      try {
        const s = await this.openSession({ cwd: options.cwd || this.opts.cwd })
        await this.sendTurn(s.key, 'Reply with exactly: PROBE_OK')
        const settled = await this.waitForIdle(s.key, options.probeTimeoutMs || 120000)
        result.probe = { ok: settled.status === 'idle' && /PROBE_OK/.test(settled.lastMessage || ''), reply: settled.lastMessage || null, transport: settled.transport || this.mode, tokens: settled.usage }
        this.closeSession(s.key)
      } catch (error) {
        result.probe = { ok: false, error: String(error && error.message || error) }
        result.advice.push('单轮探针失败：' + (error && error.message || error))
      }
    }

    result.ok = Boolean(result.codex.version) && (result.codex.appServer ? result.codex.missingMethods.length === 0 : result.codex.execJson)

    if (result.codex.appServer && result.codex.missingMethods.length) {
      result.advice.push(`app-server 协议方法缺失：${result.codex.missingMethods.join(', ')} —— 该 Codex 版本改了实验性协议。插件已自动降级到 exec 传输；要恢复 app-server 全功能（计划/流式/审批），需要按新 schema 更新 lib/controller.js 的调用点。`)
    }
    if (!result.codex.appServer && result.codex.execJson) {
      result.advice.push('该版本没有 app-server 子命令：插件走 exec 单轮传输，功能可用但没有流式输出/计划清单/审批交互。')
    }
    if (!result.codex.execJson) {
      result.advice.push('exec --json 也不可用：这是 Codex CLI 的重大变化，先锁回已知可用版本，例如 npm i -g @openai/codex@<旧版本>。')
    }
    if (this.transportError) {
      result.advice.push(`本次运行已发生传输降级：${this.transportError}`)
    }
    if (!result.advice.length) result.advice.push('协议与传输均正常，无需处理。')
    return result
  }

  #run(args, timeoutMs = 30000) {
    return new Promise((resolve) => {
      let stdout = ''
      let stderr = ''
      let child
      try {
        child = spawn(this.opts.codexBin, args, { cwd: this.opts.cwd, env: this.opts.env, windowHide: true, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
      } catch (error) {
        resolve({ code: -1, stdout: '', stderr: String(error && error.message || error) })
        return
      }
      const timer = setTimeout(() => {
        try { child.kill() } catch { /* ignore */ }
        resolve({ code: -2, stdout, stderr: stderr + '\n(timeout ' + timeoutMs + 'ms)' })
      }, timeoutMs)
      child.stdout.setEncoding('utf8')
      child.stderr.setEncoding('utf8')
      child.stdout.on('data', (c) => { stdout += c })
      child.stderr.on('data', (c) => { stderr += c })
      child.on('error', (error) => {
        clearTimeout(timer)
        resolve({ code: -1, stdout, stderr: String(error && error.message || error) })
      })
      child.on('close', (code) => {
        clearTimeout(timer)
        resolve({ code, stdout, stderr })
      })
    })
  }

  #require(key) {
    const session = this.sessions.get(key)
    if (!session) throw new Error(`unknown codex session "${key}" — open one with codex_open first`)
    return session
  }
}

/** app-server methods/notifications this plugin depends on. */
export const REQUIRED_METHODS = [
  'initialize',
  'thread/start',
  'thread/resume',
  'turn/start',
  'turn/interrupt',
  'turn/started',
  'turn/completed',
  'item/started',
  'item/completed',
  'item/agentMessage/delta',
  'item/commandExecution/outputDelta',
  'turn/plan/updated',
  'thread/tokenUsage/updated'
]

/** exec transport item types are snake_case; the session model is camelCase. */
export function mapExecItemType(type) {
  const map = {
    agent_message: 'agentMessage',
    reasoning: 'reasoning',
    command_execution: 'commandExecution',
    file_change: 'fileChange',
    mcp_tool_call: 'mcpToolCall',
    web_search: 'webSearch',
    plan: 'plan',
    plan_update: 'plan',
    todo_list: 'plan',
    error: 'error',
    user_message: 'userMessage'
  }
  if (!type) return 'item'
  return map[type] || type
}

/** Normalize the snake_case payload of an exec item into the app-server shape. */
export function normalizeExecItem(item) {
  if (!item || typeof item !== 'object') return item
  const out = { ...item, type: mapExecItemType(item.type) }
  const pairs = [
    ['aggregated_output', 'aggregatedOutput'],
    ['exit_code', 'exitCode'],
    ['duration_ms', 'durationMs'],
    ['item_id', 'itemId']
  ]
  for (const [from, to] of pairs) if (out[from] !== undefined && out[to] === undefined) out[to] = out[from]
  return out
}


/** One-line human label for a thread item. */
export function describeItem(item) {
  if (!item || typeof item !== 'object') return 'item'
  const t = item.type
  switch (t) {
    case 'userMessage':
      return 'user: ' + clip(pickText(item.content) || item.text || '', 160)
    case 'agentMessage':
      return 'agent: ' + clip(item.text || '', 160)
    case 'reasoning':
      return 'reasoning' + (item.summary && item.summary.length ? ': ' + clip(pickText(item.summary), 120) : '')
    case 'plan':
      return 'plan: ' + clip(item.text || '', 160)
    case 'commandExecution':
      return 'run ' + clip(item.command || '', 160) + (item.status ? ` [${item.status}]` : '')
    case 'fileChange':
      return `edit ${(item.changes || []).length} file(s)` + (item.status ? ` [${item.status}]` : '')
    case 'mcpToolCall':
      return `mcp ${item.server || '?'}/${item.tool || '?'} [${item.status || '?'}]`
    case 'dynamicToolCall':
      return `tool ${item.tool || '?'} [${item.status || '?'}]`
    case 'webSearch':
      return 'web search: ' + clip(item.query || '', 120)
    case 'imageView':
      return 'view image ' + clip(item.path || '', 120)
    case 'contextCompaction':
      return 'context compacted'
    default:
      return String(t || 'item')
  }
}

function itemDetail(item) {
  const t = item && item.type
  if (!t) return null
  if (t === 'commandExecution') {
    return {
      command: clip(item.command || '', 400),
      exitCode: item.exitCode,
      durationMs: item.durationMs,
      output: clip(item.aggregatedOutput || '', 3000)
    }
  }
  if (t === 'fileChange') return { changes: (item.changes || []).map((c) => c.path || c.file || c.kind || '?') }
  if (t === 'agentMessage') return { text: clip(item.text || '', 4000) }
  if (t === 'mcpToolCall') return { server: item.server, tool: item.tool, status: item.status, error: item.error ? clip(JSON.stringify(item.error), 600) : null }
  if (t === 'webSearch') return { query: item.query, results: (item.results || []).length }
  return null
}

function pickText(value) {
  if (!value) return ''
  if (typeof value === 'string') return value
  if (Array.isArray(value)) return value.map(pickText).filter(Boolean).join('\n')
  if (typeof value === 'object') {
    for (const k of ['text', 'content', 'summary', 'value']) if (value[k]) return pickText(value[k])
  }
  return ''
}
