#!/usr/bin/env node
// Pont entre l'onglet Agent d'Overleaf (navigateur) et pi (pi-aristote) sur le Mac.
//
// Chaque projet a une copie de travail dans ~/.overleaf-local/agent/projects/<id>,
// synchronisée dans les deux sens avec Overleaf :
//   - Overleaf → copie : le navigateur envoie régulièrement un instantané (POST /sync) ;
//   - copie → Overleaf : les fichiers que pi modifie sont renvoyés au navigateur, qui les
//     écrit dans le projet.
// pi tourne en interactif dans un pseudo-terminal, relié à l'onglet par WebSocket (/pty).
// Aucune dépendance : Node ≥ 18, python3 et la bibliothèque standard suffisent.
import http from 'node:http'
import fs from 'node:fs'
import os from 'node:os'
import Path from 'node:path'
import crypto from 'node:crypto'
import { spawn, execFile } from 'node:child_process'
import { StringDecoder } from 'node:string_decoder'
import { fileURLToPath } from 'node:url'

const HERE = Path.dirname(fileURLToPath(import.meta.url))
const HOME = Path.join(os.homedir(), '.overleaf-local')
const ROOT = Path.join(HOME, 'agent')
const PORT = Number(process.env.OL_AGENT_PORT || 8765)
const TOKEN = (process.env.OL_AGENT_TOKEN || readOr(Path.join(HOME, 'agent-token'), '')).trim()
const PREFERRED = ['qwen-3.6-35b-instruct', 'qwen-3.8-27b', 'gemma-4-31b', 'mistral-small-4-119b']
const MAX_BODY = 200 * 1024 * 1024
const TEXT_EXT = new Set(
  'tex latex ltx sty cls clo def ldf fd cfg bst bib bibtex bbx cbx lbx dtx ins ist txt md rmd rnw rtex tikz pgf mtx asy gv lua mf m yml yaml json csv tsv xml svg lco inc xmpdata'.split(' ')
)
// Fichiers produits par une compilation locale : jamais envoyés à Overleaf s'ils sont nouveaux.
const ARTIFACT = /\.(aux|log|out|toc|lof|lot|fls|fdb_latexmk|synctex(\.gz)?|bcf|run\.xml|blg|nav|snm|vrb|xdv|dvi)$/i

const CONTEXT = [
  'You are the agent of "Overleaf de YomYom", a local Overleaf running on this Mac.',
  "The current directory is a live copy of the user's Overleaf project: files you write appear in the Overleaf editor within seconds, and the user's edits in Overleaf reach this directory.",
  'Overleaf compiles the PDF itself after your changes; the log of the latest Overleaf compile is .overleaf/output.log (read it to fix compile errors).',
  'Deleting a file here does not delete it in Overleaf.',
]
const SYSTEM_TERM = [
  ...CONTEXT,
  'Never write build artefacts (aux, log, pdf…) here: if you compile locally, use a temporary output directory (latexmk -outdir=/tmp/…).',
  "Answer in the user's language.",
].join(' ')

process.env.PATH = [
  process.env.PATH,
  '/opt/homebrew/bin',
  '/usr/local/bin',
  Path.join(os.homedir(), '.local/bin'),
  Path.join(os.homedir(), '.npm-global/bin'),
].join(':')

function readOr(file, fallback) {
  try {
    return fs.readFileSync(file, 'utf8')
  } catch {
    return fallback
  }
}

function run(cmd, args, opts = {}) {
  return new Promise(resolve =>
    execFile(cmd, args, { timeout: 30000, maxBuffer: 4 << 20, ...opts }, (err, stdout, stderr) =>
      resolve({ err, stdout: String(stdout), stderr: String(stderr) })
    )
  )
}

let modelsCache = null
async function piInfo() {
  if (modelsCache && Date.now() - modelsCache.at < 10 * 60 * 1000) return modelsCache
  const version = await run('pi', ['--version'])
  if (version.err) return { pi: null, models: [], model: null, at: 0 }
  const list = await run('pi', ['--list-models', 'aristote', '--offline'])
  const models = list.stdout
    .split('\n')
    .map(l => l.trim().split(/\s+/))
    .filter(cols => cols[0] === 'aristote' && cols[1])
    .map(cols => cols[1])
  const wanted = process.env.OL_AGENT_MODEL
  const model =
    (wanted && models.includes(wanted) && wanted) || PREFERRED.find(m => models.includes(m)) || models[0] || null
  modelsCache = { pi: version.stdout.trim(), models, model, at: Date.now() }
  return modelsCache
}

// ---------------------------------------------------------------- copie de travail

// Empreinte « blob » de git : celle qu'Overleaf donne à ses fichiers binaires.
const gitHash = buf =>
  crypto.createHash('sha1').update(`blob ${buf.length}\0`).update(buf).digest('hex')

