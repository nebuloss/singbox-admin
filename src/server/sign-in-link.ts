/**
 * Mint a sign-in link from the host, for when there is no session to make one
 * from — a forgotten password on a phone, a browser that lost its cookie.
 *
 *   node dist-server/sign-in-link.js                          # prints the fragment
 *   node dist-server/sign-in-link.js https://admin.lan        # the whole link
 *   node dist-server/sign-in-link.js https://admin.lan wireguard   # and a page
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
  // Section and token share the fragment, so the link can name a page without
  // the token ever leaving the browser.
  // An absent section already lands on the first page, so naming it would only
  // lengthen a link meant to be read off a screen.
  const section = (process.argv[3] ?? '').replace(/[^a-z]/g, '')
  const prefix = section && section !== 'activite' ? `${section}&` : ''
  const fragment = `#${prefix}login=${token}`
  console.log(base ? `${base}/${fragment}` : fragment)
  if (!base) console.log("Ajoutez l'adresse de l'interface devant, ou passez-la en argument.")
  console.log(`Valable ${MINUTES} minutes, une seule fois.`)
} catch (e) {
  console.error(`Operation impossible sur ${ADMIN_CONFIG} : ${(e as Error).message}`)
  process.exit(1)
}
