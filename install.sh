#!/bin/sh
# singbox-admin — install / update script (idempotent: same command does both)
#
# Deploys the admin SPA + API next to a running sing-box instance. It must run
# ON the sing-box host: the app edits that host's config file and restarts that
# host's service.
#
# Usage (as root on the appliance):
#   ADMIN_PASSWORD=... sh install.sh              # from a local build tarball
#   ADMIN_PASSWORD=... TARBALL=/tmp/x.tar.gz sh install.sh
#
# Supported systems: Alpine Linux (OpenRC), Debian/Ubuntu (systemd)

set -eu

APP_DIR="${APP_DIR:-/opt/singbox-admin}"
APP_PORT="${APP_PORT:-3000}"
NODE_VERSION="${NODE_VERSION:-22}"
SERVICE_NAME="singbox-admin"
TARBALL="${TARBALL:-}"
SINGBOX_CONFIG="${SINGBOX_CONFIG:-/etc/sing-box/config.json}"
SINGBOX_SERVICE="${SINGBOX_SERVICE:-sing-box}"
PUBLIC_HOST="${PUBLIC_HOST:-example.com}"
PUBLIC_PORT="${PUBLIC_PORT:-443}"
ADMIN_PASSWORD="${ADMIN_PASSWORD:-}"

GREEN='\033[0;32m'; YELLOW='\033[1;33m'; RED='\033[0;31m'; NC='\033[0m'
info()  { printf "${GREEN}[+]${NC} %s\n" "$*"; }
warn()  { printf "${YELLOW}[!]${NC} %s\n" "$*"; }
error() { printf "${RED}[x]${NC} %s\n" "$*"; exit 1; }

[ "$(id -u)" -eq 0 ] || error "a lancer en root"

if   [ -f /etc/alpine-release ]; then OS=alpine
elif [ -f /etc/debian_version ]; then OS=debian
else error "systeme non supporte"; fi
info "Systeme detecte : $OS"

# The app rewrites SINGBOX_CONFIG and restarts SINGBOX_SERVICE, so it runs as
# root. It lives in a single-purpose container; granting narrower rights would
# mean a doas/sudo rule plus file ACLs for very little gain here.
[ -f "$SINGBOX_CONFIG" ] || warn "config sing-box introuvable : $SINGBOX_CONFIG"
command -v sing-box >/dev/null 2>&1 || warn "binaire sing-box absent du PATH"

# ── Base packages + Node ──────────────────────────────────────────────────────
case "$OS" in
  alpine) apk update -q; apk add --no-cache curl ca-certificates tar >/dev/null ;;
  debian) export DEBIAN_FRONTEND=noninteractive; apt-get update -qq; apt-get install -y -qq curl ca-certificates tar >/dev/null ;;
esac

if command -v node >/dev/null 2>&1; then
  info "Node deja present : $(node --version)"
else
  info "Installation de Node ${NODE_VERSION}…"
  case "$OS" in
    alpine) apk add --no-cache nodejs npm >/dev/null ;;
    debian) curl -fsSL "https://deb.nodesource.com/setup_${NODE_VERSION}.x" | bash - >/dev/null 2>&1
            apt-get install -y -qq nodejs >/dev/null ;;
  esac
  info "Node installe : $(node --version)"
fi

# ── Deploy the build ──────────────────────────────────────────────────────────
[ -n "$TARBALL" ] || error "TARBALL non fourni (chemin de l'archive de build)"
[ -f "$TARBALL" ] || error "archive introuvable : $TARBALL"

if [ -d "$APP_DIR/dist-server" ]; then
  info "Installation existante — mise a jour"
  rc-service "$SERVICE_NAME" stop 2>/dev/null || systemctl stop "$SERVICE_NAME" 2>/dev/null || true
else
  info "Installation initiale dans $APP_DIR"
fi

rm -rf "$APP_DIR/dist" "$APP_DIR/dist-server"
mkdir -p "$APP_DIR"
tar -xzf "$TARBALL" -C "$APP_DIR"

info "Dependances de production…"
cd "$APP_DIR"
npm ci --omit=dev --prefer-offline --quiet 2>&1 | tail -3 || npm install --omit=dev --quiet 2>&1 | tail -3

# ── Service ───────────────────────────────────────────────────────────────────
if [ -z "$ADMIN_PASSWORD" ] && [ ! -f "$APP_DIR/.env" ]; then
  warn "ADMIN_PASSWORD non fourni : l'interface demarrera en lecture seule"
fi
if [ -n "$ADMIN_PASSWORD" ]; then
  printf 'ADMIN_PASSWORD=%s\n' "$ADMIN_PASSWORD" > "$APP_DIR/.env"
  chmod 600 "$APP_DIR/.env"
fi

NODE_BIN=$(command -v node)

if [ "$OS" = alpine ]; then
  cat > "/etc/init.d/$SERVICE_NAME" <<EOF
#!/sbin/openrc-run

name="$SERVICE_NAME"
description="sing-box admin"
command="$NODE_BIN"
command_args="$APP_DIR/dist-server/server.js"
command_background=yes
pidfile="/run/\${RC_SVCNAME}.pid"
output_log="/var/log/\${RC_SVCNAME}.log"
error_log="/var/log/\${RC_SVCNAME}.log"

depend() { need net; after firewall; }

start_pre() {
    export PORT=$APP_PORT NODE_ENV=production
    export SINGBOX_CONFIG="$SINGBOX_CONFIG" SINGBOX_SERVICE="$SINGBOX_SERVICE"
    export PUBLIC_HOST="$PUBLIC_HOST" PUBLIC_PORT="$PUBLIC_PORT"
    [ -f "$APP_DIR/.env" ] && . "$APP_DIR/.env" && export ADMIN_PASSWORD
    touch /var/log/\${RC_SVCNAME}.log
}
EOF
  chmod +x "/etc/init.d/$SERVICE_NAME"
  rc-update add "$SERVICE_NAME" default >/dev/null 2>&1 || true
  rc-service "$SERVICE_NAME" restart >/dev/null 2>&1 || rc-service "$SERVICE_NAME" start
else
  cat > "/etc/systemd/system/$SERVICE_NAME.service" <<EOF
[Unit]
Description=sing-box admin
After=network-online.target

[Service]
Type=simple
WorkingDirectory=$APP_DIR
EnvironmentFile=-$APP_DIR/.env
Environment=PORT=$APP_PORT NODE_ENV=production
Environment=SINGBOX_CONFIG=$SINGBOX_CONFIG SINGBOX_SERVICE=$SINGBOX_SERVICE
Environment=PUBLIC_HOST=$PUBLIC_HOST PUBLIC_PORT=$PUBLIC_PORT
ExecStart=$NODE_BIN $APP_DIR/dist-server/server.js
Restart=always
RestartSec=5

[Install]
WantedBy=multi-user.target
EOF
  systemctl daemon-reload
  systemctl enable --now "$SERVICE_NAME" >/dev/null 2>&1
  systemctl restart "$SERVICE_NAME"
fi

sleep 2
info "Termine — http://$(hostname -i 2>/dev/null | awk '{print $1}'):$APP_PORT"