const projects = new Map()

function project(id) {
  if (!/^[0-9a-f]{24}$/.test(id || '')) throw Object.assign(new Error('projet invalide'), { status: 400 })
  let p = projects.get(id)
  if (!p) {
    p = {
      id,
      dir: Path.join(ROOT, 'projects', id),
      sessions: Path.join(ROOT, 'sessions', id),
      base: new Map(), // chemin -> empreinte au dernier accord avec Overleaf
      synced: false,
      sockets: new Set(),
      pty: null,
      watcher: null,
      timer: null,
    }
    fs.mkdirSync(p.dir, { recursive: true })
    fs.mkdirSync(p.sessions, { recursive: true })
    projects.set(id, p)
  }
  return p
}

function safeJoin(dir, rel) {
  const full = Path.join(dir, rel)
  if (!full.startsWith(dir + Path.sep)) throw new Error('chemin invalide : ' + rel)
  return full
}

function localHash(p, rel) {
  try {
    return gitHash(fs.readFileSync(safeJoin(p.dir, rel)))
  } catch {
    return null
  }
}

function writeLocal(p, rel, buf) {
  const full = safeJoin(p.dir, rel)
  fs.mkdirSync(Path.dirname(full), { recursive: true })
  fs.writeFileSync(full, buf)
}

function walk(dir, base = dir, out = []) {
  let entries = []
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true })
  } catch {
    return out
  }
  for (const entry of entries) {
    if (entry.name.startsWith('.') || entry.name === 'node_modules') continue
    const full = Path.join(dir, entry.name)
    if (entry.isDirectory()) walk(full, base, out)
    else if (entry.isFile()) out.push(Path.relative(base, full).split(Path.sep).join('/'))
  }
  return out
}

// Overleaf → copie. Une modification locale pas encore renvoyée l'emporte (elle sera
// envoyée juste après) ; au premier passage, Overleaf fait foi.
function applySnapshot(p, { docs = {}, files = {} }) {
  const need = []
  const remote = new Map()
  for (const [rel, text] of Object.entries(docs)) remote.set(rel, { buf: Buffer.from(text, 'utf8') })
  for (const [rel, f] of Object.entries(files)) remote.set(rel, { hash: f.hash, id: f.id })
  for (const [rel, r] of remote) {
    const hash = r.hash || gitHash(r.buf)
    const base = p.base.get(rel)
    const local = localHash(p, rel)
    if (local === hash) {
      p.base.set(rel, hash)
      continue
    }
    if (p.synced && hash === base) continue // seule la copie locale a changé
    if (p.synced && local !== null && local !== (base ?? null)) continue // conflit : on garde le local
    if (r.buf) {
      writeLocal(p, rel, r.buf)
      p.base.set(rel, hash)
    } else {
      // ancienne version locale : l'effacer en attendant la bonne, sinon elle repartirait vers Overleaf
      if (local !== null) fs.rmSync(safeJoin(p.dir, rel), { force: true })
      need.push({ path: rel, id: r.id, hash })
    }
  }
  for (const rel of [...p.base.keys()]) {
    if (remote.has(rel)) continue
    if (localHash(p, rel) === p.base.get(rel)) fs.rmSync(safeJoin(p.dir, rel), { force: true })
    p.base.delete(rel)
  }
  if (!p.synced) {
    for (const rel of walk(p.dir)) if (!remote.has(rel)) fs.rmSync(safeJoin(p.dir, rel), { force: true })
    p.synced = true
  }
  return need
}

function applyRemoteFile(p, rel, base64, hash) {
  const local = localHash(p, rel)
  const base = p.base.get(rel) ?? null
  if (local !== null && local !== base) return
  const buf = Buffer.from(base64, 'base64')
  writeLocal(p, rel, buf)
  p.base.set(rel, hash || gitHash(buf))
}

function encodeFile(p, rel) {
  const buf = fs.readFileSync(safeJoin(p.dir, rel))
  const ext = Path.extname(rel).slice(1).toLowerCase()
  if (TEXT_EXT.has(ext)) {
    const text = buf.toString('utf8')
    if (!text.includes('�')) return { path: rel, text }
  }
  return { path: rel, base64: buf.toString('base64') }
}

// copie → Overleaf : ce qui a changé depuis le dernier accord.
function localChanges(p) {
  if (!p.synced) return { changed: [], deleted: [] }
  const changed = []
  const present = new Set(walk(p.dir))
  for (const rel of present) {
    const base = p.base.get(rel)
    if (base === undefined && ARTIFACT.test(rel)) continue
    if (base === undefined && /\.pdf$/i.test(rel) && present.has(rel.replace(/\.pdf$/i, '.tex'))) continue
    const hash = localHash(p, rel)
    if (hash && hash !== base) {
      try {
        changed.push(encodeFile(p, rel))
        p.base.set(rel, hash)
      } catch {}
    }
  }
  const deleted = [...p.base.keys()].filter(rel => !present.has(rel))
  for (const rel of deleted) p.base.delete(rel)
  return { changed, deleted }
}

