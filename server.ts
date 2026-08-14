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
import { readNames, writeNames, type Names } from './names'

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
// Display names live here, never in the sing-box configuration — see names.ts.
const NAMES_FILE = process.env.NAMES_FILE ?? path.join(__dirname, '..', 'names.json')
let auth = readAuth(AUTH_FILE)
if (!auth && process.env.ADMIN_PASSWORD) {
  auth = writeAuth(AUTH_FILE, process.env.ADMIN_PASSWORD)
  console.log(`mot de passe initial hache dans ${AUTH_FILE}`)
}
const readOnly = () => auth === null

// ── Types kept deliberately loose: we only touch the users array and leave the
//    rest of the sing-box config untouched, whatever it contains.
// A UUID and nothing else: what sing-box needs to authenticate a device, and
// all it is ever told. The readable name lives in names.json, keyed by UUID.
type User = { uuid: string }
type Inbound = {
  type?: string
  tag?: string
  listen?: string
  users?: User[]
  transport?: { path?: string }
}
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
  dns?: { servers?: unknown[]; [k: string]: unknown }
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

/**
 * Suspension is a place, not a flag.
 *
 * sing-box offers no field for "this device is off", and a routing rule can
 * only match a user by name — which would make the name the identity and turn
 * every rename into a delicate operation. So a suspended device is moved to a
 * second VLESS inbound bound to localhost: nothing proxies it, nothing outside
 * the host can reach it. The UUID stays the identity and the name goes back to
 * being nothing but a label.
 */
const PARKED = 'vless-suspended'

const vlessInbounds = (cfg: Config) => (cfg.inbounds ?? []).filter((i) => i.type === 'vless')

/** The inbound clients actually reach. */
function liveInbound(cfg: Config): Inbound {
  const inbound = vlessInbounds(cfg).find((i) => i.tag !== PARKED)
  if (!inbound) throw new Error('aucun inbound VLESS dans la configuration')
  if (!Array.isArray(inbound.users)) inbound.users = []
  return inbound
}

const parkedInbound = (cfg: Config) => vlessInbounds(cfg).find((i) => i.tag === PARKED)

/** The shelf, created on demand. `listen` is explicit rather than relying on
 *  sing-box defaulting to localhost — that default is what makes it safe. */
function shelf(cfg: Config): Inbound {
  let parked = parkedInbound(cfg)
  if (!parked) {
    parked = { type: 'vless', tag: PARKED, listen: '127.0.0.1', users: [] }
    cfg.inbounds = [...(cfg.inbounds ?? []), parked]
  }
  if (!Array.isArray(parked.users)) parked.users = []
  return parked
}

/** An empty shelf is noise in the config, so it does not outlive its contents. */
function tidyShelf(cfg: Config) {
  const parked = parkedInbound(cfg)
  if (parked && !parked.users?.length)
    cfg.inbounds = (cfg.inbounds ?? []).filter((i) => i !== parked)
}

const allUsers = (cfg: Config) => [
  ...(liveInbound(cfg).users ?? []),
  ...(parkedInbound(cfg)?.users ?? []),
]

/**
 * Write the config, verify it with `sing-box check`, restart the service.
 * On any failure the previous file is restored, so a bad edit can never leave
 * the tunnel down.
 */
