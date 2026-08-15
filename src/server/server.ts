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
import dns from 'dns'
import QRCode from 'qrcode'
import {
  readAdminConfig,
  updateAdminConfig,
  mintLink,
  spendLink,
  type AdminConfig,
  type Device,
  hashPassword,
  verifyPassword,
  type Names,
} from './admin-config'

const app = express()
app.set('trust proxy', 1)
app.use(express.json())
app.use(cookieParser())

const PORT = Number(process.env.PORT ?? 3000)
// A second listener carrying only what the outside may see: a device's profile,
// and a cover page for everything else. It is a separate socket rather than a
// check inside the interface, so the administration cannot be reached from the
// public name by any request at all — there is no code path to it.
const PUBLIC_PORT_LISTEN = Number(process.env.PUBLIC_LISTEN ?? 3001)
const CONFIG_PATH = process.env.SINGBOX_CONFIG ?? '/etc/sing-box/config.json'
const SERVICE = process.env.SINGBOX_SERVICE ?? 'sing-box'
// PUBLIC_HOST / PUBLIC_PORT are a bootstrap, like ADMIN_PASSWORD: they seed
// the public address on first start and are never read again. From then on the
// address is a setting, editable in the interface — see publicBase().
const BOOTSTRAP_HOST = process.env.PUBLIC_HOST ?? ''
const BOOTSTRAP_PORT = Number(process.env.PUBLIC_PORT ?? 443)
// The app's own config: the password hash and the display names. Named apart
// from SINGBOX_CONFIG on purpose — both files are called config.json, and the
// two must never be confused for one another. ADMIN_PASSWORD is a bootstrap
// value only: on first start it is hashed into this file and never read again.
const ADMIN_CONFIG = process.env.ADMIN_CONFIG ?? path.join(__dirname, '..', 'config.json')
if (!readAdminConfig(ADMIN_CONFIG).password && process.env.ADMIN_PASSWORD) {
  const password = hashPassword(process.env.ADMIN_PASSWORD)
  updateAdminConfig(ADMIN_CONFIG, (s) => ({ ...s, password }))
  console.log(`mot de passe initial hache dans ${ADMIN_CONFIG}`)
}
if (!readAdminConfig(ADMIN_CONFIG).publicUrl && BOOTSTRAP_HOST && BOOTSTRAP_HOST !== 'example.com') {
  const port = BOOTSTRAP_PORT === 443 ? '' : `:${BOOTSTRAP_PORT}`
  const seeded = `https://${BOOTSTRAP_HOST}${port}`
  updateAdminConfig(ADMIN_CONFIG, (c) => ({ ...c, publicUrl: seeded }))
  console.log(`adresse publique initialisee a ${seeded}`)
}

// How often a device is asked to come back for its profile, and therefore how
// often its credential is replaced. The sweep retires a predecessor once it has
// gone quiet, so these bound a credential's life without needing to guess how
// long a device might be asleep.
const REFRESH_HOURS = Number(process.env.REFRESH_HOURS ?? 1)
const ROTATE_EVERY = Number(process.env.ROTATE_MINUTES ?? 10) * 60_000
const IDLE_RETIRE = Number(process.env.RETIRE_IDLE_MINUTES ?? 15) * 60_000
const SWEEP_EVERY = Number(process.env.SWEEP_SECONDS ?? 60) * 1_000

const credential = () => readAdminConfig(ADMIN_CONFIG).password
const readOnly = () => credential() === null

