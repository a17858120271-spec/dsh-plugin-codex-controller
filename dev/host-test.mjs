// Host-half integration test: loads lib/index.js as the cordis plugin would,
// with a fake ctx, then drives the real codex app-server through the tools.
import { apply, name, inject } from '../lib/index.js'

const scratch = process.argv[2] || process.cwd()
const tools = new Map()
const disposers = []
let apiHandler = null
let apiPath = null

const ctx = {
  tools: { register: (def) => tools.set(def.name, def) },
  webServer: { register: (opts) => { apiPath = opts.path; apiHandler = opts.handler; return () => {} } },
  effect: (fn) => { const d = fn(); if (typeof d === 'function') disposers.push(d) },
  get: () => undefined,
  logger: console
}

console.log('plugin:', name, 'inject:', inject.join(','))
apply(ctx, { defaultCwd: scratch, sandbox: 'read-only', approvalPolicy: 'never', autoApprove: true })
console.log('tools:', [...tools.keys()].join(', '))
console.log('api path:', apiPath)

async function call(tool, args) {
  const def = tools.get(tool)
  const out = await def.execute(args || {})
  const rendered = def.output && def.output.render ? def.output.render(args || {}, out) : null
  const text = rendered && rendered[0] ? rendered[0].text : JSON.stringify(out)
  console.log(`\n===== ${tool} =====\n` + String(text).slice(0, 2000))
  return out
}

try {
  await call('codex_prompt', {
    goal: '给 codex 控制器补一个 /health 端点',
    must: '返回 {ok:true}\n不引入新依赖',
    acceptance: 'curl /codex-controller/api/health 返回 200',
    format: 'compact',
    language: 'zh'
  })

  const opened = await call('codex_open', { cwd: scratch })
  const key = opened.key

  await call('codex_send', {
    session: key,
    text: 'Run the shell command `echo CONTROLLER_OK` once, then reply with exactly: DONE',
    waitMs: 150000
  })

  await call('codex_status', { session: key })
  const read = await call('codex_read', { session: key, limit: 40 })
  console.log('\nlastSeq:', read.lastSeq, 'events:', read.events.length)
  await call('codex_sessions', {})

  // exercise the client-facing JSON API surface directly
  if (apiHandler) {
    const res = {
      statusCode: 0, headers: null, body: '',
      writeHead(code, headers) { this.statusCode = code; this.headers = headers },
      end(chunk) { this.body = chunk }
    }
    await apiHandler({ method: 'GET', url: '/codex-controller/api/state' }, res)
    const state = JSON.parse(res.body)
    console.log('\nAPI /state ->', res.statusCode, 'ready=' + state.ready, 'sessions=' + state.sessions.length, 'bin=' + state.bin)
    const res2 = { writeHead() {}, end(c) { this.body = c } }
    await apiHandler({ method: 'GET', url: '/codex-controller/api/events?session=' + encodeURIComponent(key) + '&limit=5' }, res2)
    console.log('API /events ->', JSON.parse(res2.body).events.length, 'events')
  }

  for (const d of disposers) { try { d() } catch (e) { console.log('disposer error', e.message) } }
  console.log('\nHOST TEST OK')
  process.exit(0)
} catch (error) {
  console.error('HOST TEST FAILED:', error && error.stack || error)
  process.exit(1)
}