async function commit(cfg: Config): Promise<void> {
  // Whatever the caller was changing, the file comes out tidy.
  tidyShelf(cfg)

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

function linkFor(user: User, name: string | undefined, wsPath: string): string {
  const label = encodeURIComponent(name || user.uuid.slice(0, 8))
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

/** Accepts either an array or the comma-separated string a form field yields. */
const list = (v: unknown): string[] =>
  (Array.isArray(v) ? v : String(v ?? '').split(/[,\s]+/))
    .map((s) => String(s).trim())
    .filter(Boolean)

/**
 * A tunnel tag is `wg-<id>` when enabled and `wgx-<id>` when not. The id is
 * random and permanent: it is what the display name is filed under, so
 * renaming never touches the sing-box configuration.
 *
 * The prefix is the one thing that does move, when a tunnel is switched on or
 * off — hence retag() below, which carries the references along.
 */
const isWgTag = (tag: string) => tag.startsWith(`${WG_ON}-`) || tag.startsWith(`${WG_OFF}-`)
const isEnabled = (tag: string) => tag.startsWith(`${WG_ON}-`)
const wgId = (tag: string) => tag.slice(tag.indexOf('-') + 1)
const withState = (tag: string, on: boolean) => `${on ? WG_ON : WG_OFF}-${wgId(tag)}`
const newWgId = () => crypto.randomBytes(4).toString('hex')

/** How a display name is filed for a tunnel, stable across on/off. */
const wgKey = (tag: string) => `wg:${wgId(tag)}`

const wgEndpoints = (cfg: Config) => (cfg.endpoints ?? []).filter((e) => isWgTag(e.tag))

/**
 * Move every reference to a tag when that tag changes.
 *
 * Routing rules are rebuilt from scratch elsewhere, but a DNS server can also
 * take a `detour`, and a detour left pointing at the old tag quietly stops
 * resolving through the tunnel.
 */
function retag(cfg: Config, from: string, to: string) {
  if (from === to) return
  for (const server of (cfg.dns?.servers ?? []) as { detour?: string }[]) {
    if (server.detour === from) server.detour = to
  }
}

/**
 * The tunnel currently carrying traffic, if any — counting only a rule that
 * points at a tunnel still present.
 *
 * A rule naming a tag nobody defines is stale — from a hand-edited config —
 * and taking it at face value would report the outbound as on while sing-box
 * refuses to start on exactly that dangling reference.
 */
function activeTarget(cfg: Config): string | null {
  const tags = new Set(wgEndpoints(cfg).map((e) => e.tag))
  const rule = cfg.route?.rules?.find((r) => r.outbound && tags.has(r.outbound))
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

function wireguardSummary(cfg: Config, names: Names) {
  const profiles = wgEndpoints(cfg).map((e) => {
    const peer = e.peers?.[0]
    // The private key is never returned.
    return {
      tag: e.tag,
      name: names[wgKey(e.tag)] ?? wgId(e.tag),
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
    const inbound = liveInbound(cfg)
    const wsPath = inbound.transport?.path ?? '/'
    const version = (await run('sing-box', ['version'])).out.split('\n')[0] ?? ''
    const status = await run('rc-service', [SERVICE, 'status'])

    // Suspended devices keep the public link — it is what makes them work
    // again the moment they are put back.
    const names = readNames(NAMES_FILE)
    const describe = async (u: User, enabled: boolean) => {
      const name = names[u.uuid]
      const link = linkFor(u, name, wsPath)
      return { uuid: u.uuid, name, link, enabled, qr: await QRCode.toString(link, { type: 'svg', margin: 1 }) }
    }
    const users = await Promise.all([
      ...(inbound.users ?? []).map((u) => describe(u, true)),
      ...(parkedInbound(cfg)?.users ?? []).map((u) => describe(u, false)),
    ])
    res.json({
      authed: true,
      users,
      service: { running: /started|running|active/i.test(status.out), version },
      tunnel: { host: PUBLIC_HOST, port: PUBLIC_PORT, path: wsPath },
      wireguard: wireguardSummary(cfg, names),
    })
  } catch (e) {
    res.status(500).json({ error: String((e as Error).message) })
  }
})

// Letters of any script, so an accented or non-Latin name is not "invalid".
const NAME_RE = /^[\p{L}\p{N} ._@()'’-]{1,40}$/u
const taken = (names: Names, name: string, except?: string) =>
  Object.entries(names).some(
    ([k, v]) => k !== except && v.toLocaleLowerCase() === name.toLocaleLowerCase(),
  )

app.post('/api/users', requireAuth, async (req, res) => {
  const name = String(req.body?.name ?? '').trim()
  if (!NAME_RE.test(name)) return res.status(400).json({ error: 'nom invalide' })
  try {
    const names = readNames(NAMES_FILE)
    if (taken(names, name)) return res.status(409).json({ error: 'ce nom existe deja' })

    const uuid = crypto.randomUUID()
    const cfg = readConfig()
    // sing-box is told the UUID and nothing else; the name is ours to keep.
    liveInbound(cfg).users!.push({ uuid })
    await commit(cfg)
    writeNames(NAMES_FILE, { ...names, [uuid]: name })
    res.json({ ok: true })
  } catch (e) {
    res.status(500).json({ error: String((e as Error).message) })
  }
})

app.delete('/api/users/:uuid', requireAuth, async (req, res) => {
  try {
    const cfg = readConfig()
    if (!allUsers(cfg).some((u) => u.uuid === req.params.uuid))
      return res.status(404).json({ error: 'inconnu' })
    if (allUsers(cfg).length === 1)
      return res.status(400).json({ error: 'refus : cela supprimerait le dernier acces' })

    const drop = (i: Inbound | undefined) => {
      if (i?.users) i.users = i.users.filter((u) => u.uuid !== req.params.uuid)
    }
    drop(liveInbound(cfg))
    drop(parkedInbound(cfg))

    await commit(cfg)
    const { [req.params.uuid]: _gone, ...rest } = readNames(NAMES_FILE)
    writeNames(NAMES_FILE, rest)
    res.json({ ok: true })
  } catch (e) {
    res.status(500).json({ error: String((e as Error).message) })
  }
})

/**
 * Renaming writes names.json and stops there — no configuration rewrite, no
 * `sing-box check`, no service restart, so nobody loses their connection over
 * a label. That is the whole reason sing-box is only ever told the UUID.
 */
app.patch('/api/users/:uuid', requireAuth, (req, res) => {
  const name = String(req.body?.name ?? '').trim()
  if (!NAME_RE.test(name)) return res.status(400).json({ error: 'nom invalide' })
  try {
    if (!allUsers(readConfig()).some((u) => u.uuid === req.params.uuid))
      return res.status(404).json({ error: 'inconnu' })

    const names = readNames(NAMES_FILE)
    if (taken(names, name, req.params.uuid))
      return res.status(409).json({ error: 'ce nom existe deja' })

    writeNames(NAMES_FILE, { ...names, [req.params.uuid]: name })
    res.json({ ok: true })
  } catch (e) {
    res.status(500).json({ error: String((e as Error).message) })
  }
})

app.post('/api/users/:uuid/enabled', requireAuth, async (req, res) => {
  try {
    const cfg = readConfig()
    const live = liveInbound(cfg)
    const parked = parkedInbound(cfg)
    const wanted = Boolean(req.body?.enabled)

    const from = wanted ? parked : live
    const user = from?.users?.find((u) => u.uuid === req.params.uuid)
    // Already on the right shelf, or unknown — tell the two apart.
    if (!user) {
      const exists = allUsers(cfg).some((u) => u.uuid === req.params.uuid)
      if (!exists) return res.status(404).json({ error: 'inconnu' })
      return res.json({ ok: true })
    }

    from!.users = from!.users!.filter((u) => u.uuid !== req.params.uuid)
    ;(wanted ? live : shelf(cfg)).users!.push(user)

    await commit(cfg)
    res.json({ ok: true })
  } catch (e) {
    res.status(400).json({ error: String((e as Error).message) })
  }
})

app.post('/api/wireguard', requireAuth, async (req, res) => {
  try {
    const name = String(req.body?.name ?? '').trim()
    if (!/^[\w .@-]{1,40}$/.test(name)) return res.status(400).json({ error: 'nom invalide' })

    const names = readNames(NAMES_FILE)
    const { endpoint } = parseWireguard(String(req.body?.config ?? ''))
    endpoint.tag = `${WG_ON}-${newWgId()}`

    const cfg = readConfig()
    const existing = wgEndpoints(cfg)

    // Two ways to end up with the same tunnel twice, both worth refusing: the
    // same name, and the same peer pasted under a different name. The second
    // is the one that actually bites — a duplicate would sit in the list doing
    // nothing, since only the first enabled one ever serves.
    if (taken(names, name)) return res.status(409).json({ error: 'un tunnel porte deja ce nom' })

    const peer = endpoint.peers[0]
    const same = existing.find((e) => {
      const p = e.peers?.[0]
      return p && p.public_key === peer.public_key && p.address === peer.address && p.port === peer.port
    })
    // Shaped as "<message> : <detail>" like the other messages carrying a
    // variable part, so the interface can translate the fixed half of it.
    if (same)
      return res.status(409).json({
        error: `ce tunnel est deja configure sous le nom : ${names[wgKey(same.tag)] ?? wgId(same.tag)}`,
      })

    cfg.endpoints = [...(cfg.endpoints ?? []), endpoint]

    // Rebuild routing from the resulting order, keeping the current mode.
    applyRouting(cfg, activeTarget(cfg) !== null)

    await commit(cfg)
    writeNames(NAMES_FILE, { ...names, [wgKey(endpoint.tag)]: name })
    res.json({ ok: true, tag: endpoint.tag })
  } catch (e) {
    res.status(400).json({ error: String((e as Error).message) })
  }
})

/**
 * Edit a tunnel in place: its name and every peer field, but never its private
 * key. That key is write-once by design — it is not returned by the API, so it
 * cannot be shown in the form, and leaving it alone keeps that promise. A
 * tunnel that needs a new key is a new tunnel.
 */
app.patch('/api/wireguard/:tag', requireAuth, async (req, res) => {
  try {
    const name = String(req.body?.name ?? '').trim()
    if (!NAME_RE.test(name)) return res.status(400).json({ error: 'nom invalide' })

    const host = String(req.body?.host ?? '').trim()
    const port = Number(req.body?.port)
    const publicKey = String(req.body?.publicKey ?? '').trim()
    const address = list(req.body?.address)
    const allowedIps = list(req.body?.allowedIps)
    if (!host) return res.status(400).json({ error: 'adresse du pair manquante' })
    if (!Number.isInteger(port) || port < 1 || port > 65535)
      return res.status(400).json({ error: 'port du pair invalide' })
    if (!publicKey) return res.status(400).json({ error: 'cle publique du pair manquante' })
    if (!address.length) return res.status(400).json({ error: 'adresse dans le tunnel manquante' })
    if (!allowedIps.length) return res.status(400).json({ error: 'reseaux routes manquants' })

    const cfg = readConfig()
    const ep = wgEndpoints(cfg).find((e) => e.tag === req.params.tag)
    if (!ep) return res.status(404).json({ error: 'tunnel introuvable' })

    const names = readNames(NAMES_FILE)
    if (taken(names, name, wgKey(ep.tag)))
      return res.status(409).json({ error: 'un tunnel porte deja ce nom' })

    const clash = wgEndpoints(cfg)
      .filter((e) => e !== ep)
      .find((e) => {
        const p = e.peers?.[0]
        return p && p.public_key === publicKey && p.address === host && p.port === port
      })
    if (clash)
      return res.status(409).json({
        error: `ce tunnel est deja configure sous le nom : ${names[wgKey(clash.tag)] ?? wgId(clash.tag)}`,
      })

    const keepalive = Number(req.body?.keepalive)
    const peer = ep.peers?.[0]
    if (!peer) return res.status(400).json({ error: 'tunnel sans pair' })

    // The tag holds a permanent id, so nothing here renames it. Only the peer
    // fields can change, and only those are worth a write.
    const before = JSON.stringify([ep.address, peer])
    ep.address = address
    peer.address = host
    peer.port = port
    peer.public_key = publicKey
    peer.allowed_ips = allowedIps
    peer.persistent_keepalive_interval = Number.isInteger(keepalive) && keepalive > 0 ? keepalive : 25

    if (JSON.stringify([ep.address, peer]) !== before) {
      // AllowedIPs feeds the routing rule, so rebuild it, keeping the mode.
      applyRouting(cfg, activeTarget(cfg) !== null)
      await commit(cfg)
    }
    writeNames(NAMES_FILE, { ...names, [wgKey(ep.tag)]: name })
    res.json({ ok: true, tag: ep.tag })
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
    const before = ep.tag
    ep.tag = withState(ep.tag, Boolean(req.body?.enabled))
    // Only the prefix moved, but a DNS detour naming the old tag would stop
    // resolving through the tunnel. The id — and so the name — is untouched.
    retag(cfg, before, ep.tag)
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
    const { [wgKey(tag)]: _gone, ...rest } = readNames(NAMES_FILE)
    writeNames(NAMES_FILE, rest)
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
