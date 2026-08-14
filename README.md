# singbox-admin

A small web interface for a [sing-box](https://github.com/SagerNet/sing-box)
VLESS tunnel: hand out connection links and QR codes, suspend or revoke a
device, and pick which WireGuard tunnel the traffic leaves through.

It is deliberately narrow. There is no database, no user model, no traffic
accounting. sing-box's own configuration file holds everything that decides
who gets in and where traffic goes, and the app only touches the parts it
owns: the `users` array of one inbound, the WireGuard endpoints, and the
routing rules that reference them.

The one thing kept outside it is display names, in the app's own `config.json`
alongside the password hash — see [Where the state lives](#where-the-state-lives)
for why.

## What it manages

**Devices.** Adding one generates a UUID and gives you a `vless://` link and a
QR code. There are two different ways to take access away:

| | effect | reversible |
|---|---|---|
| switch off | the device can no longer connect; its link and QR stay valid | yes, instantly |
| revoke | the UUID is removed; link and QR stop working | no — coming back means a new identity |

**Tunnels.** WireGuard endpoints, pasted in as the `.conf` file a router or
provider hands you. They form an ordered list: the first enabled one carries
the traffic, and a global switch drops back to leaving directly from this host.
Only the networks listed in `AllowedIPs` are routed, so a split tunnel stays
split.

## Why not a full panel

Panels like [s-ui](https://github.com/alireza0/s-ui) or
[3x-ui](https://github.com/MHSanaei/3x-ui) generate the whole sing-box
configuration from their own database. That is the right trade when you run
many users with quotas and expiry dates. It is the wrong one when you have a
hand-written configuration you want to keep — a WireGuard endpoint, custom
routing rules, a specific DNS setup — and you only need to hand out a link.

This app never rewrites your configuration. It reads it, edits the few keys it
owns, validates the result and puts it back. Everything else in the file —
your DNS setup, your custom rules, whatever else you put there — is returned
untouched.

## How it works

```
browser ──► Express ──► /etc/sing-box/config.json
                   └──► sing-box check      (validate before applying)
                   └──► rc-service restart  (or systemctl)
```

Every write follows the same path: keep a copy of the current file, write the
new one, run `sing-box check` on it, and restore the copy if the check fails.
A bad edit cannot leave the tunnel down. Deleting the last remaining device is
refused outright, since that would lock everyone out including you.

QR codes are rendered server-side as SVG, so the client bundle carries no QR
library.

### Where the state lives

**sing-box is only ever told identifiers.** A device is a UUID and nothing
else; a tunnel is a tag `wg-<id>` carrying a random, permanent id. Neither has
to be readable, so neither ever has to change.

The readable name lives in the app's own `config.json` — a small file next
to the install, the same
one holding the password hash — filed under that identifier. Renaming therefore
writes that file and stops there: the sing-box configuration is not rewritten,
not revalidated and not restarted, and nobody loses a connection over a label.
Losing it costs the password and the labels; every device and tunnel
keeps working.

Everything that decides access or routing stays in the sing-box configuration,
expressed with what the format already offers, since it rejects unknown keys:

- **a suspended device is moved, not flagged.** It goes to a second VLESS
  inbound, tagged `vless-suspended` and bound to `127.0.0.1`, which no reverse
  proxy forwards and nothing off the host can reach. The shelf is created when
  the first device lands on it and removed when the last one leaves.
- a disabled tunnel carries a `wgx-` prefix instead of `wg-`, keeping its id
- the tunnel in use is whichever one a routing rule points at; no such rule
  means traffic leaves directly

The alternative to all this is a routing rule matching a device by name, which
does work — but it makes the name load-bearing: every rename has to drag the
rule along, a hand-edited config desynchronises in silence, and a cosmetic
change restarts the service. (If you write such a rule yourself, the matcher
is `auth_user`. There is also a `user` field — it passes `sing-box check`, but
matches the OS process owner, so the rule quietly matches nothing.)

## Requirements

- A host already running sing-box with a VLESS inbound using a `ws` transport
- Node.js 20 or later
- Alpine Linux (OpenRC) or Debian/Ubuntu (systemd)

The app must run **on the sing-box host**: it edits that host's configuration
file and restarts that host's service.

## Install

Both scripts are idempotent: the same command installs and updates.

### 1. sing-box, if you do not have it yet

```sh
curl -fsSL https://raw.githubusercontent.com/nebuloss/singbox-admin/main/scripts/install-singbox.sh | sh
```

Installs sing-box and writes a VLESS + WebSocket inbound with a generated UUID
and a random secret path. It leaves an existing configuration untouched.

TLS is not handled here on purpose: the inbound speaks plain WebSocket and
expects a reverse proxy in front of it to terminate HTTPS on 443 and forward
the secret path, so certificate renewal stays where it already works.

### 2. The admin interface

```sh
curl -fsSL https://raw.githubusercontent.com/nebuloss/singbox-admin/main/install.sh \
  | ADMIN_PASSWORD='choose-something-long' PUBLIC_HOST=tunnel.example.com sh
```

It pulls the latest release. `ADMIN_PASSWORD` is optional: leave it out and
the interface asks for a password on first visit. An update keeps the password
already in use.

> **Status: early development.** Expect breaking changes between versions
> rather than migration paths — upgrade by reinstalling and, if the interface
> comes up asking for a password, set it again.

## A cover page in front of the tunnel

A hostname that answers 404, or shows a reverse-proxy banner, is a signal. It
costs little to serve an ordinary page at `/` and route only the secret path to
sing-box, so a browser, a scanner or a curious middlebox finds a boring site.

Put a static file on the proxy host — any plausible, dull page will do:

```sh
mkdir -p /data/nginx/decoy
cat > /data/nginx/decoy/index.html <<'HTML'
<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Static Asset Delivery</title>
</head>
<body>
<main>
  <h1>Static asset delivery</h1>
  <p>This host serves cached static resources. There is no browsable index.</p>
</main>
</body>
</html>
HTML
```

Then, on **Nginx Proxy Manager**, open that proxy host and paste this into
*Advanced → Custom Nginx Configuration*:

```nginx
# The root is served straight from disk: it is the only address a visitor
# actually asks for, so spare it the round trip.
location = / {
  root /data/nginx/decoy;
  try_files /index.html =404;
}

# Everything else goes to sing-box, which answers only on the secret path and
# only to a WebSocket upgrade. The other cases — 404 for a path it does not
# know, 400 for the right path without an upgrade — are caught below.
location / {
  proxy_pass http://10.0.0.4:8081;
  proxy_set_header Host $host;
  proxy_set_header X-Real-IP $remote_addr;
  proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
  proxy_set_header Upgrade $http_upgrade;
  proxy_set_header Connection $http_connection;
  proxy_http_version 1.1;

  # A tunnel is long-lived: do not cut it after the default 60 seconds.
  proxy_read_timeout 86400s;
  proxy_send_timeout 86400s;

  # 502 and 504 included: with sing-box stopped, the site is still a site.
  proxy_intercept_errors on;
  error_page 400 401 403 404 500 502 503 504 = @cover;
}

location @cover {
  root /data/nginx/decoy;
  try_files /index.html =404;
}
```

**The proxy is never told the secret path.** It forwards and lets sing-box
decide, which buys two things. Probing is uniform — every path returns the same
200 cover page, including the real one, so there is no status code to sort
paths by; only a genuine WebSocket upgrade behaves differently, and that needs
the path *and* a valid UUID. And the path can be regenerated from the interface
without touching the proxy at all.

Three things worth knowing:

- NPM drops its own default `location /` as soon as it finds one in this field,
  so the block replaces the host's proxy pass instead of colliding with it.
  Two `location /` in one server block stop nginx from starting.
- This field lives in NPM's database, so it is written back every time the
  vhost is regenerated. Editing the generated file under
  `/data/nginx/proxy_host/` instead looks like it works, until the next save or
  certificate renewal silently drops it.
- Leave HTTP/2 off on that host: nginx does not implement WebSockets over
  HTTP/2 ([RFC 8441](https://www.rfc-editor.org/rfc/rfc8441)), so an h2 client
  would fail the upgrade.

### Regenerating the path

Settings has a button for it. Worth doing when the path may have leaked — from
a lost device, or a proxy that logged it. It costs every device its link, since
the path travels in the link, so it is not on a timer: rotation is a response,
not hygiene.

## Build from source

```sh
npm install
npm run build          # -> dist/ (SPA) and dist-server/ (server)
tar czf singbox-admin.tar.gz dist dist-server package.json package-lock.json
```

Then install that archive instead of a release:

```sh
TARBALL=/tmp/singbox-admin.tar.gz sh install.sh
```

Pushing a `v*` tag builds and publishes a release through GitHub Actions.

## Configuration

| variable | default | meaning |
|---|---|---|
| `ADMIN_PASSWORD` | — | optional initial password, hashed at install; omit it and the interface asks on first visit |
| `PUBLIC_HOST` | `example.com` | hostname clients connect to, used to build links |
| `PUBLIC_PORT` | `443` | port clients connect to |
| `SINGBOX_CONFIG` | `/etc/sing-box/config.json` | configuration file to manage |
| `SINGBOX_SERVICE` | `sing-box` | service name to restart |
| `APP_PORT` | `3000` | port the interface listens on |
| `APP_DIR` | `/opt/singbox-admin` | install directory |
| `ADMIN_CONFIG` | `$APP_DIR/config.json` | the app's own file: password hash and display names |

The password can also be changed from the interface.

## Language

The interface is available in English and French. It follows the browser's
preferred language on first visit, and the choice can be changed under
Settings — it is remembered per browser.

## Lost password

```sh
curl -fsSL https://raw.githubusercontent.com/nebuloss/singbox-admin/main/scripts/reset-password.sh | sh
```

Run on the host, it clears the stored credential and restarts the service. The
interface then shows its first-run screen and asks for a new password, so the
new one is never printed to a terminal or pasted through a chat log. Pass a
password as an argument to set it directly instead.

Existing clients are untouched: resetting the interface password does not
revoke a single device, and the names stored beside it are left alone.

## Security model

Be clear-eyed about what this is: **one shared password, no accounts, no
audit trail**. It is meant to sit on an internal network, behind a reverse
proxy that terminates TLS — not to face the internet.

- Sessions live in memory; restarting the service logs everyone out
- The session cookie is `httpOnly`, `sameSite=strict` and `secure`, so the app
  requires HTTPS in front of it
- Changing the password drops every other session
- The password is stored only as a scrypt hash, in the app's own `config.json` (mode 600).
  `ADMIN_PASSWORD` is a bootstrap value: it is hashed at install and never
  written to disk in clear text, nor passed to the service as an environment
  variable where `systemctl show` or `/proc/<pid>/environ` would expose it
- The process runs as root because it writes the sing-box configuration and
  drives the service manager
- The secret path is obfuscation, not authentication: it keeps a scan of the
  hostname from finding anything, while the UUID is what actually lets a device
  in. Treat the path as shared secret material — it sits in every client's
  configuration — and regenerate it if you think it leaked
- Switching a device off moves it off the public inbound, so it can no longer
  authenticate at all — but it keeps its identity and its link, ready to work
  again the moment you switch it back. Revoking is the permanent cut

## Licence

MIT
