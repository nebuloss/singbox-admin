#!/bin/sh
# singbox-admin — install / update (the same command does both)
#
# Deploys the admin interface next to a running sing-box. It must run ON the
# sing-box host: the app edits that host's configuration and restarts that
# host's service.
#
# Usage, as root:
#   curl -fsSL https://raw.githubusercontent.com/nebuloss/singbox-admin/main/install.sh \
#     | ADMIN_PASSWORD='...' PUBLIC_HOST=tunnel.example.com sh
#
# Systems: Alpine Linux (OpenRC), Debian/Ubuntu (systemd)

set -eu

# Debian's /bin/sh omits /usr/local/bin, where sing-box lands on that
# distribution — without this the check below reports it as missing.
PATH="/usr/local/bin:$PATH"
export PATH

# ── Settings, all overridable from the environment ───────────────────────────
APP_DIR="${APP_DIR:-/opt/singbox-admin}"
APP_PORT="${APP_PORT:-3000}"
SERVICE_NAME="${SERVICE_NAME:-singbox-admin}"
NODE_VERSION="${NODE_VERSION:-22}"
GH_REPO="${GH_REPO:-nebuloss/singbox-admin}"
TARBALL="${TARBALL:-}"            # install this archive instead of a release
SINGBOX_CONFIG="${SINGBOX_CONFIG:-/etc/sing-box/config.json}"
SINGBOX_SERVICE="${SINGBOX_SERVICE:-sing-box}"
PUBLIC_HOST="${PUBLIC_HOST:-example.com}"
PUBLIC_PORT="${PUBLIC_PORT:-443}"
ADMIN_PASSWORD="${ADMIN_PASSWORD:-}"

GREEN='\033[0;32m'; YELLOW='\033[1;33m'; RED='\033[0;31m'; NC='\033[0m'
info()  { printf "${GREEN}[+]${NC} %s\n" "$*"; }
warn()  { printf "${YELLOW}[!]${NC} %s\n" "$*"; }
error() { printf "${RED}[x]${NC} %s\n" "$*"; exit 1; }

# ── Steps ────────────────────────────────────────────────────────────────────

check_host() {
  [ "$(id -u)" -eq 0 ] || error "a lancer en root"

  if   [ -f /etc/alpine-release ]; then OS=alpine
  elif [ -f /etc/debian_version ]; then OS=debian
  else error "systeme non supporte"; fi
  info "Systeme detecte : $OS"

  # Warnings, not errors: sing-box may legitimately be installed after this.
  [ -f "$SINGBOX_CONFIG" ] || warn "config sing-box introuvable : $SINGBOX_CONFIG"
  command -v sing-box >/dev/null 2>&1 || warn "binaire sing-box absent du PATH"
}

install_node() {
  case "$OS" in
    alpine) apk update -q
            apk add --no-cache curl ca-certificates tar >/dev/null ;;
    debian) export DEBIAN_FRONTEND=noninteractive
            apt-get update -qq
            apt-get install -y -qq curl ca-certificates tar >/dev/null ;;
  esac

  if command -v node >/dev/null 2>&1; then
    info "Node deja present : $(node --version)"
    return
  fi

  info "Installation de Node ${NODE_VERSION}…"
  case "$OS" in
    alpine) apk add --no-cache nodejs npm >/dev/null ;;
    debian) curl -fsSL "https://deb.nodesource.com/setup_${NODE_VERSION}.x" | bash - >/dev/null 2>&1
            apt-get install -y -qq nodejs >/dev/null ;;
  esac
  info "Node installe : $(node --version)"
}

