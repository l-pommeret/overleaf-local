#!/bin/bash
# Installe Overleaf en local sur macOS, en une commande :
#   bash -c "$(curl -fsSL https://raw.githubusercontent.com/l-pommeret/overleaf-local/master/install.sh)"
set -euo pipefail

REPO="https://github.com/l-pommeret/overleaf-local.git"
DIR="${OVERLEAF_LOCAL_DIR:-$HOME/overleaf-local}"
PI_INSTALL="https://raw.githubusercontent.com/l-pommeret/pi-aristote/main/install.sh"

say() { printf '\033[1;32m›\033[0m %s\n' "$*"; }
die() { printf '\033[1;31m✗\033[0m %s\n' "$*" >&2; exit 1; }
ask() { # ask "question" -> 0 si oui (défaut : oui)
  local answer=""
  [[ -r /dev/tty ]] || return 0
  printf '\033[1;34m?\033[0m %s [O/n] ' "$1" > /dev/tty
  read -r answer < /dev/tty || true
  [[ ! "$answer" =~ ^[nN] ]]
}

[[ "$(uname -s)" == Darwin ]] || die "Ce script est prévu pour macOS."

# 1. Homebrew
if ! command -v brew >/dev/null; then
  for b in /opt/homebrew/bin/brew /usr/local/bin/brew; do [[ -x $b ]] && eval "$($b shellenv)"; done
fi
if ! command -v brew >/dev/null; then
  say "Installation de Homebrew (le mot de passe de la session Mac sera demandé)…"
  /bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)" < /dev/tty
  for b in /opt/homebrew/bin/brew /usr/local/bin/brew; do [[ -x $b ]] && eval "$($b shellenv)"; done
fi
command -v brew >/dev/null || die "Homebrew n'a pas pu être installé."
BREW_PREFIX="$(brew --prefix)"

# 2. Docker : on garde Docker Desktop s'il tourne, sinon Colima (plus léger).
if docker info >/dev/null 2>&1; then
  say "Docker est déjà là, on l'utilise."
else
  say "Installation de Docker (Colima)…"
  brew install --quiet colima docker docker-compose docker-buildx git
  if [[ "$(uname -m)" == arm64 ]] && ! /usr/bin/pgrep -q oahd; then
    say "Installation de Rosetta (Overleaf n'existe qu'en version Intel)…"
    /usr/sbin/softwareupdate --install-rosetta --agree-to-license
  fi
  # Config Docker : greffon compose de Homebrew, et plus de trace d'un ancien Docker Desktop.
  mkdir -p "$HOME/.docker"
  cfg="$HOME/.docker/config.json"
  [[ -s "$cfg" ]] || echo '{}' > "$cfg"
  if ! plutil -extract cliPluginsExtraDirs json -o - "$cfg" >/dev/null 2>&1; then
    cp "$cfg" "$cfg.bak-overleaf-local"
    plutil -insert cliPluginsExtraDirs -json "[\"$BREW_PREFIX/lib/docker/cli-plugins\"]" "$cfg"
  fi
  if plutil -extract credsStore raw "$cfg" 2>/dev/null | grep -qx desktop && ! command -v docker-credential-desktop >/dev/null; then
    [[ -f "$cfg.bak-overleaf-local" ]] || cp "$cfg" "$cfg.bak-overleaf-local"
    plutil -remove credsStore "$cfg"
  fi
fi

# 3. Le dépôt
if [[ -d "$DIR/.git" ]]; then
  say "Mise à jour de $DIR…"
  git -C "$DIR" pull --ff-only --quiet
else
  say "Téléchargement dans $DIR…"
  git clone --quiet "$REPO" "$DIR"
fi
chmod +x "$DIR/overleaf" "$DIR/local/init/50-sapin.sh"
ln -sf "$DIR/overleaf" "$BREW_PREFIX/bin/overleaf"

# 4. pi-aristote pour l'onglet Agent
if ! command -v pi >/dev/null; then
  if ask "Installer pi-aristote pour l'onglet Agent (assistant IA dans l'éditeur) ?"; then
    curl -fsSL "$PI_INSTALL" | sh || say "pi-aristote n'a pas pu s'installer : l'onglet Agent attendra."
  fi
fi

# 5. Lancement
"$DIR/overleaf" start
cat <<EOF

  Overleaf est installé. Pour la suite, dans le Terminal :
    overleaf          démarrer (et ouvrir le navigateur)
    overleaf stop     arrêter et libérer la mémoire

EOF