function pushChanges(p) {
  const { changed, deleted } = localChanges(p)
  if (changed.length || deleted.length) broadcast(p, { t: 'files', changed, deleted })
}

function watch(p) {
  if (p.watcher) return
  try {
    p.watcher = fs.watch(p.dir, { recursive: true }, (_e, name) => {
      if (name && String(name).split(Path.sep).some(part => part.startsWith('.'))) return
      clearTimeout(p.timer)
      p.timer = setTimeout(() => pushChanges(p), 600)
    })
  } catch {}
}

function unwatch(p) {
  p.watcher?.close()
  p.watcher = null
  clearTimeout(p.timer)
}

// ---------------------------------------------------------------- terminal (WebSocket)

function wsSend(socket, obj) {
  if (socket.destroyed) return
  const payload = Buffer.from(JSON.stringify(obj), 'utf8')
  const len = payload.length
  const head = len < 126 ? Buffer.from([0x81, len]) : len < 65536 ? Buffer.alloc(4) : Buffer.alloc(10)
  if (len >= 126 && len < 65536) {
    head[0] = 0x81
    head[1] = 126
    head.writeUInt16BE(len, 2)
  } else if (len >= 65536) {
    head[0] = 0x81
    head[1] = 127
    head.writeBigUInt64BE(BigInt(len), 2)
  }
  socket.write(Buffer.concat([head, payload]))
}

function broadcast(p, obj) {
  for (const s of p.sockets) wsSend(s, obj)
}

function wsFrames(socket, onMessage) {
  let buf = Buffer.alloc(0)
  let parts = []
  socket.on('data', chunk => {
    buf = Buffer.concat([buf, chunk])
    for (;;) {
      if (buf.length < 2) return
      const fin = buf[0] & 0x80
      const opcode = buf[0] & 0x0f
      const masked = buf[1] & 0x80
      let len = buf[1] & 0x7f
      let off = 2
      if (len === 126) {
        if (buf.length < 4) return
        len = buf.readUInt16BE(2)
        off = 4
      } else if (len === 127) {
        if (buf.length < 10) return
        len = Number(buf.readBigUInt64BE(2))
        off = 10
      }
      const maskLen = masked ? 4 : 0
      if (buf.length < off + maskLen + len) return
      const mask = buf.subarray(off, off + maskLen)
      const data = Buffer.from(buf.subarray(off + maskLen, off + maskLen + len))
      if (masked) for (let i = 0; i < data.length; i++) data[i] ^= mask[i & 3]
      buf = buf.subarray(off + maskLen + len)
      if (opcode === 8) return socket.end(Buffer.from([0x88, 0]))
      if (opcode === 9) {
        socket.write(Buffer.concat([Buffer.from([0x8a, data.length]), data]))
        continue
      }
      if (opcode === 1 || opcode === 0) {
        parts.push(data)
        if (fin) {
          const text = Buffer.concat(parts).toString('utf8')
          parts = []
          try {
            onMessage(JSON.parse(text))
          } catch {}
        }
      }
    }
  })
}

async function startPty(p, cols, rows, model, fresh = false) {
  const info = await piInfo()
  if (!info.pi) {
    broadcast(p, { t: 'o', d: '\r\n\x1b[31mpi est introuvable sur ce Mac.\x1b[0m\r\n' })
    return
  }
  const termSessions = Path.join(p.sessions, 'terminal')
  if (fresh) fs.rmSync(termSessions, { recursive: true, force: true })
  fs.mkdirSync(termSessions, { recursive: true })
  const chosen = (model && info.models.includes(model) && model) || info.model
  const args = ['--session-dir', termSessions, '--append-system-prompt', SYSTEM_TERM]
  if (fs.readdirSync(termSessions).length) args.push('-c')
  if (chosen) args.push('--model', `aristote/${chosen}`)
  const child = spawn('python3', [Path.join(HERE, 'terminal.py'), String(cols), String(rows), 'pi', ...args], {
    cwd: p.dir,
    env: { ...process.env, TERM: 'xterm-256color', COLORTERM: 'truecolor', ARISTOTE_SUBAGENT: '' },
    stdio: ['pipe', 'pipe', 'pipe', 'pipe'],
  })
  p.pty = child
  const decoder = new StringDecoder('utf8')
  child.stdout.on('data', chunk => broadcast(p, { t: 'o', d: decoder.write(chunk) }))
  child.stderr.on('data', chunk => broadcast(p, { t: 'o', d: String(chunk).replace(/\n/g, '\r\n') }))
  child.on('close', code => {
    if (p.pty === child) p.pty = null
    broadcast(p, { t: 'exit', code })
    pushChanges(p)
  })
  watch(p)
}

