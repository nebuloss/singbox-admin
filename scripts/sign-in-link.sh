#!/bin/sh
# sign-in-link.sh — a one-time link to sign in without typing the password.
#
# Run it on the host and open the link on the device you want signed in — a
# phone, usually. It grants what the password grants, for a few minutes and a
# single use, which is why it is made here: needing root on this machine is the
# point.
#
#   sh sign-in-link.sh                                     # the fragment
#   sh sign-in-link.sh https://admin.example.com           # the whole link
#   sh sign-in-link.sh https://admin.example.com appareils   # and a page to land on
#
# Pages: activite, appareils, wireguard, applications, parametres.
#
# Override APP_DIR if the app is not in /opt/singbox-admin, LINK_MINUTES for
# how long it lives.

set -eu

PATH="/usr/local/bin:$PATH"
export PATH

APP_DIR="${APP_DIR:-/opt/singbox-admin}"
LINK_JS="$APP_DIR/dist-server/sign-in-link.js"

GREEN='\033[0;32m'; RED='\033[0;31m'; NC='\033[0m'
info()  { printf "${GREEN}[+]${NC} %s\n" "$*"; }
error() { printf "${RED}[x]${NC} %s\n" "$*"; exit 1; }

[ "$(id -u)" -eq 0 ] || error "a lancer en root"
[ -f "$LINK_JS" ]    || error "installation introuvable : $LINK_JS"
command -v node >/dev/null 2>&1 || error "node absent du PATH"

info "Lien de connexion :"
node "$LINK_JS" "$@"
