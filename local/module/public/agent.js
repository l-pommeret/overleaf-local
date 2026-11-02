// Onglet « Agent » de l'éditeur, aux couleurs de pi-aristote : pi interactif dans un vrai
// terminal, sur une copie du projet tenue à jour dans les deux sens. Le pont local
// (local/bridge/agent-bridge.mjs) fait tourner pi sur le Mac.
;(function () {
  const CONFIG = window.OL_LOCAL_AGENT || {}
  const match = location.pathname.match(/^\/project\/([0-9a-f]{24})/)
  if (!match) return
  const PROJECT_ID = match[1]
  const PI_INSTALL = 'curl -fsSL https://raw.githubusercontent.com/l-pommeret/pi-aristote/main/install.sh | sh'
  const XTERM = 'https://cdn.jsdelivr.net/npm/@xterm/xterm@5.5.0'
  const XTERM_FIT = 'https://cdn.jsdelivr.net/npm/@xterm/addon-fit@0.10.0'
  const STORE = { model: 'ol-agent-model', width: 'ol-agent-width' }
  const SYNC_EVERY = 3000

  const store = {
    get: k => {
      try {
        return localStorage.getItem(k)
      } catch {
        return null
      }
    },
    set: (k, v) => {
      try {
        localStorage.setItem(k, v)
      } catch {}
    },
  }

  // -------------------------------------------------------- journal de compilation
  // On observe les compilations d'Overleaf pour donner leur journal à l'agent
  // (.overleaf/output.log dans sa copie du projet).
  const nativeFetch = window.fetch.bind(window)
  window.fetch = async function (input, init) {
    const res = await nativeFetch(input, init)
    try {
      const url = typeof input === 'string' ? input : input.url
      if (/\/project\/[0-9a-f]{24}\/compile\b/.test(url) && res.ok) {
        res
          .clone()
          .json()
          .then(data => {
            const log = (data.outputFiles || []).find(f => f.path === 'output.log')
            if (log) return nativeFetch(log.url, { credentials: 'same-origin' }).then(r => r.text())
          })
          .then(text => text && bridge('/log', { projectId: PROJECT_ID, text }).catch(() => {}))
          .catch(() => {})
      }
    } catch {}
    return res
  }

  // -------------------------------------------------------- outils

  const h = (tag, attrs = {}, ...children) => {
    const el = document.createElement(tag)
    for (const [k, v] of Object.entries(attrs)) {
      if (v == null || v === false) continue
      if (k === 'class') el.className = v
      else if (k.startsWith('on')) el.addEventListener(k.slice(2), v)
      else el.setAttribute(k, v === true ? '' : v)
    }
    for (const c of children) if (c != null) el.append(c)
    return el
  }

  function bridge(path, body) {
    return nativeFetch(CONFIG.url + path, {
      method: body ? 'POST' : 'GET',
      headers: { 'X-Agent-Token': CONFIG.token || '', ...(body ? { 'Content-Type': 'application/json' } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    })
  }

  async function jsonOrThrow(r) {
    if (r.ok) return r.json()
    let msg = r.status
    try {
      msg = (await r.json()).error || msg
    } catch {}
    throw new Error(msg)
  }

  const toBase64 = blob =>
    new Promise((resolve, reject) => {
      const reader = new FileReader()
      reader.onload = () => resolve(String(reader.result).split(',')[1] || '')
      reader.onerror = () => reject(reader.error)
      reader.readAsDataURL(blob)
    })

  function loadScript(src) {
    return new Promise((resolve, reject) => {
      const s = h('script', { src })
      s.onload = resolve
      s.onerror = () => reject(new Error('chargement impossible : ' + src))
      document.head.append(s)
    })
  }

  // -------------------------------------------------------- synchronisation

  let syncing = null
  let syncTimer = null
  let lastSyncOk = false

  async function sync() {
    if (syncing) return syncing
    syncing = (async () => {
      const snap = await jsonOrThrow(
        await nativeFetch(`/ol-local/project/${PROJECT_ID}/snapshot`, { credentials: 'same-origin' })
      )
      const { need } = await jsonOrThrow(await bridge('/sync', { projectId: PROJECT_ID, ...snap }))
      for (const f of need) {
        const r = await nativeFetch(`/Project/${PROJECT_ID}/file/${f.id}`, { credentials: 'same-origin' })
        if (!r.ok) continue
        await bridge('/sync-file', { projectId: PROJECT_ID, path: f.path, hash: f.hash, base64: await toBase64(await r.blob()) })
      }
      lastSyncOk = true
      updateFooter()
    })()
      .catch(err => {
        lastSyncOk = false
        updateFooter(err.message)
        throw err
      })
      .finally(() => (syncing = null))
    return syncing
  }

  function startSyncLoop() {
    if (syncTimer) return
    syncTimer = setInterval(() => {
      if (!document.hidden) sync().catch(() => {})
    }, SYNC_EVERY)
  }

  async function writeFile(file) {
    const csrf = document.querySelector('meta[name="ol-csrfToken"]')?.content || ''
    const r = await nativeFetch(`/ol-local/project/${PROJECT_ID}/file`, {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json', 'X-Csrf-Token': csrf },
      body: JSON.stringify(file),
    })
    await jsonOrThrow(r)
  }

  let recompileTimer = null
  function recompileSoon() {
    clearTimeout(recompileTimer)
    recompileTimer = setTimeout(() => {
      const btn = [...document.querySelectorAll('button')].find(b =>
        /^(Recompile|Recompiler|Compile|Compiler)$/i.test(b.textContent.trim())
      )
      btn?.click()
    }, 1500)
  }

  // Écrit dans Overleaf les fichiers modifiés par pi et le signale dans le terminal.
  async function applyFiles({ changed = [], deleted = [] }) {
    const done = []
    for (const f of changed) {
      try {
        await writeFile(f)
        done.push(f.path)
      } catch (err) {
        flash(`✗ ${f.path} : ${err.message}`, true)
      }
    }
    if (done.length) {
      flash('σ ' + done.join(', ') + ' → Overleaf')
      recompileSoon()
    }
    for (const p of deleted) flash(`δ ${p} : supprimé par l’agent, gardé dans Overleaf`, true)
  }

  // -------------------------------------------------------- panneau

  let panel, modelSelect, footer, tabBtn, termView
  let info = null

  function buildPanel() {
    modelSelect = h('select', { class: 'ol-agent-model', title: 'Modèle Aristote (pris en compte à la prochaine conversation)' })
    modelSelect.addEventListener('change', () => {
      store.set(STORE.model, modelSelect.value)
      updateFooter()
    })
    termView = h('section', { class: 'ol-agent-view ol-agent-term' })

    const grip = h('div', { class: 'ol-agent-grip', title: 'Élargir' })
    grip.addEventListener('pointerdown', e => {
      e.preventDefault()
      grip.setPointerCapture(e.pointerId)
      const move = ev => {
        const w = Math.min(Math.max(window.innerWidth - ev.clientX, 320), window.innerWidth - 120)
        panel.style.width = w + 'px'
      }
      const up = () => {
        grip.removeEventListener('pointermove', move)
        store.set(STORE.width, parseInt(panel.style.width, 10))
        fitTerm()
      }
      grip.addEventListener('pointermove', move)
      grip.addEventListener('pointerup', up, { once: true })
    })

    footer = h('footer', { class: 'ol-agent-foot' })
    panel = h(
      'aside',
      { class: 'ol-agent', hidden: true },
      grip,
      h(
        'header',
        { class: 'ol-agent-head' },
        h('span', { class: 'ol-agent-alpha' }, 'α'),
        h('span', { class: 'ol-agent-brand' }, h('strong', {}, 'Agent'), h('small', {}, 'pi-aristote')),
        modelSelect,
        h('button', { class: 'ol-agent-icon', title: 'Nouvelle conversation', onclick: () => restartTerminal(true) }, 'ν'),
        h('button', { class: 'ol-agent-icon', title: 'Fermer', onclick: toggle }, '×')
      ),
      termView,
      footer
    )
    const width = Number(store.get(STORE.width))
    if (width) panel.style.width = width + 'px'
    // Les raccourcis de l'éditeur ne doivent pas voir les frappes destinées à l'agent.
    for (const type of ['keydown', 'keypress', 'keyup']) panel.addEventListener(type, e => e.stopPropagation())
    document.body.append(panel)
    updateFooter()
  }

  function updateFooter(error) {
    if (!footer) return
    const model = modelSelect?.value ? 'aristote/' + modelSelect.value : info?.pi ? 'modèle par défaut' : '—'
    footer.replaceChildren(
      h('span', { class: error ? 'ol-agent-foot-ko' : lastSyncOk ? 'ol-agent-foot-ok' : '' }, h('b', {}, 'Φ '), error ? 'synchro : ' + error : lastSyncOk ? 'projet synchronisé' : 'synchro en attente'),
      h('span', {}, h('b', {}, 'π '), model)
    )
  }

  async function checkBridge() {
    try {
      const r = await bridge('/health')
      if (r.status === 403) throw new Error('jeton')
      info = await r.json()
    } catch (err) {
      info = null
      note(
        err.message === 'jeton'
          ? 'Le pont de l’agent refuse la connexion (jeton différent). Relance Overleaf dans le Terminal du Mac :'
          : 'Le pont de l’agent ne répond pas. Relance Overleaf dans le Terminal du Mac :',
        'overleaf'
      )
      return false
    }
    if (!info.pi) {
      note('pi n’est pas installé sur ce Mac. Dans le Terminal :', PI_INSTALL)
      return false
    }
    const saved = store.get(STORE.model)
    modelSelect.replaceChildren(
      ...(info.models.length ? info.models.map(m => h('option', { value: m }, m)) : [h('option', { value: '' }, 'modèle par défaut')])
    )
    modelSelect.value = info.models.includes(saved) ? saved : info.model || ''
    updateFooter()
    startSyncLoop()
    return true
  }

  function note(text, code) {
    const el = h('div', { class: 'ol-agent-note ol-agent-error' }, text)
    if (code) el.append(h('code', {}, code))
    el.append(h('button', { class: 'ol-agent-btn ol-agent-retry', onclick: () => { info = null; termView.replaceChildren(); start() } }, 'Réessayer'))
    termView.replaceChildren(el)
  }

  async function start() {
    if (!info && !(await checkBridge())) return
    openTerminal()
  }

  function toggle() {
    if (!panel) buildPanel()
    const open = panel.hidden
    panel.hidden = !open
    tabBtn?.classList.toggle('active', open)
    if (open) start()
  }

  // -------------------------------------------------------- terminal

  let term = null
  let fit = null
  let ws = null
  let exited = false
  let restarting = false // nouvelle conversation demandée : la fin de l'ancien pi est attendue

  const THEME = {
    background: '#141538',
    foreground: '#e9eaf5',
    cursor: '#F2BC3C',
    cursorAccent: '#141538',
    selectionBackground: 'rgba(26, 140, 166, 0.45)',
    black: '#1d1f4a',
    red: '#e5484d',
    green: '#4fb286',
    yellow: '#F2BC3C',
    blue: '#1A8CA6',
    magenta: '#b58ad6',
    cyan: '#5cc3d6',
    white: '#d9dbea',
    brightBlack: '#5a5d8a',
    brightRed: '#ff6b70',
    brightGreen: '#6fd3a4',
    brightYellow: '#ffd36b',
    brightBlue: '#3fb1cc',
    brightMagenta: '#d0a8ef',
    brightCyan: '#86dcea',
    brightWhite: '#ffffff',
  }

  async function openTerminal() {
    if (term) {
      fitTerm()
      term.focus()
      return
    }
    termView.replaceChildren(h('div', { class: 'ol-agent-note' }, 'τ ouverture du terminal…'))
    try {
      document.head.append(h('link', { rel: 'stylesheet', href: XTERM + '/css/xterm.css' }))
      await loadScript(XTERM + '/lib/xterm.js')
      await loadScript(XTERM_FIT + '/lib/addon-fit.js')
      await sync()
    } catch (err) {
      termView.replaceChildren(h('div', { class: 'ol-agent-note ol-agent-error' }, 'Terminal indisponible : ' + err.message))
      return
    }
    const host = h('div', { class: 'ol-agent-xterm' })
    termView.replaceChildren(host)
    term = new window.Terminal({
      theme: THEME,
      fontFamily: '"JetBrains Mono", "SF Mono", Menlo, Monaco, monospace',
      fontSize: 13,
      lineHeight: 1.15,
      cursorBlink: true,
      allowProposedApi: true,
      scrollback: 5000,
    })
    fit = new window.FitAddon.FitAddon()
    term.loadAddon(fit)
    term.open(host)
    fit.fit()
    term.onData(d => {
      if (exited) {
        if (d === '\r') restartTerminal(false)
        return
      }
      wsSend({ t: 'i', d })
    })
    term.onResize(({ cols, rows }) => wsSend({ t: 'r', cols, rows }))
    new ResizeObserver(() => fitTerm()).observe(host)
    connect()
    term.focus()
  }

  function connect(fresh = false) {
    const u = new URL(CONFIG.url.replace(/^http/, 'ws') + '/pty')
    if (fresh) u.searchParams.set('fresh', '1')
    u.searchParams.set('project', PROJECT_ID)
    u.searchParams.set('token', CONFIG.token || '')
    u.searchParams.set('cols', term.cols)
    u.searchParams.set('rows', term.rows)
    if (modelSelect.value) u.searchParams.set('model', modelSelect.value)
    exited = false
    ws = new WebSocket(u)
    ws.onmessage = async ev => {
      const msg = JSON.parse(ev.data)
      if (msg.t === 'o') term.write(msg.d)
      else if (msg.t === 'exit') {
        if (restarting) {
          restarting = false
          return
        }
        exited = true
        term.write('\r\n\x1b[38;2;242;188;60mπ s’est arrêté — Entrée pour relancer.\x1b[0m\r\n')
      } else if (msg.t === 'files') {
        await applyFiles(msg)
        const names = msg.changed.map(f => f.path)
        if (names.length) flash('σ ' + names.join(', ') + ' → Overleaf')
      }
    }
    ws.onclose = () => {
      if (exited) return
      exited = true
      // Mise en veille, redémarrage du pont… : on se reconnecte (pi reprend sa session).
      term?.write('\r\n\x1b[38;2;224;122;69mConnexion au pont perdue, reconnexion…\x1b[0m\r\n')
      setTimeout(function retry() {
        if (!exited || ws?.readyState === WebSocket.OPEN || ws?.readyState === WebSocket.CONNECTING) return
        if (document.hidden) return setTimeout(retry, 2000)
        sync()
          .then(connect)
          .catch(() => setTimeout(retry, 3000))
      }, 1500)
    }
  }

  function wsSend(obj) {
    if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify(obj))
  }

  function restartTerminal(fresh) {
    if (!term) return
    if (fresh) term.reset()
    restarting = fresh && !exited && ws?.readyState === WebSocket.OPEN
    if (ws?.readyState === WebSocket.OPEN) wsSend({ t: 'restart', fresh, cols: term.cols, rows: term.rows, model: modelSelect.value })
    else connect(fresh)
    exited = false
    term.focus()
  }

  function fitTerm() {
    if (term && fit && !panel.hidden) {
      try {
        fit.fit()
      } catch {}
    }
  }

  function flash(text, warn = false) {
    const el = h('div', { class: 'ol-agent-flash' + (warn ? ' ol-agent-flash-warn' : '') }, text)
    termView.append(el)
    setTimeout(() => el.remove(), warn ? 6000 : 2500)
  }

  // -------------------------------------------------------- onglet de la barre latérale

  function addTab() {
    const nav = document.querySelector('.ide-rail-tabs-wrapper') || document.querySelector('.ide-rail-tabs-nav')
    if (!nav) return
    if (document.querySelector('.ol-agent-tab')) return
    tabBtn = h(
      'button',
      { type: 'button', class: 'ide-rail-tab-link nav-link ol-agent-tab', title: 'Agent (pi-aristote)', 'aria-label': 'Agent', onclick: toggle },
      h('span', { class: 'ol-agent-tab-icon' }, 'α')
    )
    if (panel && !panel.hidden) tabBtn.classList.add('active')
    nav.append(tabBtn)
    document.querySelector('.ol-agent-fab')?.remove()
  }

  function boot() {
    // L'éditeur est rendu par React : on attend la barre latérale et on la surveille
    // (elle peut être recréée) ; à défaut, un bouton flottant.
    new MutationObserver(addTab).observe(document.body, { childList: true, subtree: true })
    addTab()
    setTimeout(() => {
      if (!document.querySelector('.ol-agent-tab')) {
        tabBtn = h('button', { type: 'button', class: 'ol-agent-fab', title: 'Agent', onclick: toggle }, h('b', {}, 'α'), ' Agent')
        document.body.append(tabBtn)
      }
    }, 8000)
    window.addEventListener('resize', fitTerm)
  }

  if (document.body) boot()
  else document.addEventListener('DOMContentLoaded', boot)
})()