fetch_build() {
  if [ -d "$APP_DIR/dist-server" ]; then
    info "Installation existante — mise a jour"
    rc-service "$SERVICE_NAME" stop 2>/dev/null \
      || systemctl stop "$SERVICE_NAME" 2>/dev/null || true
  else
    info "Installation initiale dans $APP_DIR"
  fi

  # Replace the build wholesale; anything left from an older layout would be
  # dead weight at best.
  rm -rf "$APP_DIR/dist" "$APP_DIR/dist-server"
  mkdir -p "$APP_DIR"

  if [ -n "$TARBALL" ]; then
    [ -f "$TARBALL" ] || error "archive introuvable : $TARBALL"
    info "Installation depuis l'archive locale $TARBALL"
    tar -xzf "$TARBALL" -C "$APP_DIR"
    return
  fi

  version=$(curl -fsSL "https://api.github.com/repos/${GH_REPO}/releases/latest" \
    | grep '"tag_name"' | head -1 | cut -d'"' -f4)
  [ -n "${version:-}" ] || error "aucune release publiee sur ${GH_REPO} — fournir TARBALL"
  info "Telechargement de la version ${version}…"
  curl -fsSL "https://github.com/${GH_REPO}/releases/latest/download/singbox-admin.tar.gz" \
    | tar -xz -C "$APP_DIR"
}

install_deps() {
  info "Dependances de production…"
  cd "$APP_DIR"
  # Output goes to a file rather than through `| tail`: in a pipeline the exit
  # status is tail's, so a failed install would look like a success and leave
  # the app without its dependencies.
  log=$(mktemp)
  if ! npm ci --omit=dev --prefer-offline --no-audit --no-fund >"$log" 2>&1; then
    warn "npm ci a echoue, bascule sur npm install"
    if ! npm install --omit=dev --no-audit --no-fund >"$log" 2>&1; then
      tail -20 "$log"; rm -f "$log"
      error "installation des dependances impossible"
    fi
  fi
  rm -f "$log"
}

# The app config also holds device names, so it can exist with no password in
# it — after a reset. Ask what is actually in it rather than whether it exists.
has_password() {
  [ -f "$APP_DIR/config.json" ] || return 1
  "$NODE_BIN" -e 'const s = require(process.argv[1]); process.exit(s.password && s.password.hash ? 0 : 1)' \
    "$APP_DIR/config.json" 2>/dev/null
}

set_password() {
  # Hashed here, and only the hash is stored. The password is never written in
  # clear text, and never handed to the service as an environment variable,
  # where `systemctl show` or /proc/<pid>/environ would expose it.
  if [ -n "$ADMIN_PASSWORD" ]; then
    "$NODE_BIN" "$APP_DIR/dist-server/reset-password.js" "$ADMIN_PASSWORD" >/dev/null \
      || error "ecriture du mot de passe impossible"
    info "Mot de passe hache dans $APP_DIR/config.json"
  elif has_password; then
    info "Mot de passe existant conserve"
  fi

  # Judge the outcome, not the branch taken above: reaching this point with no
  # password means the interface comes up unclaimed, and whoever loads it first
  # gets to choose one.
  if ! has_password; then
    warn "AUCUN MOT DE PASSE DEFINI"
    warn "L'interface demarre en mode premiere configuration : le premier"
    warn "visiteur choisira le mot de passe. A faire tout de suite, ou definir"
    warn "un mot de passe des maintenant :"
    warn "  $NODE_BIN $APP_DIR/dist-server/reset-password.js 'votre mot de passe'"
  fi
}

install_service_openrc() {
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
}

install_service_systemd() {
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
}

# ── Run ──────────────────────────────────────────────────────────────────────

check_host
install_node
fetch_build
install_deps

NODE_BIN=$(command -v node)
set_password

# The service runs as root: it rewrites SINGBOX_CONFIG and drives the service
# manager. On a single-purpose host, narrowing that would mean a doas/sudo rule
# plus file ACLs for very little gain.
if [ "$OS" = alpine ]; then install_service_openrc; else install_service_systemd; fi

sleep 2
info "Termine — http://$(hostname -i 2>/dev/null | awk '{print $1}'):$APP_PORT"
