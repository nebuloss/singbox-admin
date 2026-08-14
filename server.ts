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
type Peer = {
  address: string
  port: number
  public_key: string
  pre_shared_key?: string
  allowed_ips: string[]
  persistent_keepalive_interval?: number
}
type Endpoint = { type: string; tag: string; address: string[]; private_key: string; peers: Peer[] }
type Rule = { ip_cidr?: string[]; outbound?: string }
type Config = {
  inbounds?: Inbound[]
  endpoints?: Endpoint[]
  outbounds?: unknown[]
  route?: { rules?: Rule[]; final?: string; [k: string]: unknown }
}

// sing-box rejects unknown keys, so a disabled tunnel cannot carry an
// "enabled: false" field. The state lives in the tag prefix instead, which
// keeps the config the single source of truth.
const WG_ON = 'wg'
const WG_OFF = 'wgx'

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

/**
 * Parse a standard WireGuard client configuration — the .conf a router or
 * provider hands you — into a sing-box endpoint. Accepting that format
 * directly avoids retyping five fields and getting one wrong.
 */
function parseWireguard(text: string): { endpoint: Endpoint; allowedIps: string[] } {
  const get = (section: string, key: string): string | undefined => {
    const re = new RegExp(`\\[${section}\\]([\\s\\S]*?)(?=\\n\\s*\\[|$)`, 'i')
    const body = re.exec(text)?.[1] ?? ''
    const line = new RegExp(`^\\s*${key}\\s*=\\s*(.+?)\\s*$`, 'im').exec(body)
    return line?.[1]
  }

  const privateKey = get('Interface', 'PrivateKey')
  const address = get('Interface', 'Address')
  const publicKey = get('Peer', 'PublicKey')
  const endpointLine = get('Peer', 'Endpoint')
  const allowed = get('Peer', 'AllowedIPs') ?? '0.0.0.0/0'
  const psk = get('Peer', 'PresharedKey')
  const keepalive = get('Peer', 'PersistentKeepalive')

  if (!privateKey) throw new Error('PrivateKey manquant dans [Interface]')
  if (!address) throw new Error('Address manquant dans [Interface]')
  if (!publicKey) throw new Error('PublicKey manquant dans [Peer]')
  if (!endpointLine) throw new Error('Endpoint manquant dans [Peer]')

  // Endpoint is host:port; the host may be an IPv6 literal in brackets.
  const m = /^\s*(\[[^\]]+\]|[^:]+):(\d+)\s*$/.exec(endpointLine)
  if (!m) throw new Error(`Endpoint illisible : ${endpointLine}`)
  const host = m[1].replace(/^\[|\]$/g, '')
  const port = Number(m[2])

  const allowedIps = allowed.split(',').map((s) => s.trim()).filter(Boolean)

  const peer: Peer = {
    address: host,
    port,
    public_key: publicKey,
    allowed_ips: allowedIps,
    // Without a keepalive the UDP session behind NAT dies after a few idle
    // minutes, which is exactly when a fallback tunnel is needed.
    persistent_keepalive_interval: keepalive ? Number(keepalive) : 25,
  }
  if (psk) peer.pre_shared_key = psk

  return {
    endpoint: {
      type: 'wireguard',
      tag: '',
      address: address.split(',').map((s) => s.trim()).filter(Boolean),
      private_key: privateKey,
      peers: [peer],
    },
    allowedIps,
  }
}

const slug = (name: string) =>
  name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 24) || 'wg'

const isWgTag = (tag: string) => tag.startsWith(`${WG_ON}-`) || tag.startsWith(`${WG_OFF}-`)
const isEnabled = (tag: string) => tag.startsWith(`${WG_ON}-`)
const wgName = (tag: string) => tag.slice(tag.indexOf('-') + 1)
const withState = (tag: string, on: boolean) => `${on ? WG_ON : WG_OFF}-${wgName(tag)}`

const wgEndpoints = (cfg: Config) => (cfg.endpoints ?? []).filter((e) => isWgTag(e.tag))

/** The tunnel currently carrying traffic, if any. */
function activeTarget(cfg: Config): string | null {
  const rule = cfg.route?.rules?.find((r) => r.outbound && isWgTag(r.outbound))
  return rule?.outbound ?? null
}

/**
 * Rebuild routing from the profile order.
 *
 * The first enabled tunnel serves; everything else is left in place but
 * unreferenced. With the outbound switched off, or with no enabled tunnel,
 * there is simply no rule and traffic leaves directly — which is also how the
 * UI derives the global switch, so no extra state is stored anywhere.
 */
function applyRouting(cfg: Config, on: boolean) {
  cfg.route = cfg.route ?? {}
  cfg.route.rules = (cfg.route.rules ?? []).filter((r) => !(r.outbound && isWgTag(r.outbound)))

  if (!on) return
  const first = wgEndpoints(cfg).find((e) => isEnabled(e.tag))
  if (!first) return

  // Route exactly what the peer accepts, so a split tunnel stays split.
  cfg.route.rules.push({ ip_cidr: first.peers?.[0]?.allowed_ips ?? [], outbound: first.tag })
}

