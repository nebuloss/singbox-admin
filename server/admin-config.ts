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
/** Keyed by device UUID, or `wg:<id>` for a tunnel — identifiers that never change. */
export type Names = Record<string, string>
export type AdminConfig = { password: Password | null; names: Names }

const EMPTY: AdminConfig = { password: null, names: {} }

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
    const { password, names } = parsed as Partial<AdminConfig>
    return {
      password: typeof password?.hash === 'string' ? password : null,
      names:
        names && typeof names === 'object' && !Array.isArray(names)
          ? Object.fromEntries(
              Object.entries(names).filter(
                (entry): entry is [string, string] => typeof entry[1] === 'string',
              ),
            )
          : {},
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
