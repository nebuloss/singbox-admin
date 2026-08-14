/**
 * Offline password reset. Run on the host when the interface password is lost.
 *
 *   node dist-server/reset-password.js            # clear it: the UI then asks
 *                                                 # for a new one on first visit
 *   node dist-server/reset-password.js 'a new password'   # set it directly
 */

import path from 'path'
import { updateAdminConfig, hashPassword } from './admin-config'

const ADMIN_CONFIG = process.env.ADMIN_CONFIG ?? path.join(__dirname, '..', 'config.json')

const given = process.argv[2]

if (given !== undefined && given.length < 10) {
  console.error('Le mot de passe doit faire au moins 10 caracteres.')
  process.exit(1)
}

try {
  // Only the password is touched — device and tunnel names share this file and
  // have nothing to do with losing a password.
  updateAdminConfig(ADMIN_CONFIG, (s) => ({ ...s, password: given === undefined ? null : hashPassword(given) }))

  if (given === undefined) {
    console.log(`Mot de passe efface (${ADMIN_CONFIG}).`)
    // Printing a generated password to a terminal only invites copy-paste
    // through chat logs; let the operator choose one in the interface.
    console.log("Ouvrez l'interface : elle demandera de definir un nouveau mot de passe.")
  } else {
    console.log(`Mot de passe redefini dans ${ADMIN_CONFIG}`)
  }
} catch (e) {
  console.error(`Operation impossible sur ${ADMIN_CONFIG} : ${(e as Error).message}`)
  process.exit(1)
}

console.log('Les noms des appareils et des tunnels sont conserves.')
console.log('Les sessions ouvertes seront fermees au prochain redemarrage du service.')
