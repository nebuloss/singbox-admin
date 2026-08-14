/**
 * Production server — serves the Vite-built SPA and exposes a small API to
 * manage the sing-box client list.
 *
 * This is the one place where we diverge from kin-app: that app has no backend
 * at all (its state lives in cookies). Here the source of truth is sing-box's
 * own config file, so the server reads it, edits the `users` array of the VLESS
 * inbound, validates the result with `sing-box check` and only then restarts
 * the service. Nothing is duplicated in a database.
 */

import express from 'express'
import cookieParser from 'cookie-parser'
import path from 'path'
import fs from 'fs'
import os from 'os'
import crypto from 'crypto'
import { execFile } from 'child_process'
import QRCode from 'qrcode'
import { readAuth, writeAuth, verifyPassword } from './auth'

const app = express()
app.set('trust proxy', 1)
app.use(express.json())
app.use(cookieParser())

const PORT = Number(process.env.PORT ?? 3000)
const CONFIG_PATH = process.env.SINGBOX_CONFIG ?? '/etc/sing-box/config.json'
const SERVICE = process.env.SINGBOX_SERVICE ?? 'sing-box'
const PUBLIC_HOST = process.env.PUBLIC_HOST ?? 'example.com'
const PUBLIC_PORT = Number(process.env.PUBLIC_PORT ?? 443)
// The password lives hashed in AUTH_FILE. ADMIN_PASSWORD is only a bootstrap
// value: on first start it is hashed into that file and never read again.
const AUTH_FILE = process.env.AUTH_FILE ?? path.join(__dirname, '..', 'auth.json')
let auth = readAuth(AUTH_FILE)
if (!auth && process.env.ADMIN_PASSWORD) {
  auth = writeAuth(AUTH_FILE, process.env.ADMIN_PASSWORD)
  console.log(`mot de passe initial hache dans ${AUTH_FILE}`)
}
const readOnly = () => auth === null

// ── Types kept deliberately loose: we only touch the users array and leave the
//    rest of the sing-box config untouched, whatever it contains.
type User = { uuid: string; name?: string }
type Inbound = { type?: string; users?: User[]; transport?: { path?: string } }
type Config = { inbounds?: Inbound[] }

const run = (cmd: string, args: string[]) =>
  new Promise<{ ok: boolean; out: string }>((resolve) => {
    execFile(cmd, args, { timeout: 20_000 }, (err, stdout, stderr) =>
      resolve({ ok: !err, out: `${stdout ?? ''}${stderr ?? ''}`.trim() }),
    )
  })

function readConfig(): Config {
  return JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8')) as Config
}

/** The VLESS inbound is the one we manage; there is exactly one in practice. */
function vlessInbound(cfg: Config): Inbound {
  const inbound = cfg.inbounds?.find((i) => i.type === 'vless')
  if (!inbound) throw new Error('aucun inbound VLESS dans la configuration')
  if (!Array.isArray(inbound.users)) inbound.users = []
  return inbound
}

/**
 * Write the config, verify it with `sing-box check`, restart the service.
 * On any failure the previous file is restored, so a bad edit can never leave
 * the tunnel down.
 */
async function commit(cfg: Config): Promise<void> {
  const backup = fs.readFileSync(CONFIG_PATH, 'utf8')
  const tmp = path.join(os.tmpdir(), `singbox-admin-${process.pid}.json`)
  fs.writeFileSync(tmp, JSON.stringify(cfg, null, 2))
  fs.copyFileSync(tmp, CONFIG_PATH)
  fs.unlinkSync(tmp)

  const check = await run('sing-box', ['check', '-c', CONFIG_PATH])
  if (!check.ok) {
    fs.writeFileSync(CONFIG_PATH, backup)
    throw new Error(`configuration refusee par sing-box : ${check.out}`)
  }

  const restart = await run('rc-service', [SERVICE, 'restart'])
  if (!restart.ok) {
    const sd = await run('systemctl', ['restart', SERVICE])
    if (!sd.ok) throw new Error(`redemarrage impossible : ${restart.out} ${sd.out}`)
  }
}

function linkFor(user: User, wsPath: string): string {
  const label = encodeURIComponent(user.name || user.uuid.slice(0, 8))
  const q = new URLSearchParams({
    encryption: 'none',
    security: 'tls',
    sni: PUBLIC_HOST,
    type: 'ws',
    path: wsPath,
  })
  return `vless://${user.uuid}@${PUBLIC_HOST}:${PUBLIC_PORT}?${q}#${label}`
}

// ── Auth: one shared password, sessions held in memory. Restarting the service
//    logs everyone out, which is the desired behaviour for an admin tool.
const sessions = new Set<string>()

