/**
 * Mint a sign-in link from the host, for when there is no session to make one
 * from — a forgotten password on a phone, a browser that lost its cookie.
 *
 *   node dist-server/sign-in-link.js                     # prints the token
 *   node dist-server/sign-in-link.js https://admin.lan   # prints the full link
 *
 * It grants what the password grants, for a few minutes and a single use. That
 * is the same trust as running this at all: it needs the file the password
 * hash lives in.
 */

import path from 'path'
import { mintLink } from './admin-config'

const ADMIN_CONFIG = process.env.ADMIN_CONFIG ?? path.join(__dirname, '..', 'config.json')
const MINUTES = Number(process.env.LINK_MINUTES ?? 10)

try {
  const token = mintLink(ADMIN_CONFIG, MINUTES * 60_000)
  const base = (process.argv[2] ?? '').replace(/\/+$/, '')
  console.log(base ? `${base}/#login=${token}` : `#login=${token}`)
  if (!base) console.log("Ajoutez l'adresse de l'interface devant, ou passez-la en argument.")
  console.log(`Valable ${MINUTES} minutes, une seule fois.`)
} catch (e) {
  console.error(`Operation impossible sur ${ADMIN_CONFIG} : ${(e as Error).message}`)
  process.exit(1)
}
