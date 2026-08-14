#!/bin/sh
# install-singbox.sh — install sing-box and lay down a VLESS + WebSocket inbound
# that singbox-admin can then manage.
#
# TLS is deliberately NOT handled here: the inbound speaks plain WebSocket and
# expects a reverse proxy (nginx, Caddy, HAProxy…) in front of it to terminate
# HTTPS on 443 and forward the secret path. That keeps certificate renewal
# where it already works instead of duplicating it inside sing-box.
#
# Usage (as root):
#   curl -fsSL https://raw.githubusercontent.com/nebuloss/singbox-admin/main/scripts/install-singbox.sh | sh
#
# Override via env: LISTEN_PORT, WS_PATH, CONFIG, FIRST_CLIENT
#
# Supported systems: Alpine Linux (OpenRC), Debian/Ubuntu (systemd)

set -eu

CONFIG="${CONFIG:-/etc/sing-box/config.json}"
LISTEN_PORT="${LISTEN_PORT:-8081}"
FIRST_CLIENT="${FIRST_CLIENT:-premier-appareil}"

GREEN='\033[0;32m'; YELLOW='\033[1;33m'; RED='\033[0;31m'; NC='\033[0m'
info()  { printf "${GREEN}[+]${NC} %s\n" "$*"; }
warn()  { printf "${YELLOW}[!]${NC} %s\n" "$*"; }
error() { printf "${RED}[x]${NC} %s\n" "$*"; exit 1; }

[ "$(id -u)" -eq 0 ] || error "a lancer en root"

if   [ -f /etc/alpine-release ]; then OS=alpine
elif [ -f /etc/debian_version ]; then OS=debian
else error "systeme non supporte"; fi
info "Systeme detecte : $OS"

# ── Install sing-box ──────────────────────────────────────────────────────────
if command -v sing-box >/dev/null 2>&1; then
  info "sing-box deja present : $(sing-box version | head -1)"
else
  case "$OS" in
    alpine)
      # The community repository carries sing-box; no third-party source needed.
      apk update -q
      apk add --no-cache sing-box || error "sing-box absent des depots (activer 'community')"
      ;;
    debian)
      export DEBIAN_FRONTEND=noninteractive
      apt-get update -qq
      apt-get install -y -qq curl ca-certificates tar >/dev/null
      ARCH=$(uname -m)
      case "$ARCH" in
        x86_64) A=amd64 ;; aarch64) A=arm64 ;; armv7l) A=armv7 ;;
        *) error "architecture non geree : $ARCH" ;;
      esac
      VER=$(curl -fsSL https://api.github.com/repos/SagerNet/sing-box/releases/latest \
        | grep '"tag_name"' | head -1 | cut -d'"' -f4)
      [ -n "${VER:-}" ] || error "version de sing-box introuvable"
      N="${VER#v}"
      info "Telechargement de sing-box ${VER} (${A})…"
      curl -fsSL "https://github.com/SagerNet/sing-box/releases/download/${VER}/sing-box-${N}-linux-${A}.tar.gz" \
        | tar -xz -C /tmp
      install -m 755 "/tmp/sing-box-${N}-linux-${A}/sing-box" /usr/local/bin/sing-box
      rm -rf "/tmp/sing-box-${N}-linux-${A}"
      ;;
  esac
  info "sing-box installe : $(sing-box version | head -1)"
fi

# ── Configuration ─────────────────────────────────────────────────────────────
if [ -f "$CONFIG" ]; then
  warn "configuration existante conservee : $CONFIG"
else
  mkdir -p "$(dirname "$CONFIG")"
  UUID=$(sing-box generate uuid)
  # A random path acts as a light shared secret: scanners hitting the hostname
  # get a 404 from the reverse proxy instead of finding the inbound.
  WS_PATH="${WS_PATH:-/$(head -c 12 /dev/urandom | od -An -tx1 | tr -d ' \n')}"

  cat > "$CONFIG" <<EOF
{
  "log": {
    "level": "info",
    "timestamp": true,
    "output": "/var/log/sing-box.log"
  },
  "inbounds": [
    {
      "type": "vless",
      "tag": "vless-ws-in",
      "listen": "::",
      "listen_port": ${LISTEN_PORT},
      "users": [
        { "uuid": "${UUID}", "name": "${FIRST_CLIENT}" }
      ],
      "transport": { "type": "ws", "path": "${WS_PATH}" }
    }
  ],
  "outbounds": [
    { "type": "direct", "tag": "direct" }
  ],
  "route": {
    "default_domain_resolver": { "server": "dns-public" },
    "final": "direct"
  },
  "dns": {
    "servers": [
      { "type": "udp", "tag": "dns-public", "server": "1.1.1.1" }
    ],
    "final": "dns-public"
  }
}
EOF
  chmod 600 "$CONFIG"
  info "Configuration ecrite dans $CONFIG"
fi

sing-box check -c "$CONFIG" || error "configuration invalide"
info "Configuration validee"

# ── Service ───────────────────────────────────────────────────────────────────
if [ "$OS" = alpine ] && [ ! -f /etc/init.d/sing-box ]; then
  SB=$(command -v sing-box)
  cat > /etc/init.d/sing-box <<EOF
#!/sbin/openrc-run

name="sing-box"
description="sing-box proxy platform"
command="$SB"
command_args="run -c $CONFIG"
command_background=true
pidfile="/run/\${RC_SVCNAME}.pid"

depend() { need net; after firewall; }
EOF
  chmod +x /etc/init.d/sing-box
elif [ "$OS" = debian ] && [ ! -f /etc/systemd/system/sing-box.service ]; then
  cat > /etc/systemd/system/sing-box.service <<EOF
[Unit]
Description=sing-box proxy platform
After=network-online.target

[Service]
Type=simple
ExecStart=$(command -v sing-box) run -c $CONFIG
Restart=always
RestartSec=5
LimitNOFILE=65535

[Install]
WantedBy=multi-user.target
EOF
  systemctl daemon-reload
fi

if [ "$OS" = alpine ]; then
  rc-update add sing-box default >/dev/null 2>&1 || true
  rc-service sing-box restart >/dev/null 2>&1 || rc-service sing-box start
else
  systemctl enable --now sing-box >/dev/null 2>&1
  systemctl restart sing-box
fi
sleep 2

# ── Summary ───────────────────────────────────────────────────────────────────
PATH_OUT=$(sed -n 's/.*"path"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' "$CONFIG" | head -1)
PORT_OUT=$(sed -n 's/.*"listen_port"[[:space:]]*:[[:space:]]*\([0-9]*\).*/\1/p' "$CONFIG" | head -1)

echo
info "sing-box en ecoute sur :${PORT_OUT}"
echo "    chemin WebSocket : ${PATH_OUT}"
echo
echo "  Etape suivante — faire pointer un reverse proxy HTTPS vers ce port,"
echo "  en autorisant l'upgrade WebSocket, puis installer l'interface :"
echo
echo "    curl -fsSL https://raw.githubusercontent.com/nebuloss/singbox-admin/main/install.sh \\"
echo "      | ADMIN_PASSWORD='...' PUBLIC_HOST=tunnel.example.com sh"
echo
