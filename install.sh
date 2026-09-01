#!/bin/sh
# singbox-admin — install / update (the same command does both)
#
# Deploys the admin interface next to a running sing-box. It must run ON the
# sing-box host: the app edits that host's configuration and reloads that
# host's service.
#
# Usage, as root:
#   curl -fsSL https://raw.githubusercontent.com/nebuloss/singbox-admin/main/install.sh \
#     | ADMIN_PASSWORD='...' PUBLIC_HOST=tunnel.example.com sh
#
# What lands on the host is one static binary with the interface inside it.
# There is no runtime to install, nothing to fetch from a package registry, and
# nothing left behind but the binary and its config.
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
GH_REPO="${GH_REPO:-nebuloss/singbox-admin}"
BINARY="${BINARY:-}"              # install this binary instead of a release
SINGBOX_CONFIG="${SINGBOX_CONFIG:-/etc/sing-box/config.json}"
SINGBOX_SERVICE="${SINGBOX_SERVICE:-sing-box}"
PUBLIC_HOST="${PUBLIC_HOST:-example.com}"
PUBLIC_PORT="${PUBLIC_PORT:-443}"
ADMIN_PASSWORD="${ADMIN_PASSWORD:-}"

APP_BIN="$APP_DIR/singbox-admin"

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

  # The binary is static, so the libc does not matter — only the instruction
  # set does.
  case "$(uname -m)" in
    x86_64|amd64)   ARCH=amd64 ;;
    aarch64|arm64)  ARCH=arm64 ;;
    armv7l|armv6l)  ARCH=armv7 ;;
    *) error "architecture non supportee : $(uname -m)" ;;
  esac
  info "Systeme detecte : $OS/$ARCH"

  # Warnings, not errors: sing-box may legitimately be installed after this.
  [ -f "$SINGBOX_CONFIG" ] || warn "config sing-box introuvable : $SINGBOX_CONFIG"
  command -v sing-box >/dev/null 2>&1 || warn "binaire sing-box absent du PATH"
}

fetch_binary() {
  if [ -x "$APP_BIN" ]; then
    info "Installation existante — mise a jour"
    rc-service "$SERVICE_NAME" stop 2>/dev/null \
      || systemctl stop "$SERVICE_NAME" 2>/dev/null || true
  else
    info "Installation initiale dans $APP_DIR"
  fi
  mkdir -p "$APP_DIR"

  if [ -n "$BINARY" ]; then
    [ -f "$BINARY" ] || error "binaire introuvable : $BINARY"
    info "Installation depuis $BINARY"
    install -m 755 "$BINARY" "$APP_BIN"
    return
  fi

  # curl is the only thing this needs from the distribution.
  if ! command -v curl >/dev/null 2>&1; then
    case "$OS" in
      alpine) apk add --no-cache curl ca-certificates >/dev/null ;;
      debian) DEBIAN_FRONTEND=noninteractive apt-get update -qq
              DEBIAN_FRONTEND=noninteractive apt-get install -y -qq curl ca-certificates >/dev/null ;;
    esac
  fi

  asset="singbox-admin-linux-$ARCH"
  info "Telechargement de $asset…"
  tmp=$(mktemp)
  curl -fsSL "https://github.com/${GH_REPO}/releases/latest/download/${asset}" -o "$tmp" \
    || error "telechargement impossible — verifier qu'une release existe sur ${GH_REPO}"
  install -m 755 "$tmp" "$APP_BIN"
  rm -f "$tmp"
}

# The app config also holds device names, so it can exist with no password in
# it — after a reset. Ask what is actually in it rather than whether it exists.
has_password() {
  [ -f "$APP_DIR/config.json" ] || return 1
  grep -q '"hash"' "$APP_DIR/config.json" 2>/dev/null
}

set_password() {
  # Hashed by the binary, and only the hash is stored. The password is never
  # written in clear text, and never handed to the service as an environment
  # variable, where `systemctl show` or /proc/<pid>/environ would expose it.
  if [ -n "$ADMIN_PASSWORD" ]; then
    ADMIN_CONFIG="$APP_DIR/config.json" "$APP_BIN" reset-password "$ADMIN_PASSWORD" >/dev/null \
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
    warn "  $APP_BIN reset-password 'votre mot de passe'"
  fi
}

install_service_openrc() {
  cat > "/etc/init.d/$SERVICE_NAME" <<EOF
#!/sbin/openrc-run

name="$SERVICE_NAME"
description="sing-box admin"
command="$APP_BIN"
command_background=yes
pidfile="/run/\${RC_SVCNAME}.pid"
output_log="/var/log/\${RC_SVCNAME}.log"
error_log="/var/log/\${RC_SVCNAME}.log"

depend() { need net; after firewall; }

start_pre() {
    export PORT=$APP_PORT
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
Environment=PORT=$APP_PORT
Environment=SINGBOX_CONFIG=$SINGBOX_CONFIG SINGBOX_SERVICE=$SINGBOX_SERVICE
Environment=PUBLIC_HOST=$PUBLIC_HOST PUBLIC_PORT=$PUBLIC_PORT
ExecStart=$APP_BIN
Restart=always
RestartSec=5

[Install]
WantedBy=multi-user.target
EOF
  systemctl daemon-reload
  systemctl enable --now "$SERVICE_NAME" >/dev/null 2>&1
  systemctl restart "$SERVICE_NAME"
}

# Anything left from the days when this was a Node application. Removing it is
# the point of the exercise: nothing on the host should still need a runtime.
tidy_old_install() {
  [ -d "$APP_DIR/node_modules" ] || [ -d "$APP_DIR/dist-server" ] || return 0
  info "Suppression de l'ancienne installation Node"
  rm -rf "$APP_DIR/node_modules" "$APP_DIR/dist-server" "$APP_DIR/dist" \
         "$APP_DIR/package.json" "$APP_DIR/package-lock.json"
}

# ── Run ──────────────────────────────────────────────────────────────────────

check_host
fetch_binary
tidy_old_install
set_password

# The service runs as root: it rewrites SINGBOX_CONFIG and drives the service
# manager. On a single-purpose host, narrowing that would mean a doas/sudo rule
# plus file ACLs for very little gain.
if [ "$OS" = alpine ]; then install_service_openrc; else install_service_systemd; fi

sleep 2
info "Termine — http://$(hostname -i 2>/dev/null | awk '{print $1}'):$APP_PORT"
