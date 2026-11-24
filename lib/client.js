/*!
 * dsh-plugin-codex-controller — client half (browser).
 *
 * Prebuilt (no JSX, no bundler): registers into the DSH client-module loader and
 * renders React.createElement directly. Two surfaces:
 *   - settings.section  "Codex 控制器": full control plane (sessions, live
 *     progress, event log, prompt drafting, composer)
 *   - conversation.composer.dock: compact status pill
 * All state comes from the node half's /codex-controller/api/* routes.
 */

window.__ModuleLoader__.load({
  id: 'dsh-plugin-codex-controller',
  factory: function (require) {
    var module = { exports: {} }
    var exports = module.exports
    var React = require('react')
    var h = React.createElement
    var useState = React.useState
    var useEffect = React.useEffect
    var useRef = React.useRef

    var API = '/codex-controller/api'
    var RUNTIME = { ctx: null }

    var STR = {
      zh: {
        title: 'Codex 控制器',
        sub: 'app-server JSON-RPC · 提示词拟定 · 实时进度',
        ready: '就绪', off: '未启动', boot: '启动 app-server', shutdown: '停止',
        noSession: '还没有会话——先打开一个 Codex 线程。',
        cwd: '工作目录', model: '模型（可空）', sandbox: '沙箱', approval: '审批策略', open: '打开会话',
        sessions: '会话', refresh: '刷新', close: '关闭',
        status: '状态', plan: '计划', current: '当前', events: '事件流', message: '消息',
        send: '发送', interrupt: '中断', waiting: '运行中', idle: '空闲', error: '错误',
        draft: '结构化提示词', goal: '目标（一句话）', must: '必须完成（每行一条）', accept: '验收标准（每行一条）',
        makePrompt: '生成提示词', tokens: 'token', elapsed: '耗时', counters: '计数',
        lastMsg: '最近回复', streaming: '流式输出', cmdOut: '命令输出', err: '错误',
        empty: '暂无', poll: '每 1.5s 自动刷新', promptHint: '提示词内容（可直接编辑后再发送）',
        ctrl: '控制', usage: '用量', doctor: '自检', mode: '传输',
        refusal: '被内容过滤拒答', reframe: '重述并重发', refusalHint: '把输入框里的需求换成工程语言再发',
        docOk: '协议正常', docBad: '需要处理', docHint: 'Codex / Harness 更新后点这里体检',
        pillRunning: '{n} 个会话 · {m} 运行中', pillIdle: '{n} 个会话 · 空闲', pillOff: 'codex 未启动'
      },
      en: {
        title: 'Codex Controller',
        sub: 'app-server JSON-RPC · prompt drafting · live progress',
        ready: 'ready', off: 'not started', boot: 'start app-server', shutdown: 'stop',
        noSession: 'No session yet — open a Codex thread first.',
        cwd: 'Working dir', model: 'Model (optional)', sandbox: 'Sandbox', approval: 'Approval policy', open: 'Open session',
        sessions: 'Sessions', refresh: 'Refresh', close: 'Close',
        status: 'Status', plan: 'Plan', current: 'Current', events: 'Event log', message: 'Message',
        send: 'Send', interrupt: 'Interrupt', waiting: 'running', idle: 'idle', error: 'error',
        draft: 'Structured prompt', goal: 'Goal (one line)', must: 'Must do (one per line)', accept: 'Acceptance (one per line)',
        makePrompt: 'Draft prompt', tokens: 'tokens', elapsed: 'elapsed', counters: 'counters',
        lastMsg: 'Last reply', streaming: 'Streaming', cmdOut: 'Command output', err: 'Error',
        empty: 'none', poll: 'auto-refresh 1.5s', promptHint: 'Prompt (edit before sending)',
        ctrl: 'Control', usage: 'Usage', doctor: 'Self-check', mode: 'Transport',
        refusal: 'refused by content filter', reframe: 'Reframe & send', refusalHint: 'rewrite the composer text in engineering language, then resend',
        docOk: 'protocol healthy', docBad: 'action needed', docHint: 'run this after a Codex or harness update',
        pillRunning: '{n} sessions · {m} running', pillIdle: '{n} sessions · idle', pillOff: 'codex not started'
      }
    }

    function tr(locale, key, vars) {
      var dict = STR[locale] || STR.en
      var s = dict[key] !== undefined ? dict[key] : (STR.en[key] !== undefined ? STR.en[key] : key)
      if (vars) s = s.replace(/\{(\w+)\}/g, function (m, k) { return vars[k] !== undefined ? vars[k] : m })
      return s
    }

    var CSS = ''
      + '.cc-wrap{display:flex;flex-direction:column;gap:12px;font-size:13px;color:var(--dsw-alias-label-primary,#1f2937)}'
      + '.cc-row{display:flex;align-items:center;gap:8px;flex-wrap:wrap}'
      + '.cc-card{background:var(--dsw-alias-bg-layer-2,color-mix(in srgb,var(--dsw-alias-bg-base,#f7f7f8) 82%,transparent));border:1px solid var(--dsw-alias-border-l1,#e5e7eb);border-radius:10px;padding:10px 12px}'
      + '.cc-title{font-size:12px;font-weight:600;color:var(--dsw-alias-label-secondary,#6b7280);letter-spacing:.02em;text-transform:uppercase;margin-bottom:6px}'
      + '.cc-dim{color:var(--dsw-alias-label-secondary,#6b7280)}'
      + '.cc-mono{font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:11.5px}'
      + '.cc-btn{border:1px solid var(--dsw-alias-border-l2,#d1d5db);background:transparent;color:inherit;border-radius:8px;padding:3px 10px;font-size:12px;cursor:pointer}'
      + '.cc-btn:hover{border-color:var(--dsw-alias-brand-primary,#2563eb)}'
      + '.cc-btn[disabled]{opacity:.45;cursor:default}'
      + '.cc-btn.primary{background:var(--dsw-alias-brand-primary,#2563eb);color:#fff;border-color:transparent}'
      + '.cc-input,.cc-select,.cc-area{border:1px solid var(--dsw-alias-border-l1,#e5e7eb);background:var(--dsw-alias-bg-base,#fff);color:inherit;border-radius:8px;padding:4px 8px;font-size:12px;font-family:inherit;min-width:0}'
      + '.cc-area{width:100%;resize:vertical;line-height:1.5}'
      + '.cc-chip{display:inline-flex;align-items:center;gap:5px;border:1px solid var(--dsw-alias-border-l1,#e5e7eb);border-radius:999px;padding:2px 9px;font-size:12px;cursor:pointer;background:transparent;color:inherit}'
      + '.cc-chip.active{border-color:var(--dsw-alias-brand-primary,#2563eb);color:var(--dsw-alias-brand-primary,#2563eb)}'
      + '.cc-dot{width:7px;height:7px;border-radius:50%;display:inline-block;background:#9ca3af}'
      + '.cc-dot.run{background:#16a34a;box-shadow:0 0 0 3px rgba(22,163,74,.18)}'
      + '.cc-dot.err{background:#dc2626}'
      + '.cc-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(120px,1fr));gap:8px}'
      + '.cc-kpi{border:1px solid var(--dsw-alias-border-l1,#e5e7eb);border-radius:8px;padding:6px 9px}'
      + '.cc-kpi b{display:block;font-size:16px;font-weight:650}'
      + '.cc-kpi span{font-size:11px;color:var(--dsw-alias-label-secondary,#6b7280)}'
      + '.cc-pre{white-space:pre-wrap;word-break:break-word;max-height:180px;overflow:auto;margin:4px 0 0;padding:6px 8px;border-radius:8px;background:rgba(127,127,127,.08);font-family:ui-monospace,Menlo,Consolas,monospace;font-size:11.5px;line-height:1.45}'
      + '.cc-evline{display:grid;grid-template-columns:44px 62px 120px 1fr;gap:8px;align-items:baseline;padding:2px 0;border-top:1px solid var(--dsw-alias-border-l1,#eceef1);font-size:11.5px}'
      + '.cc-evline:first-child{border-top:none}'
      + '.cc-evlog{max-height:240px;overflow:auto}'
      + '.cc-pill{display:inline-flex;align-items:center;gap:6px;font-size:11.5px;color:var(--dsw-alias-label-secondary,#6b7280);cursor:pointer}'
      + '.cc-plan{margin:0;padding-left:16px;line-height:1.6}'
      + '.cc-plan li.done{color:#15803d}'
      + '.cc-plan li.now{font-weight:600}'
      + '.cc-hint{font-size:11px;color:var(--dsw-alias-label-secondary,#6b7280)}'

    var KIND_COLOR = {
      turn: '#2563eb', item: '#0f766e', delta: '#6b7280', plan: '#7c3aed',
      usage: '#0891b2', error: '#dc2626', approval: '#d97706', status: '#6b7280', session: '#334155', other: '#9ca3af'
    }

    var styled = false
    function ensureStyles() {
      if (styled || typeof document === 'undefined') return
      var el = document.createElement('style')
      el.setAttribute('data-codex-controller', '')
      el.textContent = CSS
      document.head.appendChild(el)
      styled = true
    }

    function fmtDur(ms) {
      if (!ms || ms < 0) return '0s'
      var s = Math.round(ms / 1000)
      if (s < 60) return s + 's'
      var m = Math.floor(s / 60)
      if (m < 60) return m + 'm' + String(s % 60).padStart(2, '0') + 's'
      return Math.floor(m / 60) + 'h' + String(m % 60).padStart(2, '0') + 'm'
    }

    function fmtTok(n) {
      if (!n) return '0'
      if (n >= 1000000) return (n / 1000000).toFixed(2) + 'M'
      if (n >= 1000) return (n / 1000).toFixed(1) + 'k'
      return String(n)
    }

    async function apiGet(path) {
      var res = await fetch(API + '/' + path, { headers: { accept: 'application/json' } })
      if (!res.ok) throw new Error('codex-controller ' + path + ': HTTP ' + res.status)
      return res.json()
    }
    async function apiPost(action, body) {
      var res = await fetch(API + '/' + action, {
        method: 'POST',
        headers: { 'content-type': 'application/json', accept: 'application/json' },
        body: JSON.stringify(body || {})
      })
      var data = null
      try { data = await res.json() } catch (e) { data = null }
      if (!res.ok) throw new Error((data && data.error) || ('codex-controller ' + action + ': HTTP ' + res.status))
      return data
    }

    function useLocale() {
      var svc = function () {
        try { return RUNTIME.ctx && RUNTIME.ctx.locale ? RUNTIME.ctx.locale : null } catch (e) { return null }
      }
      var subscribe = function (notify) {
        var s = svc()
        if (s && typeof s.subscribe === 'function') return s.subscribe(notify)
        if (typeof MutationObserver !== 'undefined' && typeof document !== 'undefined' && document.documentElement) {
          var obs = new MutationObserver(notify)
          obs.observe(document.documentElement, { attributes: true, attributeFilter: ['lang'] })
          return function () { obs.disconnect() }
        }
        return function () {}
      }
      var snapshot = function () {
        var s = svc()
        var active = s && typeof s.getLocale === 'function' ? (s.getLocale() || {}).active : ''
        if (active === 'zh' || active === 'en') return active
        var lang = (typeof document !== 'undefined' && document.documentElement && document.documentElement.lang) || 'zh'
        return String(lang).toLowerCase().indexOf('zh') === 0 ? 'zh' : 'en'
      }
      return React.useSyncExternalStore(subscribe, snapshot, snapshot)
    }

    function usePoll(fn, ms, deps) {
      var state = useState(null)
      var data = state[0]
      var setData = state[1]
      var errState = useState(null)
      var error = errState[0]
      var setError = errState[1]
      useEffect(function () {
        var alive = true
        var timer = null
        function tick() {
          Promise.resolve().then(fn).then(function (v) { if (alive) { setData(v); setError(null) } }, function (e) { if (alive) setError(String(e && e.message || e)) })
            .then(function () { if (alive) timer = setTimeout(tick, ms) })
        }
        tick()
        return function () { alive = false; if (timer) clearTimeout(timer) }
      }, deps || [])
      return [data, error, setData]
    }

    function Dot(props) {
      var cls = 'cc-dot' + (props.status === 'running' ? ' run' : props.status === 'error' ? ' err' : '')
      return h('span', { className: cls })
    }

    function Panel() {
      ensureStyles()
      var L = useLocale()
      var T = function (k, v) { return tr(L, k, v) }
      var statePair = usePoll(function () { return apiGet('state') }, 1500, [])
      var state = statePair[0]
      var pollErr = statePair[1]
      var eventsPair = usePoll(function () {
        var key = selectedRef.current
        return key ? apiGet('events?since=0&limit=120&session=' + encodeURIComponent(key)) : Promise.resolve({ events: [] })
      }, 1500, [])

      var selectedState = useState(null)
      var selected = selectedState[0]
      var setSelected = selectedState[1]
      var selectedRef = useRef(null)
      selectedRef.current = selected

      var promptState = useState('')
      var prompt = promptState[0]
      var setPrompt = promptState[1]
      var cwdState = useState('')
      var cwd = cwdState[0]
      var setCwd = cwdState[1]
      var modelState = useState('')
      var model = modelState[0]
      var setModel = modelState[1]
      var sandboxState = useState('workspace-write')
      var sandbox = sandboxState[0]
      var setSandbox = sandboxState[1]
      var errState = useState(null)
      var actionError = errState[0]
      var setActionError = errState[1]
      var busyState = useState(false)
      var busy = busyState[0]
      var setBusy = busyState[1]
      var docState = useState(null)
      var doc = docState[0]
      var setDoc = docState[1]
      var draftOpenState = useState(false)
      var draftOpen = draftOpenState[0]
      var setDraftOpen = draftOpenState[1]
      var goalState = useState('')
      var goal = goalState[0]
      var setGoal = goalState[1]
      var mustState = useState('')
      var must = mustState[0]
      var setMust = mustState[1]
      var acceptState = useState('')
      var accept = acceptState[0]
      var setAccept = acceptState[1]

      useEffect(function () {
        if (state && state.defaultCwd && !cwd) setCwd(state.defaultCwd)
      }, [state])

      useEffect(function () {
        if (!state || !state.sessions || !state.sessions.length) return
        if (!selected || !state.sessions.some(function (s) { return s.key === selected })) setSelected(state.sessions[0].key)
      }, [state])

      var sessions = (state && state.sessions) || []
      var current = sessions.filter(function (s) { return s.key === selected })[0] || sessions[0] || null
      var events = (eventsPair[0] && eventsPair[0].events) || []
      var ready = !!(state && state.ready)
      var canOpen = ready ? !!state : false

      function run(fn) {
        setBusy(true)
        setActionError(null)
        Promise.resolve().then(fn).then(function () { setBusy(false) }, function (e) { setBusy(false); setActionError(String(e && e.message || e)) })
      }

      function runDoctor() {
        setBusy(true)
        setActionError(null)
        apiGet('doctor').then(function (r) { setBusy(false); setDoc(r) }, function (e) {
          setBusy(false)
          setDoc({ ok: false, advice: [String(e && e.message || e)] })
        })
      }

      function openSession() {
        run(function () {
          return apiPost('open', { cwd: cwd || undefined, model: model || undefined, sandbox: sandbox }).then(function (res) {
            if (res && res.session && res.session.key) setSelected(res.session.key)
          })
        })
      }

      function send() {
        if (!current || !prompt.trim()) return
        run(function () {
          return apiPost('send', { session: current.key, text: prompt }).then(function () { setPrompt('') })
        })
      }

      function draft() {
        if (!goal.trim()) return
        run(function () {
          return apiPost('draft', { spec: { goal: goal, must: must, acceptance: accept } }).then(function (res) {
            if (res && res.prompt) setPrompt(res.prompt)
          })
        })
      }

      function reframeAndSend() {
        if (!current || !prompt.trim()) return
        run(function () {
          return apiPost('reframe', { text: prompt }).then(function (res) {
            if (!res || !res.prompt) throw new Error('reframe returned nothing')
            setPrompt(res.prompt)
            return apiPost('send', { session: current.key, text: res.prompt }).then(function () { setPrompt('') })
          })
        })
      }

      function interrupt() { if (current) run(function () { return apiPost('interrupt', { session: current.key }) }) }

      function closeSession() {
        if (!current) return
        run(function () {
          return apiPost('close', { session: current.key }).then(function () { setSelected(null) })
        })
      }

      var header = h('div', { className: 'cc-card' },
        h('div', { className: 'cc-row', style: { justifyContent: 'space-between' } },
          h('div', { className: 'cc-row' },
            h('b', null, T('title')),
            h(Dot, { status: ready ? 'idle' : 'error' }),
            h('span', { className: 'cc-dim cc-mono' }, ready ? T('ready') : T('off')),
            h('span', { className: 'cc-hint cc-mono' }, T('mode') + ': ' + ((state && state.mode) || '—') + ' (' + ((state && state.transport) || 'auto') + ')'),
            state && state.server && state.server.userAgent ? h('span', { className: 'cc-hint cc-mono' }, String(state.server.userAgent).slice(0, 60)) : null),
          h('div', { className: 'cc-row' },
            h('span', { className: 'cc-hint' }, T('poll')),
            h('button', { className: 'cc-btn', disabled: busy, title: T('docHint'), onClick: runDoctor }, T('doctor')),
            h('button', {
              className: 'cc-btn',
              disabled: busy,
              onClick: function () { run(function () { return ready ? apiPost('shutdown') : apiPost('open', { cwd: cwd || undefined }).then(function (r) { if (r && r.session && r.session.key) setSelected(r.session.key) }) }) }
            }, ready ? T('shutdown') : T('boot')))),
        h('div', { className: 'cc-hint', style: { marginTop: 4 } }, T('sub')),
        state && state.bin ? h('div', { className: 'cc-hint cc-mono' }, state.bin) : null,
        state && state.transportError ? h('div', { className: 'cc-hint', style: { color: '#d97706' } }, 'transport fallback: ' + state.transportError) : null,
        (statePair[1] || actionError) ? h('div', { className: 'cc-hint', style: { color: '#dc2626' } }, statePair[1] || actionError) : null,
        doc ? h('div', { style: { marginTop: 8 } },
          h('div', { className: 'cc-title' }, T('doctor') + ' — ' + (doc.ok ? T('docOk') : T('docBad'))),
          h('pre', { className: 'cc-pre' },
            'codex ' + ((doc.codex && doc.codex.version) || '?')
            + ' · app-server=' + (doc.codex && doc.codex.appServer ? 'yes' : 'no')
            + ' · exec --json=' + (doc.codex && doc.codex.execJson ? 'yes' : 'no')
            + ' · transport=' + ((doc.plugin && doc.plugin.mode) || '?')
            + (doc.codex && doc.codex.missingMethods && doc.codex.missingMethods.length ? '\nmissing: ' + doc.codex.missingMethods.join(', ') : '')
            + '\n' + ((doc.advice || []).join('\n')))) : null)

      var openRow = h('div', { className: 'cc-card' },
        h('div', { className: 'cc-row' },
          h('span', { className: 'cc-hint' }, T('cwd')),
          h('input', { className: 'cc-input', style: { flex: '1 1 240px' }, value: cwd, placeholder: state ? state.defaultCwd : '', onChange: function (e) { setCwd(e.target.value) } }),
          h('span', { className: 'cc-hint' }, T('model')),
          h('input', { className: 'cc-input', style: { width: 150 }, value: model, placeholder: state && state.defaults && state.defaults.model ? state.defaults.model : 'default', onChange: function (e) { setModel(e.target.value) } }),
          h('select', { className: 'cc-select', value: sandbox, onChange: function (e) { setSandbox(e.target.value) } }, ((state && state.sandboxModes) || ['workspace-write']).map(function (m) { return h('option', { key: m, value: m }, m) })),
          h('button', { className: 'cc-btn primary', disabled: busy || !canOpen, onClick: openSession }, T('open'))))

      var list = h('div', { className: 'cc-card' },
        h('div', { className: 'cc-title' }, T('sessions') + ' (' + sessions.length + ')'),
        sessions.length === 0 ? h('div', { className: 'cc-dim' }, T('noSession')) :
          h('div', { className: 'cc-row' }, sessions.map(function (s) {
            return h('button', {
              key: s.key,
              className: 'cc-chip' + (current && current.key === s.key ? ' active' : ''),
              onClick: function () { setSelected(s.key) }
            },
              h(Dot, { status: s.status }),
              h('span', { className: 'cc-mono' }, s.key),
              h('span', { className: 'cc-dim' }, s.status))
          })))

      var detail = current ? h('div', { className: 'cc-card' },
        h('div', { className: 'cc-row', style: { justifyContent: 'space-between' } },
          h('div', { className: 'cc-row' },
            h('span', { className: 'cc-mono' }, current.key),
            h('span', { className: 'cc-dim cc-mono' }, current.threadId),
            h('span', { className: 'cc-dim' }, current.status + (current.turnStatus ? ' · ' + current.turnStatus : ''))),
          h('div', { className: 'cc-row' },
            h('button', { className: 'cc-btn', disabled: busy || current.status !== 'running', onClick: interrupt }, T('interrupt')),
            h('button', { className: 'cc-btn', disabled: busy, onClick: closeSession }, T('close')))),
        h('div', { className: 'cc-grid', style: { marginTop: 8 } },
          kpi(T('elapsed'), current.status === 'running' ? fmtDur(current.elapsedMs) : fmtDur(current.idleMs) + ' idle'),
          kpi(T('tokens'), fmtTok((current.usage && current.usage.totalTokens) || 0)),
          kpi('items', String((current.counters && current.counters.items) || 0)),
          kpi('cmd/file', String((current.counters && current.counters.commands) || 0) + '/' + String((current.counters && current.counters.files) || 0)),
          kpi(T('events'), String(current.eventCount || 0)),
          kpi('plan', current.planProgress || '—')),
        current.current ? h('div', { style: { marginTop: 8 } }, h('span', { className: 'cc-title' }, T('current')), h('div', { className: 'cc-mono' }, current.current.kind + ' — ' + current.current.label)) : null,
        (current.plan && current.plan.length) ? h('div', { style: { marginTop: 8 } },
          h('div', { className: 'cc-title' }, T('plan')),
          h('ul', { className: 'cc-plan' }, current.plan.map(function (p, i) {
            var st = String(p.status || '')
            var cls = /completed|done/i.test(st) ? 'done' : /progress|active/i.test(st) ? 'now' : ''
            return h('li', { key: i, className: cls }, p.step + (st ? '  (' + st + ')' : ''))
          }))) : null,
        current.streaming ? h('div', { style: { marginTop: 8 } }, h('div', { className: 'cc-title' }, T('streaming')), h('pre', { className: 'cc-pre' }, current.streaming)) : null,
        current.lastMessage ? h('div', { style: { marginTop: 8 } }, h('div', { className: 'cc-title' }, T('lastMsg')), h('pre', { className: 'cc-pre' }, current.lastMessage)) : null,
        current.commandOutput ? h('div', { style: { marginTop: 8 } }, h('div', { className: 'cc-title' }, T('cmdOut')), h('pre', { className: 'cc-pre' }, current.commandOutput)) : null,
        (current.lastError || current.pendingApproval) ? h('div', { className: 'cc-hint', style: { marginTop: 8, color: '#dc2626' } },
          T('err') + ': ' + (current.lastError || (current.pendingApproval && (current.pendingApproval.command || current.pendingApproval.method)))) : null,
        current.lastRefusal && current.refusalActive !== false ? h('div', { style: { marginTop: 8, border: '1px solid #f59e0b', borderRadius: 8, padding: '6px 9px' } },
          h('div', { className: 'cc-title', style: { marginBottom: 2 } }, T('refusal') + ' (x' + (current.refusalCount || 1) + ')'),
          h('pre', { className: 'cc-pre' }, String(current.lastRefusal.text || '').slice(0, 500)),
          h('div', { className: 'cc-row', style: { marginTop: 6 } },
            h('button', { className: 'cc-btn', disabled: busy || !prompt.trim(), onClick: reframeAndSend }, T('reframe')),
            h('span', { className: 'cc-hint' }, T('refusalHint')))) : null,
        h('div', { style: { marginTop: 10 } },
          h('div', { className: 'cc-title' }, T('events')),
          h('div', { className: 'cc-evlog' }, events.length === 0 ? h('div', { className: 'cc-dim' }, T('empty')) :
            events.slice().reverse().map(function (e) {
              return h('div', { className: 'cc-evline', key: e.seq },
                h('span', { className: 'cc-dim cc-mono' }, '#' + e.seq),
                h('span', { className: 'cc-mono', style: { color: KIND_COLOR[e.kind] || '#6b7280' } }, e.kind),
                h('span', { className: 'cc-dim cc-mono' }, String(e.type || '')),
                h('span', null, String(e.text || '').slice(0, 300)))
            })))
      ) : null

      var composer = h('div', { className: 'cc-card' },
        h('div', { className: 'cc-row', style: { justifyContent: 'space-between' } },
          h('div', { className: 'cc-title', style: { marginBottom: 0 } }, T('message')),
          h('div', { className: 'cc-row' },
            h('button', { className: 'cc-btn', onClick: function () { setDraftOpen(!draftOpen) } }, (draftOpen ? '− ' : '+ ') + T('draft')),
            h('button', { className: 'cc-btn primary', disabled: busy || !current || !prompt.trim(), onClick: send }, T('send')))),
        draftOpen ? h('div', { style: { marginTop: 8, display: 'flex', flexDirection: 'column', gap: 6 } },
          h('span', { className: 'cc-hint' }, T('goal')),
          h('input', { className: 'cc-input', value: goal, onChange: function (e) { setGoal(e.target.value) } }),
          h('span', { className: 'cc-hint' }, T('must')),
          h('textarea', { className: 'cc-area', rows: 2, value: must, onChange: function (e) { setMust(e.target.value) } }),
          h('span', { className: 'cc-hint' }, T('accept')),
          h('textarea', { className: 'cc-area', rows: 2, value: accept, onChange: function (e) { setAccept(e.target.value) } }),
          h('button', { className: 'cc-btn', disabled: busy || !goal.trim(), onClick: draft }, T('makePrompt'))) : null,
        h('textarea', {
          className: 'cc-area',
          style: { marginTop: 8 },
          rows: 4,
          placeholder: T('promptHint'),
          value: prompt,
          onChange: function (e) { setPrompt(e.target.value) },
          onKeyDown: function (e) { if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) send() }
        }))

      return h('div', { className: 'cc-wrap' }, header, openRow, list, detail, composer)
    }

    function kpi(label, value) {
      return h('div', { className: 'cc-kpi', key: label + String(value) }, h('b', null, String(value)), h('span', null, label))
    }

    function Pill() {
      ensureStyles()
      var L = useLocale()
      var T = function (k, v) { return tr(L, k, v) }
      var pair = usePoll(function () { return apiGet('state') }, 3000, [])
      var state = pair[0]
      if (!state) return null
      var sessions = state.sessions || []
      var running = sessions.filter(function (s) { return s.status === 'running' }).length
      var label = !state.ready ? T('pillOff') : running > 0 ? T('pillRunning', { n: sessions.length, m: running }) : T('pillIdle', { n: sessions.length })
      return h('div', { className: 'cc-pill', style: { display: 'flex', alignItems: 'center', gap: 6 } },
        h(Dot, { status: !state.ready ? 'error' : running > 0 ? 'running' : 'idle' }),
        h('span', null, 'codex · ' + label))
    }

    function apply(ctx) {
      RUNTIME.ctx = ctx
      if (!ctx || !ctx.slots) return
      ctx.slots.inject('settings.section', function () {
        ctx.slots.register({ name: 'settings.section', id: 'codex-controller', order: 440, label: 'Codex 控制器' }, function () { return h(Panel) })
      })
      ctx.slots.inject('conversation.composer.dock', function () {
        ctx.slots.register({ name: 'conversation.composer.dock', id: 'codex-controller-pill', order: 86 }, function () { return h(Pill) })
      })
    }

    module.exports = { inject: ['slots', 'locale'], apply: apply }
    return module.exports
  }
})
