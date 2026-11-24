// Fallback path test: make the app-server surface unusable and confirm the
// controller degrades to `codex exec --json` instead of failing (the exact
// failure mode a future Codex release can produce).
import { CodexController } from '../lib/controller.js'

const cwd = process.argv[2] || process.cwd()
const ctrl = new CodexController({
  cwd,
  sandbox: 'read-only',
  approvalPolicy: 'never',
  transport: 'auto',
  extraArgs: ['--listen', 'bogus://nope'] // forces app-server startup to fail
})
ctrl.on('transport-error', (e) => console.log('[fallback]', String(e.error).slice(0, 240)))
ctrl.on('ready', (info) => console.log('[ready]', JSON.stringify(info).slice(0, 200)))

try {
  await ctrl.start()
  console.log('[mode]', ctrl.mode)
  const s = await ctrl.openSession()
  console.log('[open]', s.key, 'transport=' + s.transport)
  await ctrl.sendTurn(s.key, 'Reply with exactly: FALLBACK_OK')
  const settled = await ctrl.waitForIdle(s.key, 180000)
  console.log('[settled]', JSON.stringify({ status: settled.status, transport: settled.transport, last: settled.lastMessage, usage: settled.usage }, null, 1))
  const ok = ctrl.mode === 'exec' && settled.status === 'idle' && /FALLBACK_OK/.test(settled.lastMessage || '')
  console.log(ok ? 'FALLBACK TEST OK' : 'FALLBACK TEST FAILED')
  await ctrl.dispose()
  process.exit(ok ? 0 : 1)
} catch (error) {
  console.error('FALLBACK TEST FAILED:', error && error.stack || error)
  try { await ctrl.dispose() } catch { /* ignore */ }
  process.exit(1)
}