function wireguardSummary(cfg: Config) {
  const profiles = wgEndpoints(cfg).map((e) => {
    const peer = e.peers?.[0]
    // The private key is never returned.
    return {
      tag: e.tag,
      name: wgName(e.tag),
      enabled: isEnabled(e.tag),
      address: e.address,
      peer: peer ? `${peer.address}:${peer.port}` : null,
      publicKey: peer?.public_key ?? null,
      allowedIps: peer?.allowed_ips ?? [],
      keepalive: peer?.persistent_keepalive_interval ?? null,
      presharedKey: Boolean(peer?.pre_shared_key),
    }
  })
  const active = activeTarget(cfg)
  return { profiles, active, enabled: active !== null }
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

/**
 * First run: with no password set the app is not locked but unclaimed, and the
 * UI asks for one. Anyone who can reach it can claim it, which is why it is
 * meant to sit on an internal network — and why resetting requires root on the
 * host rather than being exposed here.
 */
app.post('/api/setup', (req, res) => {
  if (auth) return res.status(409).json({ error: 'un mot de passe est deja defini' })
  const password = String(req.body?.password ?? '')
  if (password.length < 10) return res.status(400).json({ error: '10 caracteres minimum' })

  try {
    auth = writeAuth(AUTH_FILE, password)
  } catch (e) {
    return res.status(500).json({ error: `ecriture impossible : ${(e as Error).message}` })
  }

  const token = crypto.randomBytes(32).toString('hex')
  sessions.add(token)
  res.cookie('sbsession', token, { httpOnly: true, sameSite: 'strict', secure: true, maxAge: 12 * 3600e3 })
  res.json({ ok: true })
})

app.post('/api/login', (req, res) => {
  if (!auth) return res.status(409).json({ error: 'aucun mot de passe defini' })
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
  if (!authed(req)) return res.json({ authed: false, setup: auth === null })
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
      wireguard: wireguardSummary(cfg),
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

app.post('/api/wireguard', requireAuth, async (req, res) => {
  try {
    const name = String(req.body?.name ?? '').trim()
    if (!/^[\w .@-]{1,40}$/.test(name)) return res.status(400).json({ error: 'nom invalide' })

    const { endpoint } = parseWireguard(String(req.body?.config ?? ''))
    endpoint.tag = `${WG_ON}-${slug(name)}`

    const cfg = readConfig()
    const existing = wgEndpoints(cfg)

    // Two ways to end up with the same tunnel twice, both worth refusing: the
    // same name, and the same peer pasted under a different name. The second
    // is the one that actually bites — a duplicate would sit in the list doing
    // nothing, since only the first enabled one ever serves.
    if (existing.some((e) => wgName(e.tag) === slug(name)))
      return res.status(409).json({ error: 'un tunnel porte deja ce nom' })

    const peer = endpoint.peers[0]
    const same = existing.find((e) => {
      const p = e.peers?.[0]
      return p && p.public_key === peer.public_key && p.address === peer.address && p.port === peer.port
    })
    // Shaped as "<message> : <detail>" like the other messages carrying a
    // variable part, so the interface can translate the fixed half of it.
    if (same)
      return res
        .status(409)
        .json({ error: `ce tunnel est deja configure sous le nom : ${wgName(same.tag)}` })

    cfg.endpoints = [...(cfg.endpoints ?? []), endpoint]

    // Rebuild routing from the resulting order, keeping the current mode.
    applyRouting(cfg, activeTarget(cfg) !== null)

    await commit(cfg)
    res.json({ ok: true, tag: endpoint.tag })
  } catch (e) {
    res.status(400).json({ error: String((e as Error).message) })
  }
})

app.post('/api/wireguard/order', requireAuth, async (req, res) => {
  try {
    const tags: string[] = Array.isArray(req.body?.tags) ? req.body.tags.map(String) : []
    const cfg = readConfig()
    const wgs = wgEndpoints(cfg)
    if (tags.length !== wgs.length || !tags.every((t) => wgs.some((e) => e.tag === t)))
      return res.status(400).json({ error: 'liste de profils incoherente' })

    const others = (cfg.endpoints ?? []).filter((e) => !isWgTag(e.tag))
    cfg.endpoints = [...others, ...tags.map((t) => wgs.find((e) => e.tag === t)!)]
    applyRouting(cfg, activeTarget(cfg) !== null)
    await commit(cfg)
    res.json({ ok: true })
  } catch (e) {
    res.status(400).json({ error: String((e as Error).message) })
  }
})

app.post('/api/wireguard/enabled', requireAuth, async (req, res) => {
  try {
    const cfg = readConfig()
    const on = Boolean(req.body?.enabled)
    if (on && !wgEndpoints(cfg).some((e) => isEnabled(e.tag)))
      return res.status(400).json({ error: 'aucun tunnel actif a utiliser' })
    applyRouting(cfg, on)
    await commit(cfg)
    res.json({ ok: true })
  } catch (e) {
    res.status(400).json({ error: String((e as Error).message) })
  }
})

app.post('/api/wireguard/:tag/enabled', requireAuth, async (req, res) => {
  try {
    const cfg = readConfig()
    const ep = (cfg.endpoints ?? []).find((e) => e.tag === req.params.tag)
    if (!ep) return res.status(404).json({ error: 'tunnel introuvable' })

    const wasOn = activeTarget(cfg) !== null
    ep.tag = withState(ep.tag, Boolean(req.body?.enabled))
    applyRouting(cfg, wasOn)
    await commit(cfg)
    res.json({ ok: true, tag: ep.tag })
  } catch (e) {
    res.status(400).json({ error: String((e as Error).message) })
  }
})

app.delete('/api/wireguard/:tag', requireAuth, async (req, res) => {
  try {
    const tag = req.params.tag
    const cfg = readConfig()
    if (!cfg.endpoints?.some((e) => e.tag === tag))
      return res.status(404).json({ error: 'profil introuvable' })

    const wasOn = activeTarget(cfg) !== null
    cfg.endpoints = cfg.endpoints.filter((e) => e.tag !== tag)
    // Routing is rebuilt from what remains: a rule pointing at a deleted
    // endpoint is rejected by sing-box outright.
    applyRouting(cfg, wasOn)
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
