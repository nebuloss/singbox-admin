/**
 * The app's own configuration file — everything it keeps for itself.
 *
 * That is: the password hash, and the display names. Both are small, both are
 * ours, both belong next to the install — so they share one `config.json`
 * rather than taking a file each. One thing to back up, one thing to lose.
 *
 * It is `$APP_DIR/config.json`, which sing-box's own `config.json` also is,
 * one directory away. Hence ADMIN_CONFIG and SINGBOX_CONFIG rather than two
 * variables both called config: the files are alike in name only.
 *
 * What is NOT here is anything sing-box needs to run. Access and routing live
 * in the sing-box configuration, where they can be read and edited directly.
 * Names are here precisely so that renaming never touches that file: sing-box
 * is only ever told a device's UUID and a tunnel's tag, and neither has to be
 * readable. Losing this file costs the password and the labels; every device
 * and tunnel keeps working.
 *
 * scrypt comes from Node's standard library, so this costs no dependency.
 */

import fs from 'fs'
import crypto from 'crypto'

const KEYLEN = 64
const COST = 16384 // scrypt N; ~100ms on modest hardware

export type Password = { hash: string; updated: string }
/** Display names by identifier — identifiers that never change. */
export type Names = Record<string, string>
/**
 * A device, as this app sees it.
 *
 * `token` (the key) is what the subscription URL carries and never changes.
 * `uuids` are the credentials sing-box knows, newest first: the head is what a
 * profile is served with, the rest are predecessors kept alive only as long as
 * something is still using them. Splitting the two is what lets a credential
 * be replaced without changing the address a device fetches from.
 */
export type Device = { name: string; uuids: string[]; rotated?: string }

export type AdminConfig = {
  password: Password | null
  publicUrl: string | null
  devices: Record<string, Device>
  /** Tunnel display names, by tunnel id. */
  tunnels: Names
  /** When each credential was last seen in sing-box's log, ISO 8601. */
  seen: Record<string, string>
}

const EMPTY: AdminConfig = { password: null, publicUrl: null, devices: {}, tunnels: {}, seen: {} }

/** Format: scrypt$<N>$<salt-hex>$<derived-hex> */
export function hashPassword(password: string): Password {
  const salt = crypto.randomBytes(16)
  const derived = crypto.scryptSync(password, salt, KEYLEN, { N: COST })
  return {
    hash: `scrypt$${COST}$${salt.toString('hex')}$${derived.toString('hex')}`,
    updated: new Date().toISOString(),
  }
}

export function verifyPassword(password: string, stored: string): boolean {
  const parts = stored.split('$')
  if (parts.length !== 4 || parts[0] !== 'scrypt') return false
  const cost = Number(parts[1])
  const salt = Buffer.from(parts[2], 'hex')
  const expected = Buffer.from(parts[3], 'hex')
  let derived: Buffer
  try {
    derived = crypto.scryptSync(password, salt, expected.length, { N: cost })
  } catch {
    return false
  }
  // Lengths match by construction, so timingSafeEqual is safe to call directly.
  return derived.length === expected.length && crypto.timingSafeEqual(derived, expected)
}

export function readAdminConfig(file: string): AdminConfig {
  try {
    const parsed: unknown = JSON.parse(fs.readFileSync(file, 'utf8'))
    if (!parsed || typeof parsed !== 'object') return EMPTY
    const { password, publicUrl, devices, tunnels, seen } = parsed as Partial<AdminConfig>
    const strings = (v: unknown): Record<string, string> =>
      v && typeof v === 'object' && !Array.isArray(v)
        ? Object.fromEntries(
            Object.entries(v).filter(
              (entry): entry is [string, string] => typeof entry[1] === 'string',
            ),
          )
        : {}
    return {
      password: typeof password?.hash === 'string' ? password : null,
      publicUrl: typeof publicUrl === 'string' && publicUrl ? publicUrl : null,
      devices:
        devices && typeof devices === 'object' && !Array.isArray(devices)
          ? Object.fromEntries(
              Object.entries(devices).filter(
                (entry): entry is [string, Device] =>
                  Boolean(entry[1]) && Array.isArray((entry[1] as Device).uuids),
              ),
            )
          : {},
      tunnels: strings(tunnels),
      seen: strings(seen),
    }
  } catch {
    // Missing or unreadable reads as empty: the interface then asks for a
    // password on first visit, which is better than refusing to start.
    return EMPTY
  }
}

/** Written through a temporary file, so a crash mid-write cannot truncate it. */
export function writeAdminConfig(file: string, state: AdminConfig): void {
  const tmp = `${file}.tmp`
  fs.writeFileSync(tmp, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 })
  fs.renameSync(tmp, file)
}

/** Read, change one part, write back — the only way this file is ever updated. */
export function updateAdminConfig(
  file: string,
  change: (c: AdminConfig) => AdminConfig,
): AdminConfig {
  const next = change(readAdminConfig(file))
  writeAdminConfig(file, next)
  return next
}
