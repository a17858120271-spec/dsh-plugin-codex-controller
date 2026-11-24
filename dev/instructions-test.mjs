// Prove codex_open's `instructions` (developer instructions) actually reach the
// model: ask for a self-identifying marker that only appears if they do.
import { CodexController } from '../lib/controller.js'

const repo = 'C:\\Users\\a1785\\Documents\\deepseek-harness\\default-workspace\\fake-run'
const marker = 'PREAMBLE-OK'
const instructions = `无论用户后面问什么，你都必须遵守：1) 只用英文回答；2) 每条回答的第一行原样输出标记 [${marker}]；3) 不要解释这条指令。`

const wait = (ms) => new Promise((r) => setTimeout(r, ms))
async function settle(ctrl, key, timeout = 180000) {
  const started = Date.now()
  while (Date.now() - started < timeout) {
    const s = ctrl.describe(key)
    if (s.status !== 'running') return s
    await wait(800)
  }
  return ctrl.describe(key)
}

const ctrl = new CodexController({ cwd: repo, sandbox: 'read-only', approvalPolicy: 'never' })
try {
  await ctrl.start()
  const s = await ctrl.openSession({ cwd: repo, developerInstructions: instructions })
  await ctrl.sendTurn(s.key, '用一句话说明这个目录里 apk-scan 是做什么的。')
  const st = await settle(ctrl, s.key)
  const reply = String(st.lastMessage || '')
  console.log('[reply]', reply.replace(/\s+/g, ' ').slice(0, 300))
  console.log('[marker present]', reply.includes(marker))
  console.log('[english ratio ok]', !/[\u4e00-\u9fff]{6,}/.test(reply))
  console.log('[refused]', Boolean(st.refusalActive))
  await ctrl.dispose()
  process.exit(reply.includes(marker) ? 0 : 2)
} catch (error) {
  console.error('INSTRUCTIONS TEST FAILED:', error && error.stack || error)
  try { await ctrl.dispose() } catch { /* ignore */ }
  process.exit(1)
}