function handleUpgrade(req, socket) {
  const url = new URL(req.url, 'http://localhost')
  const origin = req.headers.origin || ''
  const key = req.headers['sec-websocket-key']
  if (url.pathname !== '/pty' || !key || !allowedOrigin(origin) || (TOKEN && url.searchParams.get('token') !== TOKEN)) {
    socket.end('HTTP/1.1 403 Forbidden\r\n\r\n')
    return
  }
  let p
  try {
    p = project(url.searchParams.get('project'))
  } catch {
    socket.end('HTTP/1.1 400 Bad Request\r\n\r\n')
    return
  }
  const accept = crypto.createHash('sha1').update(key + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64')
  socket.write(
    `HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`
  )
  socket.setNoDelay(true)
  p.sockets.add(socket)
  const cols = Number(url.searchParams.get('cols')) || 100
  const rows = Number(url.searchParams.get('rows')) || 30
  wsFrames(socket, msg => {
    if (msg.t === 'i' && p.pty) p.pty.stdin.write(msg.d)
    else if (msg.t === 'r' && p.pty) p.pty.stdio[3].write(`${msg.cols | 0} ${msg.rows | 0}\n`)
    else if (msg.t === 'restart') {
      const restart = () => startPty(p, msg.cols || cols, msg.rows || rows, msg.model, msg.fresh)
      if (!p.pty) restart()
      else if (msg.fresh) {
        p.pty.once('close', restart)
        p.pty.kill('SIGTERM')
      }
    }
  })
  const close = () => {
    p.sockets.delete(socket)
    if (!p.sockets.size) {
      p.pty?.kill('SIGTERM')
      unwatch(p)
    }
  }
  socket.on('close', close)
  socket.on('error', close)
  if (!p.pty) startPty(p, cols, rows, url.searchParams.get('model'), url.searchParams.get('fresh') === '1')
  else p.pty.stdio[3].write(`${cols} ${rows}\n`)
}

// ---------------------------------------------------------------- HTTP

function allowedOrigin(origin) {
  return /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin)
}

function cors(req) {
  const origin = req.headers.origin || ''
  return allowedOrigin(origin)
    ? {
        'Access-Control-Allow-Origin': origin,
        'Access-Control-Allow-Headers': 'content-type, x-agent-token',
        'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
        Vary: 'Origin',
      }
    : {}
}

function sendJson(res, status, obj) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', ...cors(res.req) })
  res.end(JSON.stringify(obj))
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = []
    let size = 0
    req.on('data', c => {
      size += c.length
      if (size > MAX_BODY) {
        reject(new Error('projet trop volumineux'))
        req.destroy()
      } else chunks.push(c)
    })
    req.on('end', () => {
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'))
      } catch (err) {
        reject(err)
      }
    })
    req.on('error', reject)
  })
}

const server = http.createServer(async (req, res) => {
  if (req.method === 'OPTIONS') {
    res.writeHead(204, cors(req))
    return res.end()
  }
  const url = new URL(req.url, 'http://localhost')
  if (TOKEN && req.headers['x-agent-token'] !== TOKEN) return sendJson(res, 403, { error: 'jeton invalide' })
  try {
    if (req.method === 'GET' && url.pathname === '/health') {
      const info = await piInfo()
      return sendJson(res, 200, { ok: true, pi: info.pi, models: info.models, model: info.model })
    }
    if (req.method !== 'POST') return sendJson(res, 404, { error: 'introuvable' })
    const body = await readBody(req)
    switch (url.pathname) {
      case '/sync': {
        const p = project(body.projectId)
        const need = applySnapshot(p, body)
        if (p.pty) pushChanges(p)
        return sendJson(res, 200, { need })
      }
      case '/sync-file': {
        const p = project(body.projectId)
        applyRemoteFile(p, body.path, body.base64, body.hash)
        return sendJson(res, 200, { ok: true })
      }
      case '/log': {
        const p = project(body.projectId)
        fs.mkdirSync(Path.join(p.dir, '.overleaf'), { recursive: true })
        fs.writeFileSync(Path.join(p.dir, '.overleaf', 'output.log'), String(body.text || ''))
        return sendJson(res, 200, { ok: true })
      }
    }
    sendJson(res, 404, { error: 'introuvable' })
  } catch (err) {
    if (!res.headersSent) sendJson(res, err.status || 500, { error: err.message })
    else res.end()
  }
})
server.on('upgrade', handleUpgrade)

fs.mkdirSync(ROOT, { recursive: true })
server.listen(PORT, '127.0.0.1', () => {
  console.log(`ol-local agent : http://127.0.0.1:${PORT}`)
  piInfo().catch(() => {})
})
