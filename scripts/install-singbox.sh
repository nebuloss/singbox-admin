#!/bin/sh
# install-singbox.sh — install sing-box and lay down a VLESS + WebSocket inbound
# for singbox-admin to manage.
#
# TLS is deliberately not handled here: the inbound speaks plain WebSocket and
# expects a reverse proxy (nginx, Caddy, HAProxy…) in front of it to terminate
# HTTPS on 443 and forward the secret path. Certificate renewal stays where it
# already works instead of being duplicated inside sing-box.
#
# Usage, as root:
#   curl -fsSL https://raw.githubusercontent.com/nebuloss/singbox-admin/main/scripts/install-singbox.sh | sh
#
# Systems: Alpine Linux (OpenRC), Debian/Ubuntu (systemd)

set -eu

# Debian's /bin/sh starts with PATH=/sbin:/bin:/usr/sbin:/usr/bin — no
# /usr/local/bin. Without this, the binary installed below is invisible to the
# rest of this very script.
PATH="/usr/local/bin:$PATH"
export PATH

# ── Settings, all overridable from the environment ───────────────────────────
CONFIG="${CONFIG:-/etc/sing-box/config.json}"
LISTEN_PORT="${LISTEN_PORT:-8081}"
# WS_PATH defaults to a random one, generated only when writing a new config.

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
}

install_singbox() {
  if command -v sing-box >/dev/null 2>&1; then
    info "sing-box deja present : $(sing-box version | head -1)"
    return
  fi

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

      case "$(uname -m)" in
        x86_64)  arch=amd64 ;;
        aarch64) arch=arm64 ;;
        armv7l)  arch=armv7 ;;
        *) error "architecture non geree : $(uname -m)" ;;
      esac

      tag=$(curl -fsSL https://api.github.com/repos/SagerNet/sing-box/releases/latest \
        | grep '"tag_name"' | head -1 | cut -d'"' -f4)
      [ -n "${tag:-}" ] || error "version de sing-box introuvable"

      version="${tag#v}"
      dir="sing-box-${version}-linux-${arch}"
      info "Telechargement de sing-box ${tag} (${arch})…"
      curl -fsSL "https://github.com/SagerNet/sing-box/releases/download/${tag}/${dir}.tar.gz" \
        | tar -xz -C /tmp
      install -m 755 "/tmp/${dir}/sing-box" /usr/local/bin/sing-box
      rm -rf "/tmp/${dir}"
      ;;
  esac
  info "sing-box installe : $(sing-box version | head -1)"
}

write_config() {
  if [ -f "$CONFIG" ]; then
    warn "configuration existante conservee : $CONFIG"
    return
  fi

  mkdir -p "$(dirname "$CONFIG")"
  # Both are sixteen random bytes in base64url. A VLESS identifier need not be
  # a UUID: given anything shorter, both sing-box and Xray hash it into the
  # same v5 over the nil namespace, so the two ends agree without being told.
  short() { head -c 16 /dev/urandom | base64 | tr '+/' '-_' | tr -d '=\n'; }
  uuid=$(short)
  # A random path acts as a light shared secret: scanners hitting the hostname
  # get a 404 from the reverse proxy instead of finding the inbound.
  ws_path="${WS_PATH:-/$(short)}"
  # The Clash controller is where the byte counters live. Loopback only, behind
  # a secret of its own: the interface reads it, nothing else can reach it.

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
        { "uuid": "${uuid}", "name": "${uuid}" }
      ],
      "transport": { "type": "ws", "path": "${ws_path}" }
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
  },
  "experimental": {
    "clash_api": {
      "external_controller": "127.0.0.1:9090",
      "secret": "$(short)"
    }
  }
}
EOF
  chmod 600 "$CONFIG"
  info "Configuration ecrite dans $CONFIG"
}

install_service() {
  if [ "$OS" = alpine ]; then
    if [ ! -f /etc/init.d/sing-box ]; then
      cat > /etc/init.d/sing-box <<EOF
#!/sbin/openrc-run

name="sing-box"
description="sing-box proxy platform"
command="$(command -v sing-box)"
command_args="run -c $CONFIG"
command_background=true
pidfile="/run/\${RC_SVCNAME}.pid"

extra_started_commands="reload"

depend() { need net; after firewall; }

# sing-box rebuilds its instance in place on SIGHUP: the process survives and
# established transfers keep running, so a change to the user list applies
# without cutting anyone off.
reload() {
    ebegin "Reloading \${RC_SVCNAME}"
    sing-box check -c $CONFIG && start-stop-daemon --signal HUP --pidfile "\$pidfile"
    eend \$?
}
EOF
      chmod +x /etc/init.d/sing-box
    fi
    rc-update add sing-box default >/dev/null 2>&1 || true
    rc-service sing-box restart >/dev/null 2>&1 || rc-service sing-box start
  else
    if [ ! -f /etc/systemd/system/sing-box.service ]; then
      cat > /etc/systemd/system/sing-box.service <<EOF
[Unit]
Description=sing-box proxy platform
After=network-online.target

[Service]
Type=simple
ExecStart=$(command -v sing-box) run -c $CONFIG
# In place, so a change to the user list does not cut anyone off.
ExecReload=/bin/kill -HUP \$MAINPID
Restart=always
RestartSec=5
LimitNOFILE=65535

[Install]
WantedBy=multi-user.target
EOF
      systemctl daemon-reload
    fi
    systemctl enable --now sing-box >/dev/null 2>&1
    systemctl restart sing-box
  fi
}

summary() {
  # Read back from the file rather than from the variables above: when an
  # existing configuration was kept, those never held its real values.
  port=$(sed -n 's/.*"listen_port"[[:space:]]*:[[:space:]]*\([0-9]*\).*/\1/p' "$CONFIG" | head -1)
  path=$(sed -n 's/.*"path"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' "$CONFIG" | head -1)

  echo
  info "sing-box en ecoute sur :${port}"
  echo "    chemin WebSocket : ${path}"
  echo
  echo "  Etape suivante — faire pointer un reverse proxy HTTPS vers ce port,"
  echo "  en autorisant l'upgrade WebSocket, puis installer l'interface :"
  echo
  echo "    curl -fsSL https://raw.githubusercontent.com/nebuloss/singbox-admin/main/install.sh \\"
  echo "      | ADMIN_PASSWORD='...' PUBLIC_HOST=tunnel.example.com sh"
  echo
}

# ── Run ──────────────────────────────────────────────────────────────────────

check_host
install_singbox
write_config

sing-box check -c "$CONFIG" || error "configuration invalide"
info "Configuration validee"

install_service
sleep 2
summary
