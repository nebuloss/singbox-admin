#!/bin/sh
# reset-password.sh — set the interface password without needing to log in.
#
# Use it when the password is lost, or to set one on an installation that
# started read-only. It rewrites the hash file directly; the running service
# picks the new value up on restart.
#
# Usage (as root on the appliance):
#   sh reset-password.sh                 # clears it; the interface then asks
#                                        # for a new one on the next visit
#   sh reset-password.sh 'new password'  # sets the one you provide
#
# Override APP_DIR if the app is not in /opt/singbox-admin.

set -eu

PATH="/usr/local/bin:$PATH"
export PATH

APP_DIR="${APP_DIR:-/opt/singbox-admin}"
SERVICE_NAME="${SERVICE_NAME:-singbox-admin}"
RESET_JS="$APP_DIR/dist-server/reset-password.js"

GREEN='\033[0;32m'; RED='\033[0;31m'; NC='\033[0m'
info()  { printf "${GREEN}[+]${NC} %s\n" "$*"; }
error() { printf "${RED}[x]${NC} %s\n" "$*"; exit 1; }

[ "$(id -u)" -eq 0 ] || error "a lancer en root"
[ -f "$RESET_JS" ]   || error "installation introuvable : $RESET_JS"
command -v node >/dev/null 2>&1 || error "node absent du PATH"

# No argument clears the hash; one argument sets that password.
node "$RESET_JS" "$@"

# The hash is read at startup, so the service has to be restarted to see it.
if command -v rc-service >/dev/null 2>&1; then
  rc-service "$SERVICE_NAME" restart >/dev/null 2>&1 || true
else
  systemctl restart "$SERVICE_NAME" >/dev/null 2>&1 || true
fi
info "Service redemarre"
