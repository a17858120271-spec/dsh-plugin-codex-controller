// Client-half smoke test: executes lib/client.js with a stub module loader and
// stub React, asserting the loader contract and slot registrations.
import fs from 'node:fs'
import vm from 'node:vm'

const code = fs.readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8')

const slots = []
let loaded = null
const ReactStub = {
  createElement: (type, props, ...children) => ({ type, props, children }),
  useState: (init) => [typeof init === 'function' ? init() : init, () => {}],
  useEffect: () => {},
  useRef: (v) => ({ current: v }),
  useSyncExternalStore: (_sub, snap) => snap()
}

const sandbox = {
  window: { __ModuleLoader__: { load: (def) => { loaded = def } } },
  document: {
    documentElement: { getAttribute: () => 'zh', lang: 'zh' },
    createElement: () => ({ setAttribute() {}, appendChild() {}, textContent: '' }),
    head: { appendChild: () => {} }
  },
  MutationObserver: class { observe() {} disconnect() {} },
  fetch: () => Promise.resolve({ ok: true, json: () => Promise.resolve({}) }),
  setTimeout, clearTimeout, Promise, console, JSON, encodeURIComponent, URL
}
vm.createContext(sandbox)
new vm.Script(code, { filename: 'client.js' }).runInContext(sandbox)

if (!loaded) throw new Error('client.js did not call window.__ModuleLoader__.load')
console.log('loader id:', loaded.id, '| factory type:', typeof loaded.factory)

const mod = loaded.factory((spec) => {
  if (spec === 'react') return ReactStub
  throw new Error('unexpected require: ' + spec)
})
console.log('exports:', Object.keys(mod), '| inject:', (mod.inject || []).join(','))

const ctx = {
  locale: { getLocale: () => ({ active: 'zh' }), subscribe: () => () => {} },
  slots: {
    inject: (name, cb) => { slots.push(['inject', name]); cb() },
    register: (opts) => { slots.push(['register', opts.name, opts.id, opts.label || '']) }
  }
}
mod.apply(ctx)
console.log('slot calls:')
for (const s of slots) console.log('  ', s.join(' | '))

// render the panel tree with the stub to catch obvious component errors
const panels = []
const ctx2 = {
  locale: ctx.locale,
  slots: {
    inject: (name, cb) => cb(),
    register: (opts, render) => panels.push([opts, render])
  }
}
mod.apply(ctx2)
for (const [opts, render] of panels) {
  const tree = render()
  console.log('rendered', opts.name, '->', tree && (tree.type && (typeof tree.type === 'function' ? 'component' : tree.type)))
  if (tree && typeof tree.type === 'function') {
    const out = tree.type({})
    if (out === null) { console.log('   component body ok, returns null while data is loading'); continue }
    if (!out || !out.type) throw new Error('component ' + opts.name + ' returned no element')
    console.log('   component body ok, root =', typeof out.type === 'function' ? (out.type.name || 'fn') : out.type)
  }
}
console.log('CLIENT SMOKE OK')
