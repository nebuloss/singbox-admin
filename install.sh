#!/bin/sh
# singbox-admin — install / update script (idempotent: same command does both)
#
# Deploys the admin SPA + API next to a running sing-box instance. It must run
# ON the sing-box host: the app edits that host's config file and restarts that
# host's service.
#
# Usage (as root on the appliance):
#   curl -fsSL https://raw.githubusercontent.com/nebuloss/singbox-admin/main/install.sh \
#     | ADMIN_PASSWORD=... PUBLIC_HOST=tunnel.example.com sh
#
# Override defaults via env: APP_DIR, APP_PORT, GH_REPO, TARBALL (to install a
# locally built archive instead of the latest release).
#
# Supported systems: Alpine Linux (OpenRC), Debian/Ubuntu (systemd)

set -eu

# Debian's /bin/sh omits /usr/local/bin from PATH, where sing-box is installed
# on that distribution — without this the check below reports it as missing.
PATH="/usr/local/bin:$PATH"
export PATH

APP_DIR="${APP_DIR:-/opt/singbox-admin}"
APP_PORT="${APP_PORT:-3000}"
NODE_VERSION="${NODE_VERSION:-22}"
SERVICE_NAME="singbox-admin"
GH_REPO="${GH_REPO:-nebuloss/singbox-admin}"
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
if [ -d "$APP_DIR/dist-server" ]; then
  info "Installation existante — mise a jour"
  rc-service "$SERVICE_NAME" stop 2>/dev/null || systemctl stop "$SERVICE_NAME" 2>/dev/null || true
else
  info "Installation initiale dans $APP_DIR"
fi

rm -rf "$APP_DIR/dist" "$APP_DIR/dist-server"
mkdir -p "$APP_DIR"

if [ -n "$TARBALL" ]; then
  [ -f "$TARBALL" ] || error "archive introuvable : $TARBALL"
  info "Installation depuis l'archive locale $TARBALL"
  tar -xzf "$TARBALL" -C "$APP_DIR"
else
  APP_VERSION=$(curl -fsSL "https://api.github.com/repos/${GH_REPO}/releases/latest" \
    | grep '"tag_name"' | head -1 | cut -d'"' -f4)
  [ -n "${APP_VERSION:-}" ] || error "aucune release publiee sur ${GH_REPO} — fournir TARBALL"
  info "Telechargement de la version ${APP_VERSION}…"
  curl -fsSL "https://github.com/${GH_REPO}/releases/latest/download/singbox-admin.tar.gz" \
    | tar -xz -C "$APP_DIR"
fi

info "Dependances de production…"
cd "$APP_DIR"
npm ci --omit=dev --prefer-offline --quiet 2>&1 | tail -3 || npm install --omit=dev --quiet 2>&1 | tail -3

# ── Credentials ───────────────────────────────────────────────────────────────
# The password is hashed here and only the hash is stored. It is never written
# to disk in clear text, and never handed to the service as an environment
# variable — where it would show up in `systemctl show` or /proc/<pid>/environ.
NODE_BIN=$(command -v node)

if [ -n "$ADMIN_PASSWORD" ]; then
  "$NODE_BIN" "$APP_DIR/dist-server/reset-password.js" "$ADMIN_PASSWORD" >/dev/null \
    && info "Mot de passe hache dans $APP_DIR/auth.json"
elif [ -f "$APP_DIR/auth.json" ]; then
  info "Mot de passe existant conserve"
elif [ -f "$APP_DIR/.env" ]; then
  # Upgrade from a version that kept the password in clear text: hash the one
  # already in use rather than silently leaving the interface unclaimed.
  OLD=$(sed -n 's/^ADMIN_PASSWORD=//p' "$APP_DIR/.env" | head -1)
  if [ -n "$OLD" ]; then
    "$NODE_BIN" "$APP_DIR/dist-server/reset-password.js" "$OLD" >/dev/null \
      && info "Mot de passe existant migre vers un hachage"
  fi
  unset OLD
fi

# A previous version stored the password in clear text here.
if [ -f "$APP_DIR/.env" ]; then
  rm -f "$APP_DIR/.env"
  warn "Ancien .env (mot de passe en clair) supprime"
fi

# Check the outcome rather than which branch ran: an empty or password-less
# .env satisfies [ -f ] but yields nothing to migrate, and the interface would
# then come up unclaimed — anyone reaching it could set the password.
if [ ! -f "$APP_DIR/auth.json" ]; then
  warn "AUCUN MOT DE PASSE DEFINI"
  warn "L'interface demarre en mode premiere configuration : le premier"
  warn "visiteur choisira le mot de passe. A faire tout de suite, ou definir"
  warn "un mot de passe des maintenant :"
  warn "  $NODE_BIN $APP_DIR/dist-server/reset-password.js 'votre mot de passe'"
fi

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
