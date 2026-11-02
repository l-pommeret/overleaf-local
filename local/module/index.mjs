// Module « ol-local » : Overleaf en local, sans compte, en vert sapin, avec un onglet Agent.
//
// - connexion automatique d'un utilisateur unique (créé au premier passage) ;
// - injection du thème et du script de l'onglet Agent dans chaque page HTML ;
// - route d'écriture qu'utilise l'onglet Agent pour renvoyer les fichiers modifiés par pi.
import fs from 'node:fs'
import Path from 'node:path'
import os from 'node:os'
import crypto from 'node:crypto'
import { fileURLToPath } from 'node:url'
import logger from '@overleaf/logger'
import SessionManager from '../../app/src/Features/Authentication/SessionManager.mjs'
import UserGetter from '../../app/src/Features/User/UserGetter.mjs'
import UserRegistrationHandler from '../../app/src/Features/User/UserRegistrationHandler.mjs'
import AuthorizationMiddleware from '../../app/src/Features/Authorization/AuthorizationMiddleware.mjs'
import EditorController from '../../app/src/Features/Editor/EditorController.mjs'
import DocumentUpdaterHandler from '../../app/src/Features/DocumentUpdater/DocumentUpdaterHandler.mjs'
import ProjectEntityHandler from '../../app/src/Features/Project/ProjectEntityHandler.mjs'
import { db } from '../../app/src/infrastructure/mongodb.mjs'

const PUBLIC_DIR = Path.join(Path.dirname(fileURLToPath(import.meta.url)), 'public')
const EMAIL = process.env.OL_LOCAL_EMAIL || 'moi@overleaf.local'
const NAME = process.env.OL_LOCAL_NAME || 'YomYom'
const AGENT = {
  url: process.env.OL_AGENT_URL || 'http://127.0.0.1:8765',
  token: process.env.OL_AGENT_TOKEN || '',
}
const STATIC = {
  'sapin.css': 'text/css; charset=utf-8',
  'agent.js': 'text/javascript; charset=utf-8',
  'agent.css': 'text/css; charset=utf-8',
  'nom.js': 'text/javascript; charset=utf-8',
}
const VERSION = Date.now().toString(36)
const AGENT_CONFIG = JSON.stringify(AGENT).replace(/</g, '\\u003c')

// Les pages d'Overleaf ont une CSP à nonce : nos scripts reprennent celui de la page.
function headTags(nonce, editor) {
  const n = nonce ? ` nonce="${nonce}"` : ''
  let tags = `<link rel="stylesheet" href="/ol-local/sapin.css?v=${VERSION}"><script${n} src="/ol-local/nom.js?v=${VERSION}"></script>`
  if (editor) {
    tags += `<link rel="stylesheet" href="/ol-local/agent.css?v=${VERSION}"><script${n}>window.OL_LOCAL_AGENT=${AGENT_CONFIG}</script><script${n} src="/ol-local/agent.js?v=${VERSION}"></script>`
  }
  return tags
}

let userPromise = null

async function getLocalUser() {
  let user = await UserGetter.promises.getUserByMainEmail(EMAIL)
  if (!user) {
    await UserRegistrationHandler.promises.registerNewUser({
      email: EMAIL,
      password: crypto.randomBytes(32).toString('hex'),
      first_name: NAME,
      analyticsId: crypto.randomUUID(),
    })
    await db.users.updateOne({ email: EMAIL }, { $set: { isAdmin: true } })
    user = await UserGetter.promises.getUserByMainEmail(EMAIL)
    logger.info({ email: EMAIL }, 'ol-local: utilisateur local créé')
  }
  if (user.first_name !== NAME) {
    await db.users.updateOne({ _id: user._id }, { $set: { first_name: NAME, last_name: '' } })
    user = await UserGetter.promises.getUserByMainEmail(EMAIL)
  }
  return user
}

function autologin(req, res, next) {
  if (!req.session) return next()
  const loggedIn = SessionManager.isUserLoggedIn(req.session)
  const redirectHome = () =>
    req.method === 'GET' && ['/login', '/register'].includes(req.path)
      ? res.redirect('/project')
      : next()
  if (loggedIn) return redirectHome()
  userPromise ||= getLocalUser()
  userPromise
    .then(user => {
      req.login(user, { keepSessionInfo: true }, err => {
        if (err) return next(err)
        req.session.save(err => (err ? next(err) : redirectHome()))
      })
    })
    .catch(err => {
      userPromise = null
      next(err)
    })
}

