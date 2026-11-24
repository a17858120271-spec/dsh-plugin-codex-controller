// Compatibility harness: doctor + forced-exec-transport turn.
//   node dev/compat-test.mjs doctor  [cwd]
//   node dev/compat-test.mjs exec    [cwd]
//   node dev/compat-test.mjs auto    [cwd]
import { CodexController } from '../lib/controller.js'

const mode = process.argv[2] || 'doctor'
const cwd = process.argv[3] || process.cwd()

const ctrl = new CodexController({
  cwd,
  sandbox: 'read-only',
  approvalPolicy: 'never',
  transport: mode === 'exec' ? 'exec' : mode === 'auto' ? 'auto' : 'auto'
})
ctrl.on('ready', (info) => console.log('[ready]', JSON.stringify(info).slice(0, 200)))
ctrl.on('transport-error', (e) => console.log('[transport-error]', e.error))

try {
  await ctrl.start()
  console.log('[mode]', ctrl.mode, '| transportError:', ctrl.transportError)

  if (mode === 'doctor') {
    const report = await ctrl.doctor({ probe: process.argv.includes('--probe') })
    console.log(JSON.stringify(report, null, 1))
    await ctrl.dispose()
    process.exit(report.ok ? 0 : 2)
  }

  const s = await ctrl.openSession()
  console.log('[open]', JSON.stringify({ key: s.key, threadId: s.threadId, transport: s.transport, status: s.status }))
  await ctrl.sendTurn(s.key, 'Reply with exactly: EXECPATH_OK. Do not run any commands.')
  const settled = await ctrl.waitForIdle(s.key, 180000)
  console.log('[settled]', JSON.stringify({
    status: settled.status, turn: settled.turnStatus, transport: settled.transport,
    last: settled.lastMessage, usage: settled.usage, events: settled.eventCount, error: settled.lastError
  }, null, 1))
  const ev = ctrl.readEvents(s.key, { limit: 200 })
  console.log('[events]', ev.events.length)
  for (const e of ev.events.slice(-14)) console.log(' ', String(e.seq).padStart(3), e.kind.padEnd(7), String(e.type || '').padEnd(18), String(e.text || '').replace(/\s+/g, ' ').slice(0, 90))
  await ctrl.dispose()
  process.exit(settled.status === 'idle' ? 0 : 1)
} catch (error) {
  console.error('COMPAT TEST FAILED:', error && error.stack || error)
  try { await ctrl.dispose() } catch { /* ignore */ }
  process.exit(1)
}
