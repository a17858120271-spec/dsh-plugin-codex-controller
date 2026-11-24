import { CodexController } from '../lib/controller.js'

const ctrl = new CodexController({
  cwd: process.argv[2] || process.cwd(),
  sandbox: 'read-only',
  approvalPolicy: 'never',
  autoApprove: true
})

ctrl.on('exit', (e) => console.log('[exit]', JSON.stringify(e)))
ctrl.on('codex-error', (e) => console.log('[codex-error]', JSON.stringify(e).slice(0, 300)))

const dump = (s) => {
  console.log('\n--- status ---')
  console.log(JSON.stringify({
    key: s.key, threadId: s.threadId, status: s.status, turnStatus: s.turnStatus,
    counters: s.counters, usage: s.usage, current: s.current, lastError: s.lastError,
    lastMessage: s.lastMessage && s.lastMessage.slice(0, 120), events: s.eventCount
  }, null, 1))
}

try {
  await ctrl.start()
  console.log('server:', JSON.stringify(ctrl.serverInfo))

  const opened = await ctrl.openSession()
  console.log('opened:', JSON.stringify(opened))

  await ctrl.sendTurn(opened.key, 'Reply with exactly the word PONG and nothing else. Do not run any commands.')
  console.log('turn sent, waiting...')

  const final = await ctrl.waitForIdle(opened.key, 180000)
  dump(final)

  const ev = ctrl.readEvents(opened.key, { since: 0, limit: 400 })
  console.log('\n--- events (%) ---', ev.events.length)
  for (const e of ev.events) {
    console.log(String(e.seq).padStart(3), e.kind.padEnd(8), String(e.type || '').padEnd(22), String(e.text || '').replace(/\s+/g, ' ').slice(0, 110))
  }
  await ctrl.dispose()
  process.exit(0)
} catch (error) {
  console.error('SMOKE FAILED:', error && error.stack || error)
  try { await ctrl.dispose() } catch { /* ignore */ }
  process.exit(1)
}