function injectHead(req, res, next) {
  const send = res.send
  res.send = function (body) {
    if (typeof body === 'string' && body.includes('</head>')) {
      const editor = /^\/project\/[0-9a-f]{24}\/?$/.test(req.path)
      body = body.replace('</head>', headTags(res.locals.scriptNonce, editor) + '</head>')
    }
    return send.call(this, body)
  }
  next()
}

function serveStatic(req, res) {
  const type = STATIC[req.params.file]
  if (!type) return res.sendStatus(404)
  res.set('Content-Type', type)
  res.set('Cache-Control', 'no-cache')
  fs.createReadStream(Path.join(PUBLIC_DIR, req.params.file)).pipe(res)
}

// Écrit un fichier renvoyé par l'agent : un document texte (mis à jour en direct
// dans l'éditeur) ou un fichier binaire. Un seul fichier par requête.
async function writeAgentFile(req, res) {
  const projectId = req.params.Project_id
  const userId = SessionManager.getLoggedInUserId(req.session)
  const { path, text, base64 } = req.body || {}
  const clean = typeof path === 'string' ? Path.posix.normalize('/' + path) : ''
  if (!clean || clean === '/' || clean.includes('/../') || clean.length > 300) {
    return res.status(400).json({ error: 'chemin invalide' })
  }
  try {
    if (typeof text === 'string') {
      // source « git-bridge » : l'éditeur applique la mise à jour sans la fenêtre
      // « Document Updated Externally » (c'est la seule chose que change ce nom).
      await EditorController.promises.upsertDocWithPath(
        projectId,
        clean,
        text.split('\n'),
        'git-bridge',
        userId
      )
    } else if (typeof base64 === 'string') {
      const tmp = Path.join(os.tmpdir(), `ol-agent-${crypto.randomUUID()}`)
      await fs.promises.writeFile(tmp, Buffer.from(base64, 'base64'))
      try {
        await EditorController.promises.upsertFileWithPath(
          projectId,
          clean,
          tmp,
          null,
          'upload',
          userId
        )
      } finally {
        fs.promises.unlink(tmp).catch(() => {})
      }
    } else {
      return res.status(400).json({ error: 'contenu manquant' })
    }
    res.json({ ok: true })
  } catch (err) {
    logger.warn({ err, projectId, path: clean }, 'ol-local: écriture refusée')
    res.status(422).json({ error: err.message })
  }
}

// Instantané du projet pour la synchronisation de l'agent : le texte des documents
// (après écriture des modifications en cours) et l'empreinte de chaque fichier binaire.
async function snapshot(req, res) {
  const projectId = req.params.Project_id
  try {
    await DocumentUpdaterHandler.promises.flushProjectToMongo(projectId)
    const [docs, files] = await Promise.all([
      ProjectEntityHandler.promises.getAllDocs(projectId),
      ProjectEntityHandler.promises.getAllFiles(projectId),
    ])
    const out = { docs: {}, files: {} }
    for (const [path, doc] of Object.entries(docs)) out.docs[path.slice(1)] = doc.lines.join('\n')
    for (const [path, file] of Object.entries(files)) out.files[path.slice(1)] = { id: String(file._id), hash: file.hash }
    res.set('Cache-Control', 'no-store')
    res.json(out)
  } catch (err) {
    logger.warn({ err, projectId }, 'ol-local: instantané impossible')
    res.status(500).json({ error: err.message })
  }
}

export default {
  async start() {
    userPromise = getLocalUser()
    userPromise.catch(err => {
      userPromise = null
      logger.warn({ err }, 'ol-local: utilisateur local indisponible')
    })
  },
  nonCsrfRouter: {
    apply(webRouter) {
      webRouter.get('/ol-local/:file', serveStatic)
      webRouter.use(autologin)
      webRouter.use(injectHead)
    },
  },
  router: {
    apply(webRouter) {
      webRouter.post(
        '/ol-local/project/:Project_id/file',
        AuthorizationMiddleware.ensureUserCanWriteProjectContent,
        writeAgentFile
      )
      webRouter.get(
        '/ol-local/project/:Project_id/snapshot',
        AuthorizationMiddleware.ensureUserCanReadProject,
        snapshot
      )
    },
  },
}
