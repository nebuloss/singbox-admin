# singbox-admin

A small web interface to manage the clients of a [sing-box](https://github.com/SagerNet/sing-box)
VLESS inbound: add a device, get its connection link and QR code, revoke it.

It is deliberately narrow. There is no database, no user model, no traffic
accounting — sing-box's own configuration file is the single source of truth,
and the app only ever edits the `users` array of one inbound.

## Why not a full panel

Panels like [s-ui](https://github.com/alireza0/s-ui) or
[3x-ui](https://github.com/MHSanaei/3x-ui) generate the whole sing-box
configuration from their own database. That is the right trade when you run
many users with quotas and expiry dates. It is the wrong one when you have a
hand-written configuration you want to keep — a WireGuard endpoint, custom
routing rules, a specific DNS setup — and you only need to hand out a link.

This app never rewrites your configuration. It reads it, changes one array,
validates the result and puts it back.

## How it works

```
browser ──► Express ──► /etc/sing-box/config.json
                   └──► sing-box check      (validate before applying)
                   └──► rc-service restart  (or systemctl)
```

Every write follows the same path: keep a copy of the current file, write the
new one, run `sing-box check` on it, and restore the copy if the check fails.
A bad edit cannot leave the tunnel down. Deleting the last remaining user is
refused outright, since that would lock everyone out including you.

QR codes are rendered server-side as SVG, so the client bundle carries no QR
library.

## Requirements

- A host already running sing-box with a VLESS inbound using a `ws` transport
- Node.js 20 or later
- Alpine Linux (OpenRC) or Debian/Ubuntu (systemd)

The app must run **on the sing-box host**: it edits that host's configuration
file and restarts that host's service.

## Build

```sh
npm install
npm run build          # -> dist/ (SPA) and dist-server/ (server)
tar czf singbox-admin.tar.gz dist dist-server package.json package-lock.json
```

## Install

Copy the tarball and `install.sh` to the sing-box host, then, as root:

```sh
ADMIN_PASSWORD='choose-something-long' \
PUBLIC_HOST=tunnel.example.com \
TARBALL=/tmp/singbox-admin.tar.gz \
sh install.sh
```

Re-running the same command updates an existing installation. `ADMIN_PASSWORD`
is only written when supplied, so an update keeps the password already in use.

## Configuration

| variable | default | meaning |
|---|---|---|
| `ADMIN_PASSWORD` | — | interface password; without it the app starts read-only |
| `PUBLIC_HOST` | `example.com` | hostname clients connect to, used to build links |
| `PUBLIC_PORT` | `443` | port clients connect to |
| `SINGBOX_CONFIG` | `/etc/sing-box/config.json` | configuration file to manage |
| `SINGBOX_SERVICE` | `sing-box` | service name to restart |
| `APP_PORT` | `3000` | port the interface listens on |
| `APP_DIR` | `/opt/singbox-admin` | install directory |

The password can also be changed from the interface, which rewrites
`$APP_DIR/.env` so the change survives a restart.

## Security model

Be clear-eyed about what this is: **one shared password, no accounts, no
audit trail**. It is meant to sit on an internal network, behind a reverse
proxy that terminates TLS — not to face the internet.

- Sessions live in memory; restarting the service logs everyone out
- The session cookie is `httpOnly`, `sameSite=strict` and `secure`, so the app
  requires HTTPS in front of it
- Changing the password drops every other session
- Passwords are hashed before comparison and compared in constant time
- The process runs as root because it writes the sing-box configuration and
  drives the service manager

## Licence

MIT
