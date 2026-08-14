/**
 * Credential storage.
 *
 * The password is never kept in clear text. It is hashed with scrypt and
 * written to AUTH_FILE; ADMIN_PASSWORD only ever acts as a bootstrap value on
 * first start, and is replaced by its hash immediately.
 *
 * scrypt comes from Node's standard library, so this costs no dependency.
 */

import fs from 'fs'
import crypto from 'crypto'

const KEYLEN = 64
const COST = 16384 // scrypt N; ~100ms on modest hardware

export type Auth = { hash: string; updated: string }

/** Format: scrypt$<N>$<salt-hex>$<derived-hex> */
export function hashPassword(password: string): string {
  const salt = crypto.randomBytes(16)
  const derived = crypto.scryptSync(password, salt, KEYLEN, { N: COST })
  return `scrypt$${COST}$${salt.toString('hex')}$${derived.toString('hex')}`
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

export function readAuth(file: string): Auth | null {
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8')) as Auth
    return typeof parsed?.hash === 'string' ? parsed : null
  } catch {
    return null
  }
}

export function writeAuth(file: string, password: string): Auth {
  const auth: Auth = { hash: hashPassword(password), updated: new Date().toISOString() }
  fs.writeFileSync(file, JSON.stringify(auth, null, 2) + '\n', { mode: 0o600 })
  return auth
}
