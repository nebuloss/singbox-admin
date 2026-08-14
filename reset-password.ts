/**
 * Offline password reset. Run on the host when the interface password is lost.
 *
 *   node dist-server/reset-password.js            # clear it: the UI then asks
 *                                                 # for a new one on first visit
 *   node dist-server/reset-password.js 'a new password'   # set it directly
 */

import fs from 'fs'
import path from 'path'
import { writeAuth } from './auth'

const AUTH_FILE = process.env.AUTH_FILE ?? path.join(__dirname, '..', 'auth.json')

const given = process.argv[2]

if (given !== undefined && given.length < 10) {
  console.error('Le mot de passe doit faire au moins 10 caracteres.')
  process.exit(1)
}

try {
  if (given === undefined) {
    // No password given: clear the credential so the interface returns to its
    // first-run screen and the operator picks one there. Printing a generated
    // password to a terminal only invites copy-paste through chat logs.
    fs.rmSync(AUTH_FILE, { force: true })
    console.log(`Identifiants effaces (${AUTH_FILE}).`)
    console.log("Ouvrez l'interface : elle demandera de definir un nouveau mot de passe.")
  } else {
    writeAuth(AUTH_FILE, given)
    console.log(`Mot de passe redefini dans ${AUTH_FILE}`)
  }
} catch (e) {
  console.error(`Operation impossible sur ${AUTH_FILE} : ${(e as Error).message}`)
  process.exit(1)
}

console.log('Les sessions ouvertes seront fermees au prochain redemarrage du service.')
