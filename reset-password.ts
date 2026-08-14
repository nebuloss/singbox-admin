/**
 * Offline password reset. Run on the host when the interface password is lost:
 * it rewrites AUTH_FILE with a new hash, no running service required.
 *
 *   node dist-server/reset-password.js 'new password'
 *   node dist-server/reset-password.js            # generates one and prints it
 */

import path from 'path'
import crypto from 'crypto'
import { writeAuth } from './auth'

const AUTH_FILE = process.env.AUTH_FILE ?? path.join(__dirname, '..', 'auth.json')

const given = process.argv[2]
const password = given ?? crypto.randomBytes(12).toString('base64url')

if (given && given.length < 10) {
  console.error('Le mot de passe doit faire au moins 10 caracteres.')
  process.exit(1)
}

try {
  writeAuth(AUTH_FILE, password)
} catch (e) {
  console.error(`Ecriture impossible dans ${AUTH_FILE} : ${(e as Error).message}`)
  process.exit(1)
}

console.log(`Mot de passe reinitialise dans ${AUTH_FILE}`)
if (!given) console.log(`Nouveau mot de passe : ${password}`)
console.log('Les sessions ouvertes seront fermees au prochain redemarrage du service.')