// ── Types kept deliberately loose: we only touch the users array and leave the
//    rest of the sing-box config untouched, whatever it contains.
// The credential, and its own identifier as a name. The name is not a display
// name — it never changes and no rename touches it — but sing-box logs it, and
// logs nothing useful without it: with no name it prints the array index, which
// shifts as soon as the list does. Naming each credential after itself is what
// makes the log say which credential was used.
type User = { uuid: string; name: string }
type Inbound = {
  type?: string
  tag?: string
  listen?: string
  listen_port?: number
  users?: User[]
  transport?: { type?: string; path?: string }
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
type Rule = { ip_cidr?: string[]; outbound?: string; action?: string; server?: string }
type DnsServer = { type?: string; tag?: string; server?: string; detour?: string }
type Config = {
  log?: { output?: string; [k: string]: unknown }
  inbounds?: Inbound[]
  endpoints?: Endpoint[]
  outbounds?: unknown[]
  dns?: { servers?: DnsServer[]; rules?: unknown[]; final?: string; [k: string]: unknown }
  route?: { rules?: Rule[]; final?: string; default_domain_resolver?: { server?: string }; [k: string]: unknown }
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

/**
 * Every address reachable from outside has the same shape: `/<identifier>`.
 * A device fetching its profile and a client opening the tunnel are told apart
 * by the WebSocket upgrade, not by the path — so from the outside there is
 * nothing to sort them by.
 *
 * The proxy is told that rule and nothing else: a shape and a header, never a
 * secret. Which identifier is the tunnel stays this app's business, which is
 * what lets it be rewritten without anyone else hearing about it.
 */
const UUID_PATH = '[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}'

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
 * Which inbound holds a device — the shelf if it is suspended, the public one
 * otherwise. A device's credentials always travel together: they are the same
 * device, and half of one on each shelf would mean half suspended.
 */
function homeOf(cfg: Config, uuids: string[]): Inbound | undefined {
  const parked = parkedInbound(cfg)
  if (parked?.users?.some((u) => uuids.includes(u.uuid))) return parked
  const live = liveInbound(cfg)
  return live.users?.some((u) => uuids.includes(u.uuid)) ? live : undefined
}

const dropUuids = (inbound: Inbound | undefined, uuids: string[]) => {
  if (inbound?.users) inbound.users = inbound.users.filter((u) => !uuids.includes(u.uuid))
}

/**
 * Write the config, verify it with `sing-box check`, restart the service.
 * On any failure the previous file is restored, so a bad edit can never leave
 * the tunnel down.
 */
/**
 * One writer at a time.
 *
 * Every mutation reads the configuration, changes it, and writes it back with
 * an await in between — so two of them overlapping would have the second write
 * erase the first's change. That is not hypothetical here: several devices can
 * fetch their profile at once, each replacing its own credential, and the
 * sweep runs on a timer regardless of what else is happening.
 */
let writing: Promise<unknown> = Promise.resolve()

function serialise<T>(work: () => Promise<T>): Promise<T> {
  const next = writing.then(work, work)
  writing = next.catch(() => undefined)
  return next
}

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

  // Reload, not restart. sing-box rebuilds its instance in place on SIGHUP:
  // the process survives, established transfers keep running, and a change to
  // the user list takes effect at once — measured, and the reason a credential
  // can be replaced often enough to be worth replacing at all. Restarting is
  // kept as the fallback for a service manager that cannot reload.
  const reload = await run('rc-service', [SERVICE, 'reload'])
  if (reload.ok) return
  const sdReload = await run('systemctl', ['reload', SERVICE])
  if (sdReload.ok) return

  const restart = await run('rc-service', [SERVICE, 'restart'])
  if (!restart.ok) {
    const sd = await run('systemctl', ['restart', SERVICE])
    if (!sd.ok) throw new Error(`redemarrage impossible : ${restart.out} ${sd.out}`)
  }
}

function linkFor(uuid: string, name: string | undefined, wsPath: string, base: PublicBase): string {
  const label = encodeURIComponent(name || uuid.slice(0, 8))
  const q = new URLSearchParams({
    encryption: 'none',
    security: 'tls',
    sni: base.host,
    type: 'ws',
    path: wsPath,
  })
  return `vless://${uuid}@${base.host}:${base.port}?${q}#${label}`
}

/**
 * A full client profile, served at a URL the device can subscribe to.
 *
 * What a vless:// link cannot say: which networks belong behind the tunnel, and
 * that everything should go through it. Both are here.
 *
 * Internal names then resolve without the device knowing anything about it —
 * the client hands the name to the tunnel and this host looks it up with the
 * tunnel's own resolver. That only holds while the client forwards names
 * rather than resolving them itself; a client in TUN mode may do the latter,
 * and then its own resolver has to be pointed at the tunnel's.
 */
/**
 * The tunnel's address as a number, resolved here rather than on the device.
 *
 * A device on a captive network can usually reach anything but is often unable
 * to ask a resolver of its own choosing: the network hands you one and drops
 * UDP/53 to everywhere else. A client that insists on its own resolver simply
 * times out — which is exactly the difference between this tunnel and plain
 * WireGuard, which dials a number and never asks anyone anything.
 *
 * The hostname stays as the TLS name, so the certificate still matches. If the
 * address changes, a profile is stale until its next refresh — which is why
 * this is done for the profile, that refreshes itself, and not for the link,
 * which is pasted once and never looks back.
 */
let addressCache: { host: string; ip: string; at: number } | null = null

async function publicAddress(host: string): Promise<string> {
  if (addressCache?.host === host && Date.now() - addressCache.at < 60_000) return addressCache.ip
  try {
    const { address } = await dns.promises.lookup(host, { family: 4 })
    addressCache = { host, ip: address, at: Date.now() }
    return address
  } catch {
    // Unresolvable from here is no reason to serve nothing: the device may
    // well manage where this host could not.
    return host
  }
}

function clientProfile(uuid: string, cfg: Config, wsPath: string, base: PublicBase, server: string) {
  const serving = wgEndpoints(cfg).find((e) => isEnabled(e.tag))
  const internal = serving?.peers?.[0]?.allowed_ips ?? []

  return {
    log: { level: 'warn' },
    // No DNS section, deliberately.
    //
    // Clients ship their own sing-box and it is rarely the version this host
    // runs: the DNS format changed between 1.11, 1.12 and 1.13, and a profile
    // written for one is refused outright by another — which is how a profile
    // that validated here failed to import at all. Resolution is also the one
    // thing every client already has settings for, so it is left to them.
    //
    // What the profile does carry is what a client cannot guess: where the
    // tunnel is, how to speak to it, and which networks belong behind it.
    inbounds: [
      {
        type: 'tun',
        tag: 'tun-in',
        address: ['172.19.0.1/30'],
        auto_route: true,
        strict_route: true,
      },
    ],
    outbounds: [
      {
        type: 'vless',
        tag: 'proxy',
        server,
        server_port: base.port,
        uuid,
        tls: { enabled: true, server_name: base.host },
        transport: { type: 'ws', path: wsPath },
      },
      { type: 'direct', tag: 'direct' },
    ],
    route: {
      rules: [
        // The tunnel's own networks, named explicitly so they hold even if the
        // profile is later edited to stop routing everything.
        ...(internal.length ? [{ ip_cidr: internal, outbound: 'proxy' }] : []),
      ],
      final: 'proxy',
    },
    experimental: {
      cache_file: { enabled: true },
    },
  }
}

/**
 * The one public address, and everything derived from it.
 *
 * A device needs to know two things: where the tunnel answers, and where to
 * fetch its profile. Both are the same host in every sane deployment, so they
 * are one setting rather than two — an origin like `https://tunnel.example.com`
 * or `https://tunnel.example.com:8443`.
 *
 * Unset, it falls back to however the interface was reached. That is right on
 * a first visit and wrong as soon as the interface lives on an internal name
 * the phone cannot resolve, which is why it is worth setting.
 */
/**
 * The reverse-proxy configuration for the public name.
 *
 * It names no path and no shape: an upgrade is the tunnel, anything else is the
 * public listener. That is the whole rule, so regenerating the tunnel path — or
 * adding a device — never touches the proxy.
 */
function proxySnippet(cfg: Config, appPort: number): string {
  const singbox = liveInbound(cfg).listen_port ?? 8081
  // The address the proxy has to dial. This process runs on the sing-box host,
  // so its own LAN address is the right answer whether the proxy sits here or
  // on another machine — which loopback would not be.
  const host =
    Object.values(os.networkInterfaces())
      .flat()
      .find((i) => i && i.family === 'IPv4' && !i.internal)?.address ?? '127.0.0.1'
  return [
    '# Un upgrade WebSocket est le tunnel ; tout le reste est la vitrine',
    "# publique de l'interface, qui ne sert que les profils et une page",
    '# quelconque. Aucun chemin, aucune forme : rien a tenir a jour ici.',
    'location / {',
    `  set $backend ${host}:${appPort};`,
    `  if ($http_upgrade ~* websocket) { set $backend ${host}:${singbox}; }`,
    '  proxy_pass http://$backend;',
    '  proxy_set_header Host $host;',
    '  proxy_set_header X-Real-IP $remote_addr;',
    '  proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;',
    '  proxy_set_header X-Forwarded-Proto $scheme;',
    '  proxy_set_header Upgrade $http_upgrade;',
    '  proxy_set_header Connection $http_connection;',
    '  proxy_http_version 1.1;',
    '  proxy_read_timeout 86400s;',
    '  proxy_send_timeout 86400s;',
    "  # Un refus de sing-box ressort en 404 comme le reste : meme corps, meme",
    '  # statut, quelle que soit la raison.',
    '  proxy_intercept_errors on;',
    '  error_page 400 401 403 404 500 502 503 504 =404 @vitrine;',
    '}',
    '',
    'location @vitrine {',
    `  proxy_pass http://${host}:${appPort};`,
    '  proxy_set_header Host $host;',
    '}',
  ].join('\n')
}

type PublicBase = { origin: string; host: string; port: number }

function publicBase(req: express.Request): PublicBase {
  const configured = readAdminConfig(ADMIN_CONFIG).publicUrl
  const proto = String(req.headers['x-forwarded-proto'] ?? '').split(',')[0] || req.protocol
  const raw = configured ?? `${proto}://${req.get('host') ?? 'example.com'}`
  try {
    const url = new URL(raw)
    return {
      origin: url.origin,
      host: url.hostname,
      port: Number(url.port) || (url.protocol === 'http:' ? 80 : 443),
    }
  } catch {
    return { origin: 'https://example.com', host: 'example.com', port: 443 }
  }
}

/**
 * Parse a standard WireGuard client configuration — the .conf a router or
 * provider hands you — into a sing-box endpoint. Accepting that format
 * directly avoids retyping five fields and getting one wrong.
 */
function parseWireguard(text: string): { endpoint: Endpoint; allowedIps: string[]; dns: string | null } {
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
  // The router names its own resolver; that is what makes internal names work.
  const dns = get('Interface', 'DNS')
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
    dns: dns?.split(',')[0].trim() || null,
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
 * off. Nothing stores the old tag: anything referencing a tunnel is re-pointed
 * from the id it already names.
 */
const isWgTag = (tag: string) => tag.startsWith(`${WG_ON}-`) || tag.startsWith(`${WG_OFF}-`)
const isEnabled = (tag: string) => tag.startsWith(`${WG_ON}-`)
const wgId = (tag: string) => tag.slice(tag.indexOf('-') + 1)
const withState = (tag: string, on: boolean) => `${on ? WG_ON : WG_OFF}-${wgId(tag)}`
const newWgId = () => crypto.randomBytes(4).toString('hex')

/** How a display name is filed for a tunnel: by its id, stable across on/off. */
const wgKey = (tag: string) => wgId(tag)

const wgEndpoints = (cfg: Config) => (cfg.endpoints ?? []).filter((e) => isWgTag(e.tag))

/**
 * DNS follows the tunnel.
 *
 * A WireGuard configuration names the resolver to use — that DNS line is what
 * makes internal names resolve at all — so each tunnel carries its own server
 * entry, reached through that tunnel. Whichever tunnel is serving lends its
 * resolver to `default_domain_resolver`, and with the outbound off we fall back
 * to the public one rather than pointing at something unreachable.
 *
 * That last knob is the one that matters: sing-box resolves a domain arriving
 * through the tunnel with it and does NOT consult `dns.rules` on the way — a
 * rule there looks right and decides nothing.
 */
const DNS_PREFIX = 'dns-wg-'
const dnsTag = (id: string) => `${DNS_PREFIX}${id}`
const isOurDns = (tag?: string) => Boolean(tag?.startsWith(DNS_PREFIX))
const dnsIdOf = (tag: string) => tag.slice(DNS_PREFIX.length)

const dnsFor = (cfg: Config, ep: Endpoint) =>
  (cfg.dns?.servers ?? []).find((d) => d.tag === dnsTag(wgId(ep.tag)))

/** Point a tunnel at a resolver, or drop the entry when the address is cleared. */
function setTunnelDns(cfg: Config, ep: Endpoint, server: string | null) {
  cfg.dns = cfg.dns ?? {}
  cfg.dns.servers = cfg.dns.servers ?? []
  const tag = dnsTag(wgId(ep.tag))
  cfg.dns.servers = cfg.dns.servers.filter((d) => d.tag !== tag)
  if (server) cfg.dns.servers.push({ type: 'udp', tag, server, detour: ep.tag })
}

/**
 * The tunnel currently carrying traffic, if any — counting only a rule that
 * points at a tunnel still present.
 *
 * A rule naming a tag nobody defines is stale, from a hand-edited config, and
 * taking it at face value would report the outbound as on while sing-box
 * refuses to start on exactly that dangling reference.
 */
function activeTarget(cfg: Config): string | null {
  const tags = new Set(wgEndpoints(cfg).map((e) => e.tag))
  const rule = cfg.route?.rules?.find((r) => r.outbound && tags.has(r.outbound))
  return rule?.outbound ?? null
}

/**
 * Everything derived from the tunnel list, rebuilt in one pass.
 *
 * Routing and DNS are one decision, not two: the rule that sends traffic into
 * a tunnel and the resolver that tells it where to go have to name the same
 * tunnel, or names resolve one way and connect another. Keeping them in
 * separate functions meant calling them in the right order at six call sites,
 * and getting it wrong twice.
 *
 * `on` is the outbound switch. It has to come from the caller: it is encoded in
 * the very rules this rebuilds, so it must be read before anything changes —
 * which is what withTunnels() below is for.
 */
function applyTunnelState(cfg: Config, on: boolean) {
  cfg.dns = cfg.dns ?? {}
  cfg.route = cfg.route ?? {}
  const live = wgEndpoints(cfg)
  const byId = new Map(live.map((e) => [wgId(e.tag), e]))

  // Our DNS entries live as long as their tunnel does. Any detour naming a
  // tunnel — ours or hand-written — is re-pointed at that tunnel's current
  // tag, which is how switching one on or off carries its references along.
  cfg.dns.servers = (cfg.dns.servers ?? []).filter(
    (d) => !isOurDns(d.tag) || byId.has(dnsIdOf(d.tag!)),
  )
  for (const d of cfg.dns.servers) {
    const ep = d.detour && isWgTag(d.detour) ? byId.get(wgId(d.detour)) : undefined
    if (ep) d.detour = ep.tag
  }

  cfg.route.rules = (cfg.route.rules ?? []).filter(
    (r) => !(r.outbound && isWgTag(r.outbound)) && r.action !== 'resolve',
  )

  const serving = on ? live.find((e) => isEnabled(e.tag)) : undefined
  const resolver = serving ? dnsFor(cfg, serving) : undefined

  if (serving) {
    // Routing matches on the destination address, and a client sends a name.
    // Without resolving first, an ip_cidr rule cannot match and the connection
    // leaves by `direct` — which is how internal names stayed unreachable even
    // once they resolved correctly. The resolver has to be named here too:
    // left implicit, this action does not use default_domain_resolver.
    if (resolver?.tag) cfg.route.rules.push({ action: 'resolve', server: resolver.tag })
    // Route exactly what the peer accepts, so a split tunnel stays split.
    cfg.route.rules.push({ ip_cidr: serving.peers?.[0]?.allowed_ips ?? [], outbound: serving.tag })
  }

  // With no tunnel serving, fall back to a resolver that answers rather than
  // pointing at one only reachable through a tunnel that is off.
  const fallback = cfg.dns.servers.find((d) => !isOurDns(d.tag))?.tag
  const chosen = resolver?.tag ?? fallback
  if (chosen) cfg.route.default_domain_resolver = { server: chosen }
}

/**
 * The only way tunnels are ever written: read the outbound state, apply the
 * change, rebuild what follows from it. The order is the whole point — the
 * state is encoded in the rules being rebuilt, so reading it afterwards reads
 * the rebuild, not the intent.
 */
function withTunnels(cfg: Config, change: () => void, force?: boolean): Promise<void> {
  return serialise(async () => {
    const on = force ?? activeTarget(cfg) !== null
    change()
    applyTunnelState(cfg, on)
    await commit(cfg)
  })
}

function wireguardSummary(cfg: Config, tunnels: Names) {
  const profiles = wgEndpoints(cfg).map((e) => {
    const peer = e.peers?.[0]
    // The private key is never returned.
    return {
      tag: e.tag,
      name: tunnels[wgKey(e.tag)] ?? wgId(e.tag),
      enabled: isEnabled(e.tag),
      address: e.address,
      peer: peer ? `${peer.address}:${peer.port}` : null,
      publicKey: peer?.public_key ?? null,
      allowedIps: peer?.allowed_ips ?? [],
      keepalive: peer?.persistent_keepalive_interval ?? null,
      dns: dnsFor(cfg, e)?.server ?? null,
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
  if (credential()) return res.status(409).json({ error: 'un mot de passe est deja defini' })
  const chosen = String(req.body?.password ?? '')
  if (chosen.length < 10) return res.status(400).json({ error: '10 caracteres minimum' })

  try {
    updateAdminConfig(ADMIN_CONFIG, (s) => ({ ...s, password: hashPassword(chosen) }))
  } catch (e) {
    return res.status(500).json({ error: `ecriture impossible : ${(e as Error).message}` })
  }

  const token = crypto.randomBytes(32).toString('hex')
  sessions.add(token)
  res.cookie('sbsession', token, { httpOnly: true, sameSite: 'strict', secure: true, maxAge: 12 * 3600e3 })
  res.json({ ok: true })
})

app.post('/api/login', (req, res) => {
  const current = credential()
  if (!current) return res.status(409).json({ error: 'aucun mot de passe defini' })
  if (!verifyPassword(String(req.body?.password ?? ''), current.hash))
    return res.status(401).json({ error: 'mot de passe incorrect' })

  const token = crypto.randomBytes(32).toString('hex')
  sessions.add(token)
  res.cookie('sbsession', token, { httpOnly: true, sameSite: 'strict', secure: true, maxAge: 12 * 3600e3 })
  res.json({ ok: true })
})

app.post('/api/password', requireAuth, (req, res) => {
  const current = String(req.body?.current ?? '')
  const next = String(req.body?.next ?? '')
  const stored = credential()
  if (!stored || !verifyPassword(current, stored.hash))
    return res.status(401).json({ error: 'mot de passe actuel incorrect' })
  if (next.length < 10) return res.status(400).json({ error: '10 caracteres minimum' })
  if (next === current) return res.status(400).json({ error: 'identique a l actuel' })

  try {
    updateAdminConfig(ADMIN_CONFIG, (s) => ({ ...s, password: hashPassword(next) }))
  } catch (e) {
    return res.status(500).json({ error: `ecriture impossible : ${(e as Error).message}` })
  }

  // Every other session is dropped: a password change should evict anyone who
  // authenticated with the old one. The caller keeps its own cookie.
  const keep = req.cookies?.sbsession
  for (const t of sessions) if (t !== keep) sessions.delete(t)
  res.json({ ok: true })
})

/**
 * A sign-in link, made from a session and spent once.
 *
 * Meant to be created where you are already signed in and scanned where you are
 * not — a phone, mostly, which is where typing a long password is worst.
 *
 * The token rides in the URL fragment, which browsers never send to a server:
 * it cannot turn up in an access log, a proxy's history or a Referer header the
 * way a query string would. It is worth as much as the password while it lives,
 * so it lives briefly and dies on first use, whether that use succeeds or not.
 */
const LINK_TTL = Number(process.env.LINK_MINUTES ?? 10) * 60_000

app.post('/api/session/link', requireAuth, async (req, res) => {
  // An identifier, like everything else here. A hundred and twenty-two random
  // bits are far past guessing for something that lives ten minutes and once.
  const token = mintLink(ADMIN_CONFIG, LINK_TTL)

  const proto = String(req.headers['x-forwarded-proto'] ?? '').split(',')[0] || req.protocol
  // Built from the address this interface was reached on, not the tunnel's:
  // the administration lives on the internal name and stays there.
  //
  // Section and token share the fragment, which a browser never sends to a
  // server: the link can point at a page without the token ever reaching an
  // access log, which a query string could not promise.
  const section = String(req.body?.section ?? '').replace(/[^a-z]/g, '') || 'appareils'
  const url = `${proto}://${req.get('host')}/#${section}&login=${token}`
  res.json({ url, minutes: Math.round(LINK_TTL / 60_000), qr: await QRCode.toString(url, { type: 'svg', margin: 1 }) })
})

app.post('/api/session/claim', (req, res) => {
  // Spent on sight: a link that failed is a link that is gone.
  if (!spendLink(ADMIN_CONFIG, String(req.body?.token ?? '')))
    return res.status(401).json({ error: 'lien expire ou deja utilise' })

  const session = crypto.randomBytes(32).toString('hex')
  sessions.add(session)
  res.cookie('sbsession', session, { httpOnly: true, sameSite: 'strict', secure: true, maxAge: 12 * 3600e3 })
  res.json({ ok: true })
})

app.post('/api/logout', (req, res) => {
  const t = req.cookies?.sbsession
  if (typeof t === 'string') sessions.delete(t)
  res.clearCookie('sbsession')
  res.json({ ok: true })
})

app.get('/api/state', async (req, res) => {
  if (!authed(req)) return res.json({ authed: false, setup: credential() === null })
  try {
    const cfg = readConfig()
    const inbound = liveInbound(cfg)
    const wsPath = inbound.transport?.path ?? '/'
    const version = (await run('sing-box', ['version'])).out.split('\n')[0] ?? ''
    const status = await run('rc-service', [SERVICE, 'status'])

    const admin = readAdminConfig(ADMIN_CONFIG)
    const base = publicBase(req)
    const live = new Set((inbound.users ?? []).map((u) => u.uuid))
    const users = await Promise.all(
      Object.entries(admin.devices).map(async ([token, d]) => {
        const current = d.uuids[0]
        const sub = `${base.origin}/${token}`
        const label = d.name || token.slice(0, 8)
        // What the QR carries. Both Hiddify and the official sing-box client
        // register this scheme and read url and name out of it, so a scan
        // installs the profile instead of dropping the operator into a form.
        const imp = `sing-box://import-remote-profile?url=${encodeURIComponent(sub)}#${encodeURIComponent(label)}`
        return {
          token,
          name: d.name,
          // Suspended devices keep their address and their link: it is what
          // makes them work again the moment they are put back.
          enabled: live.has(current),
          sub,
          link: linkFor(current, d.name, wsPath, base),
          qr: await QRCode.toString(imp, { type: 'svg', margin: 1 }),
        }
      }),
    )
    res.json({
      authed: true,
      users,
      service: { running: /started|running|active/i.test(status.out), version },
      tunnel: { host: base.host, port: base.port, path: wsPath },
      publicUrl: readAdminConfig(ADMIN_CONFIG).publicUrl,
      proxySnippet: proxySnippet(cfg, PUBLIC_PORT_LISTEN),
      wireguard: wireguardSummary(cfg, admin.tunnels),
    })
  } catch (e) {
    res.status(500).json({ error: String((e as Error).message) })
  }
})

// Letters of any script, so an accented or non-Latin name is not "invalid".
const NAME_RE = /^[\p{L}\p{N} ._@()'’-]{1,40}$/u

const taken = (entries: [string, string][], name: string, except?: string) =>
  entries.some(([k, v]) => k !== except && v.toLocaleLowerCase() === name.toLocaleLowerCase())

const deviceEntries = (admin: AdminConfig): [string, string][] =>
  Object.entries(admin.devices).map(([token, d]) => [token, d.name])

/**
 * Replace a device's credential, keeping the old one alive.
 *
 * The device is not here to be told: it will learn the new credential when it
 * next fetches its profile, and until then the old one has to keep working.
 * Retirement is left to the sweep, which drops a predecessor once nothing has
 * used it for a while — so a credential's life is bounded by its use, not by a
 * guess at how long a device might be asleep.
 *
 * Rate-limited: a device that fetches its profile in a loop must not grow the
 * credential list without bound.
 */
function rotate(token: string, device: Device): Promise<string> {
  return serialise(() => rotateNow(token, device))
}

async function rotateNow(token: string, device: Device): Promise<string> {
  const now = Date.now()
  const last = device.rotated ? Date.parse(device.rotated) : 0
  if (Number.isFinite(last) && now - last < ROTATE_EVERY) return device.uuids[0]

  const fresh = crypto.randomUUID()
  const cfg = readConfig()
  const home = homeOf(cfg, device.uuids) ?? liveInbound(cfg)
  home.users = [...(home.users ?? []), { uuid: fresh, name: fresh }]
  await commit(cfg)

  updateAdminConfig(ADMIN_CONFIG, (c) => {
    const d = c.devices[token]
    if (!d) return c
    return {
      ...c,
      devices: {
        ...c.devices,
        [token]: { ...d, uuids: [fresh, ...d.uuids], rotated: new Date(now).toISOString() },
      },
    }
  })
  return fresh
}

app.post('/api/users', requireAuth, async (req, res) => {
  const name = String(req.body?.name ?? '').trim()
  if (!NAME_RE.test(name)) return res.status(400).json({ error: 'nom invalide' })
  try {
    const admin = readAdminConfig(ADMIN_CONFIG)
    if (taken(deviceEntries(admin), name))
      return res.status(409).json({ error: 'ce nom existe deja' })

    const token = crypto.randomUUID()
    const uuid = crypto.randomUUID()
    const cfg = readConfig()
    liveInbound(cfg).users!.push({ uuid, name: uuid })
    await commit(cfg)
    updateAdminConfig(ADMIN_CONFIG, (c) => ({
      ...c,
      devices: { ...c.devices, [token]: { name, uuids: [uuid] } },
    }))
    res.json({ ok: true, token })
  } catch (e) {
    res.status(500).json({ error: String((e as Error).message) })
  }
})

app.delete('/api/users/:token', requireAuth, async (req, res) => {
  try {
    const admin = readAdminConfig(ADMIN_CONFIG)
    const device = admin.devices[req.params.token]
    if (!device) return res.status(404).json({ error: 'inconnu' })
    if (Object.keys(admin.devices).length === 1)
      return res.status(400).json({ error: 'refus : cela supprimerait le dernier acces' })

    const cfg = readConfig()
    dropUuids(liveInbound(cfg), device.uuids)
    dropUuids(parkedInbound(cfg), device.uuids)
    await commit(cfg)

    updateAdminConfig(ADMIN_CONFIG, (c) => {
      const { [req.params.token]: _gone, ...devices } = c.devices
      const seen = Object.fromEntries(
        Object.entries(c.seen).filter(([uuid]) => !device.uuids.includes(uuid)),
      )
      return { ...c, devices, seen }
    })
    res.json({ ok: true })
  } catch (e) {
    res.status(500).json({ error: String((e as Error).message) })
  }
})

/** Renaming writes our own file and stops there — see the note on names. */
app.patch('/api/users/:token', requireAuth, (req, res) => {
  const name = String(req.body?.name ?? '').trim()
  if (!NAME_RE.test(name)) return res.status(400).json({ error: 'nom invalide' })
  try {
    const admin = readAdminConfig(ADMIN_CONFIG)
    if (!admin.devices[req.params.token]) return res.status(404).json({ error: 'inconnu' })
    if (taken(deviceEntries(admin), name, req.params.token))
      return res.status(409).json({ error: 'ce nom existe deja' })

    updateAdminConfig(ADMIN_CONFIG, (c) => ({
      ...c,
      devices: { ...c.devices, [req.params.token]: { ...c.devices[req.params.token], name } },
    }))
    res.json({ ok: true })
  } catch (e) {
    res.status(500).json({ error: String((e as Error).message) })
  }
})

app.post('/api/users/:token/enabled', requireAuth, async (req, res) => {
  try {
    const admin = readAdminConfig(ADMIN_CONFIG)
    const device = admin.devices[req.params.token]
    if (!device) return res.status(404).json({ error: 'inconnu' })

    const cfg = readConfig()
    const wanted = Boolean(req.body?.enabled)
    const from = wanted ? parkedInbound(cfg) : liveInbound(cfg)
    const moving = (from?.users ?? []).filter((u) => device.uuids.includes(u.uuid))
    if (!moving.length) return res.json({ ok: true })

    dropUuids(from, device.uuids)
    const to = wanted ? liveInbound(cfg) : shelf(cfg)
    to.users = [...(to.users ?? []), ...moving]

    await commit(cfg)
    res.json({ ok: true })
  } catch (e) {
    res.status(400).json({ error: String((e as Error).message) })
  }
})

app.post('/api/tunnel/path', requireAuth, async (req, res) => {
  try {
    const cfg = readConfig()
    const inbound = liveInbound(cfg)
    if (!inbound.transport || inbound.transport.type !== 'ws')
      return res.status(400).json({ error: 'l inbound n utilise pas un transport ws' })

    // Shaped like every other reachable address: from outside, a profile and
    // the tunnel are both /<identifier>, and only the WebSocket upgrade tells
    // them apart. Nothing on the outside can sort one from the other by looking.
    inbound.transport.path = `/${crypto.randomUUID()}`
    await commit(cfg)
    res.json({ ok: true, path: inbound.transport.path })
  } catch (e) {
    res.status(500).json({ error: String((e as Error).message) })
  }
})

app.post('/api/wireguard', requireAuth, async (req, res) => {
  try {
    const name = String(req.body?.name ?? '').trim()
    if (!/^[\w .@-]{1,40}$/.test(name)) return res.status(400).json({ error: 'nom invalide' })

    const tunnels = readAdminConfig(ADMIN_CONFIG).tunnels
    const { endpoint, dns } = parseWireguard(String(req.body?.config ?? ''))
    endpoint.tag = `${WG_ON}-${newWgId()}`

    const cfg = readConfig()
    const existing = wgEndpoints(cfg)

    // Two ways to end up with the same tunnel twice, both worth refusing: the
    // same name, and the same peer pasted under a different name. The second
    // is the one that actually bites — a duplicate would sit in the list doing
    // nothing, since only the first enabled one ever serves.
    if (taken(Object.entries(tunnels), name))
      return res.status(409).json({ error: 'un tunnel porte deja ce nom' })

    const peer = endpoint.peers[0]
    const same = existing.find((e) => {
      const p = e.peers?.[0]
      return p && p.public_key === peer.public_key && p.address === peer.address && p.port === peer.port
    })
    // Shaped as "<message> : <detail>" like the other messages carrying a
    // variable part, so the interface can translate the fixed half of it.
    if (same)
      return res.status(409).json({
        error: `ce tunnel est deja configure sous le nom : ${tunnels[wgKey(same.tag)] ?? wgId(same.tag)}`,
      })

    await withTunnels(cfg, () => {
      cfg.endpoints = [...(cfg.endpoints ?? []), endpoint]
      // The DNS line of the pasted configuration, if it had one.
      setTunnelDns(cfg, endpoint, dns)
    })
    updateAdminConfig(ADMIN_CONFIG, (c) => ({ ...c, tunnels: { ...c.tunnels, [wgKey(endpoint.tag)]: name } }))
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

    const tunnels = readAdminConfig(ADMIN_CONFIG).tunnels
    if (taken(Object.entries(tunnels), name, wgKey(ep.tag)))
      return res.status(409).json({ error: 'un tunnel porte deja ce nom' })

    const clash = wgEndpoints(cfg)
      .filter((e) => e !== ep)
      .find((e) => {
        const p = e.peers?.[0]
        return p && p.public_key === publicKey && p.address === host && p.port === port
      })
    if (clash)
      return res.status(409).json({
        error: `ce tunnel est deja configure sous le nom : ${tunnels[wgKey(clash.tag)] ?? wgId(clash.tag)}`,
      })

    // Absent means "leave it alone"; empty means "clear it". Treating the two
    // alike let a request that never mentioned DNS wipe the tunnel's resolver,
    // and with it the rule that routes internal names.
    const dnsGiven = req.body?.dns !== undefined
    const dns = String(req.body?.dns ?? '').trim()
    const keepalive = Number(req.body?.keepalive)
    const peer = ep.peers?.[0]
    if (!peer) return res.status(400).json({ error: 'tunnel sans pair' })

    // The tag holds a permanent id, so nothing here renames it. Only the peer
    // fields and the resolver can change, and only those are worth a write.
    const currentDns = dnsFor(cfg, ep)?.server ?? null
    const nextDns = dnsGiven ? dns || null : currentDns
    const before = JSON.stringify([ep.address, peer, currentDns])
    ep.address = address
    peer.address = host
    peer.port = port
    peer.public_key = publicKey
    peer.allowed_ips = allowedIps
    peer.persistent_keepalive_interval = Number.isInteger(keepalive) && keepalive > 0 ? keepalive : 25

    // AllowedIPs and the resolver both feed what gets rebuilt, so a change to
    // either is worth a write — and nothing else is.
    if (JSON.stringify([ep.address, peer, nextDns]) !== before) {
      await withTunnels(cfg, () => setTunnelDns(cfg, ep, nextDns))
    }
    updateAdminConfig(ADMIN_CONFIG, (c) => ({ ...c, tunnels: { ...c.tunnels, [wgKey(ep.tag)]: name } }))
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

    await withTunnels(cfg, () => {
      const others = (cfg.endpoints ?? []).filter((e) => !isWgTag(e.tag))
      cfg.endpoints = [...others, ...tags.map((t) => wgs.find((e) => e.tag === t)!)]
    })
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
    await withTunnels(cfg, () => {}, on)
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

    await withTunnels(cfg, () => {
      ep.tag = withState(ep.tag, Boolean(req.body?.enabled))
    })
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

    // Routing is rebuilt from what remains: a rule pointing at a deleted
    // endpoint is rejected by sing-box outright.
    await withTunnels(cfg, () => {
      cfg.endpoints = (cfg.endpoints ?? []).filter((e) => e.tag !== tag)
    })
    updateAdminConfig(ADMIN_CONFIG, (c) => {
      const { [wgKey(tag)]: _gone, ...rest } = c.tunnels
      return { ...c, tunnels: rest }
    })
    res.json({ ok: true })
  } catch (e) {
    res.status(500).json({ error: String((e as Error).message) })
  }
})

/**
 * The public face: a device's profile, and an unremarkable page for everything
 * else. Deliberately a separate Express app on its own socket — the interface
 * and its API are simply not mounted here, so no request arriving from outside
 * can reach them however it is shaped.
 */
const LANDING = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex, nofollow">
<title>Static Asset Delivery</title>
<style>
  body { margin:0; min-height:100vh; display:flex; align-items:center; justify-content:center;
         font:15px/1.6 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
         background:#fafafa; color:#333 }
  main { max-width:30rem; padding:2rem }
  h1 { font-size:1.15rem; font-weight:600; margin:0 0 .75rem }
  p { margin:0 0 .6rem; color:#666 }
  @media (prefers-color-scheme: dark) { body{background:#16181a;color:#d6d6d6} p{color:#9a9a9a} }
</style>
</head>
<body><main>
  <h1>Static asset delivery</h1>
  <p>This host serves cached static resources. There is no browsable index.</p>
</main></body>
</html>
`

/**
 * What a host like this owes a request for something it does not have: a 404,
 * like any other origin. Answering everything with the front page would be the
 * tell — it is the one behaviour no real asset host has.
 *
 * Uniform all the same: every address that is not a profile gets this exact
 * body and status, the tunnel's own included when asked without an upgrade.
 */
const NOT_FOUND = `<!doctype html>
<html lang="en">
<head><meta charset="utf-8"><title>404 Not Found</title></head>
<body><h1>404 Not Found</h1><p>No such asset.</p></body>
</html>
`

const publicApp = express()
publicApp.disable('x-powered-by')

publicApp.get('/', (_req, res) => res.type('html').send(LANDING))

publicApp.get(`/:token(${UUID_PATH})`, async (req, res) => {
  try {
    const device = readAdminConfig(ADMIN_CONFIG).devices[req.params.token]
    // A token nobody holds is answered exactly like any other address: there
    // is no reply that says "not this one".
    if (!device) return res.status(404).type('html').send(NOT_FOUND)

    // Fetching a profile is the one moment a device is listening, so it is
    // when a credential is replaced: it leaves with the new one in hand.
    const uuid = await rotate(req.params.token, device)

    const cfg = readConfig()
    const wsPath = liveInbound(cfg).transport?.path ?? '/'
    const name = device.name || req.params.token.slice(0, 8)
    res.set('profile-title', `base64:${Buffer.from(name, 'utf8').toString('base64')}`)
    res.set('profile-update-interval', String(REFRESH_HOURS))
    const base = publicBase(req)
    res
      .type('application/json')
      .send(
        JSON.stringify(
          clientProfile(uuid, cfg, wsPath, base, await publicAddress(base.host)),
          null,
          2,
        ),
      )
  } catch {
    res.status(404).type('html').send(NOT_FOUND)
  }
})

publicApp.use((_req, res) => res.status(404).type('html').send(NOT_FOUND))

publicApp.listen(PUBLIC_PORT_LISTEN, () => {
  console.log(`vitrine publique on :${PUBLIC_PORT_LISTEN} — profils et page de couverture`)
})

/**
 * Who is still using which credential.
 *
 * sing-box names the credential in every connection line — that is the whole
 * reason each one is named after itself. Reading the log costs nothing and adds
 * no surface: no extra listener, no counters to reconcile across reloads.
 *
 * A predecessor is retired once nothing has used it for a while. The current
 * credential is never retired, however quiet: a device may simply be asleep,
 * and it is the one thing that would lock it out for good.
 */
// Start at the end of the log, not the beginning. Reading what is already
// there would stamp connections from days ago as happening now, and nothing
// would ever look idle enough to retire.
let logOffset = -1

function observeLog(): Record<string, string> {
  const seen: Record<string, string> = {}
  try {
    const path = readConfig().log?.output
    if (!path) return seen
    const size = fs.statSync(path).size
    if (logOffset < 0) {
      logOffset = size
      return seen
    }
    // Truncated or rotated: start over rather than read from beyond the end.
    if (size < logOffset) logOffset = 0
    if (size === logOffset) return seen
    const fd = fs.openSync(path, 'r')
    const buf = Buffer.alloc(size - logOffset)
    fs.readSync(fd, buf, 0, buf.length, logOffset)
    fs.closeSync(fd)
    logOffset = size
    const now = new Date().toISOString()
    for (const m of buf.toString('utf8').matchAll(/\[([0-9a-fA-F-]{36})\]/g)) seen[m[1]] = now
  } catch {
    // A missing or unreadable log only means no news, never a reason to retire.
  }
  return seen
}

const sweep = () => serialise(sweepNow)

async function sweepNow(): Promise<void> {
  const fresh = observeLog()
  const now = Date.now()

  const stale: string[] = []
  updateAdminConfig(ADMIN_CONFIG, (c) => {
    const seen = { ...c.seen, ...fresh }
    const at = (uuid: string) => (seen[uuid] ? Date.parse(seen[uuid]) : 0)
    for (const device of Object.values(c.devices)) {
      // Only retire once the current credential has been seen more recently
      // than the one being retired. That proves two things at once: the device
      // has moved on, and connections are being logged at all. Without it, a
      // log turned down to warnings would look like silence, and a device
      // still on its old credential would be cut off.
      const current = at(device.uuids[0])
      for (const uuid of device.uuids.slice(1)) {
        if (current > at(uuid) && now - at(uuid) > IDLE_RETIRE) stale.push(uuid)
      }
    }
    if (!stale.length) return { ...c, seen }
    return {
      ...c,
      seen: Object.fromEntries(Object.entries(seen).filter(([u]) => !stale.includes(u))),
      devices: Object.fromEntries(
        Object.entries(c.devices).map(([token, d]) => [
          token,
          { ...d, uuids: d.uuids.filter((u) => !stale.includes(u)) },
        ]),
      ),
    }
  })

  if (!stale.length) return
  const cfg = readConfig()
  dropUuids(liveInbound(cfg), stale)
  dropUuids(parkedInbound(cfg), stale)
  await commit(cfg)
  console.log(`identifiants retires faute d usage : ${stale.length}`)
}

/**
 * Take in credentials this app did not create.
 *
 * The install script writes the first one, and a configuration may be edited by
 * hand. Without this they would exist for sing-box and be invisible here — no
 * name, no link, no way to revoke them from the interface, which is the worst
 * of both worlds.
 */
function adopt(): void {
  const cfg = readConfig()
  const known = new Set(
    Object.values(readAdminConfig(ADMIN_CONFIG).devices).flatMap((d) => d.uuids),
  )
  const orphans = allUsers(cfg)
    .map((u) => u.uuid)
    .filter((uuid) => !known.has(uuid))
  if (!orphans.length) return

  updateAdminConfig(ADMIN_CONFIG, (c) => ({
    ...c,
    devices: {
      ...c.devices,
      ...Object.fromEntries(
        orphans.map((uuid) => [uuid, { name: `appareil ${uuid.slice(0, 8)}`, uuids: [uuid] }]),
      ),
    },
  }))
  console.log(`identifiants adoptes : ${orphans.length}`)
}

try {
  adopt()
} catch (e) {
  console.error('adoption:', (e as Error).message)
}

setInterval(() => {
  void sweep().catch((e) => console.error('balayage:', (e as Error).message))
}, SWEEP_EVERY)

// ── SPA. __dirname is dist-server/ at runtime, so the bundle sits in ../dist.
const distDir = path.join(__dirname, '..', 'dist')
app.use(express.static(distDir))
app.get('*', (_req, res) => res.sendFile(path.join(distDir, 'index.html')))

app.listen(PORT, () => {
  console.log(`singbox-admin on :${PORT} — config ${CONFIG_PATH}${readOnly() ? ' (aucun mot de passe : lecture seule)' : ''}`)
})
