#!/usr/bin/env bash
set -euo pipefail

# ── Kizuna Linux Install Script ────────────────────────────────────────
# Installs system dependencies for building Kizuna on Linux.
# Detects Arch, Debian/Ubuntu, Fedora.
# Detects whether webkit2gtk has WebRTC and offers to rebuild it.
# ─────────────────────────────────────────────────────────────────────────

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
CYAN='\033[0;36m'
BOLD='\033[1m'
NC='\033[0m'

SKIP_WEBRTC=false
AUTO_YES=false

for arg in "$@"; do
  case "$arg" in
    --skip-webrtc) SKIP_WEBRTC=true ;;
    --yes|-y)      AUTO_YES=true ;;
  esac
done

log()  { printf "${GREEN}[+]${NC} %s\n" "$1"; }
warn() { printf "${YELLOW}[!]${NC} %s\n" "$1"; }
err()  { printf "${RED}[x]${NC} %s\n" "$1"; }
info() { printf "${CYAN}[i]${NC} %s\n" "$1"; }

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd 2>/dev/null || echo ".")"
FETCH_SCRIPT() {
  local name="$1"
  local local_path="${SCRIPT_DIR}/${name}"
  if [ -f "$local_path" ]; then
    echo "$local_path"
  else
    curl -fsSL "https://raw.githubusercontent.com/ItsAshn/kizuna/main/scripts/${name}" -o "/tmp/kizuna-${name}" 2>/dev/null
    chmod +x "/tmp/kizuna-${name}" 2>/dev/null || true
    echo "/tmp/kizuna-${name}"
  fi
}

confirm() {
  if $AUTO_YES; then return 0; fi
  local prompt="$1"
  read -rp "$prompt [y/N] " answer
  [[ "$answer" =~ ^[Yy]$ ]]
}

# ── Detect distro ─────────────────────────────────────────────────────

DISTRO="unknown"
if [ -f /etc/arch-release ] || command -v pacman &>/dev/null; then
  DISTRO="arch"
elif [ -f /etc/debian_version ]; then
  DISTRO="debian"
elif [ -f /etc/fedora-release ] || [ -f /etc/redhat-release ]; then
  DISTRO="fedora"
fi

log "Distro detected: ${DISTRO}"

# ── Install Tauri system dependencies ─────────────────────────────────

TAURI_DEPS_ARCH=(
  webkit2gtk-4.1 gtk3 libappindicator-gtk3 librsvg
  alsa-lib pipewire libpulse desktop-file-utils
  patchelf
  base-devel git curl
)

TAURI_DEPS_DEBIAN=(
  libwebkit2gtk-4.1-dev libgtk-3-dev libappindicator3-dev
  librsvg2-dev patchelf
  libpipewire-0.3-dev libspa-0.2-dev
  libasound2-dev libgbm-dev
  libfuse2
  build-essential curl git
)

TAURI_DEPS_FEDORA=(
  webkit2gtk4.1-devel gtk3-devel libappindicator-gtk3-devel
  librsvg2-devel patchelf
  pipewire-devel alsa-lib-devel mesa-libgbm-devel
  fuse
  gcc gcc-c++ curl git
)

install_deps() {
  local pkgs=("$@")
  case "$DISTRO" in
    arch)
      log "Installing Arch packages: ${pkgs[*]}"
      sudo pacman -S --needed --noconfirm "${pkgs[@]}"
      ;;
    debian)
      log "Installing Debian/Ubuntu packages: ${pkgs[*]}"
      sudo apt-get update
      sudo apt-get install -y "${pkgs[@]}"
      ;;
    fedora)
      log "Installing Fedora packages: ${pkgs[*]}"
      sudo dnf install -y "${pkgs[@]}"
      ;;
  esac
}

case "$DISTRO" in
  arch)   install_deps "${TAURI_DEPS_ARCH[@]}" ;;
  debian) install_deps "${TAURI_DEPS_DEBIAN[@]}" ;;
  fedora) install_deps "${TAURI_DEPS_FEDORA[@]}" ;;
  *)
    warn "Unknown distro. You may need to install Tauri deps manually."
    info "See: https://tauri.app/start/prerequisites/"
    ;;
esac

log "System dependencies installed."

# ── WebKit WebRTC detection ──────────────────────────────────────────

check_webkit_webrtc() {
  # On Arch we can check whether webkit2gtk came from extra repo (no WebRTC)
  if [ "$DISTRO" = "arch" ]; then
    local source=""
    source=$(pacman -Qi webkit2gtk-4.1 2>/dev/null | grep '^Installed From' | awk '{print $NF}') || true
    if [ "$source" = "extra" ] || [ "$source" = "core" ]; then
      return 1  # Official repo → no WebRTC
    elif [ "$source" = "unknown" ]; then
      # Could be locally built / AUR → assume has WebRTC
      return 0
    else
      return 0
    fi
  fi

  # On Debian/Fedora: attempt a quick runtime check via a small js snippet
  # (webkit2gtk doesn't ship a standalone js runner, so we treat it as unknown)
  return 1
}

if ! $SKIP_WEBRTC && ! check_webkit_webrtc; then
  echo ""
  warn "WebRTC support in webkit2gtk-4.1 is NOT enabled."
  warn "Voice channels and screen sharing will NOT work in the desktop app."
  echo ""
  if confirm "Rebuild webkit2gtk-4.1 with WebRTC support? (30-60 min, ~20 GB disk)"; then
    BUILD_SCRIPT=$(FETCH_SCRIPT "build-webkit-webrtc.sh")
    bash "$BUILD_SCRIPT"
  else
    echo ""
    info "Skipping WebRTC rebuild."
    info "Desktop voice will not work. Use the web client for voice features."
    info "  To use the web client:  pnpm dev"
    echo ""
  fi
else
  log "webkit2gtk WebRTC support appears to be present."
fi

echo ""
log "Linux setup complete."