function authed(req: express.Request): boolean {
  if (readOnly()) return false
  const t = req.cookies?.sbsession
  return typeof t === 'string' && sessions.has(t)
}

function requireAuth(req: express.Request, res: express.Response, next: express.NextFunction) {
  if (!authed(req)) return res.status(401).json({ error: 'authentification requise' })
  next()
}

app.post('/api/login', (req, res) => {
  if (!auth) return res.status(503).json({ error: 'aucun mot de passe configure' })
  if (!verifyPassword(String(req.body?.password ?? ''), auth.hash))
    return res.status(401).json({ error: 'mot de passe incorrect' })

  const token = crypto.randomBytes(32).toString('hex')
  sessions.add(token)
  res.cookie('sbsession', token, { httpOnly: true, sameSite: 'strict', secure: true, maxAge: 12 * 3600e3 })
  res.json({ ok: true })
})

app.post('/api/password', requireAuth, (req, res) => {
  const current = String(req.body?.current ?? '')
  const next = String(req.body?.next ?? '')
  if (!auth || !verifyPassword(current, auth.hash))
    return res.status(401).json({ error: 'mot de passe actuel incorrect' })
  if (next.length < 10) return res.status(400).json({ error: '10 caracteres minimum' })
  if (next === current) return res.status(400).json({ error: 'identique a l actuel' })

  try {
    auth = writeAuth(AUTH_FILE, next)
  } catch (e) {
    return res.status(500).json({ error: `ecriture impossible : ${(e as Error).message}` })
  }

  // Every other session is dropped: a password change should evict anyone who
  // authenticated with the old one. The caller keeps its own cookie.
  const keep = req.cookies?.sbsession
  for (const t of sessions) if (t !== keep) sessions.delete(t)
  res.json({ ok: true })
})

app.post('/api/logout', (req, res) => {
  const t = req.cookies?.sbsession
  if (typeof t === 'string') sessions.delete(t)
  res.clearCookie('sbsession')
  res.json({ ok: true })
})

app.get('/api/state', async (req, res) => {
  if (!authed(req)) return res.json({ authed: false, readOnly: readOnly() })
  try {
    const cfg = readConfig()
    const inbound = vlessInbound(cfg)
    const wsPath = inbound.transport?.path ?? '/'
    const version = (await run('sing-box', ['version'])).out.split('\n')[0] ?? ''
    const status = await run('rc-service', [SERVICE, 'status'])

    const users = await Promise.all(
      (inbound.users ?? []).map(async (u) => {
        const link = linkFor(u, wsPath)
        return { ...u, link, qr: await QRCode.toString(link, { type: 'svg', margin: 1 }) }
      }),
    )
    res.json({
      authed: true,
      users,
      service: { running: /started|running|active/i.test(status.out), version },
      tunnel: { host: PUBLIC_HOST, port: PUBLIC_PORT, path: wsPath },
    })
  } catch (e) {
    res.status(500).json({ error: String((e as Error).message) })
  }
})

app.post('/api/users', requireAuth, async (req, res) => {
  const name = String(req.body?.name ?? '').trim()
  if (!/^[\w .@-]{1,40}$/.test(name)) return res.status(400).json({ error: 'nom invalide' })
  try {
    const cfg = readConfig()
    const inbound = vlessInbound(cfg)
    if (inbound.users!.some((u) => u.name === name))
      return res.status(409).json({ error: 'ce nom existe deja' })
    inbound.users!.push({ uuid: crypto.randomUUID(), name })
    await commit(cfg)
    res.json({ ok: true })
  } catch (e) {
    res.status(500).json({ error: String((e as Error).message) })
  }
})

app.delete('/api/users/:uuid', requireAuth, async (req, res) => {
  try {
    const cfg = readConfig()
    const inbound = vlessInbound(cfg)
    const before = inbound.users!.length
    inbound.users = inbound.users!.filter((u) => u.uuid !== req.params.uuid)
    if (inbound.users.length === before) return res.status(404).json({ error: 'inconnu' })
    if (inbound.users.length === 0)
      return res.status(400).json({ error: 'refus : cela supprimerait le dernier acces' })
    await commit(cfg)
    res.json({ ok: true })
  } catch (e) {
    res.status(500).json({ error: String((e as Error).message) })
  }
})

// ── SPA. __dirname is dist-server/ at runtime, so the bundle sits in ../dist.
const distDir = path.join(__dirname, '..', 'dist')
app.use(express.static(distDir))
app.get('*', (_req, res) => res.sendFile(path.join(distDir, 'index.html')))

app.listen(PORT, () => {
  console.log(`singbox-admin on :${PORT} — config ${CONFIG_PATH}${readOnly() ? ' (aucun mot de passe : lecture seule)' : ''}`)
})
