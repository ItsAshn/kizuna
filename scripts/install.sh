#!/usr/bin/env bash
set -euo pipefail

# ── Kizuna Install Script ───────────────────────────────────────────────
# Usage:
#   curl -fsSL https://raw.githubusercontent.com/ItsAshn/kizuna/main/scripts/install.sh | bash
#   curl -fsSL https://raw.githubusercontent.com/ItsAshn/kizuna/main/scripts/install.sh | bash -s -- --skip-webrtc
#   curl -fsSL https://raw.githubusercontent.com/ItsAshn/kizuna/main/scripts/install.sh | bash -s -- --yes
# ─────────────────────────────────────────────────────────────────────────

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
CYAN='\033[0;36m'
BOLD='\033[1m'
NC='\033[0m'

SKIP_WEBRTC=false
AUTO_YES=false
REPO_URL="https://raw.githubusercontent.com/ItsAshn/kizuna/main/scripts"

log()  { printf "${GREEN}[+]${NC} %s\n" "$1"; }
warn() { printf "${YELLOW}[!]${NC} %s\n" "$1"; }
err()  { printf "${RED}[x]${NC} %s\n" "$1"; }
info() { printf "${CYAN}[i]${NC} %s\n" "$1"; }
bold() { printf "${BOLD}%s${NC}\n" "$1"; }

for arg in "$@"; do
  case "$arg" in
    --skip-webrtc) SKIP_WEBRTC=true ;;
    --yes|-y)      AUTO_YES=true ;;
    *)             ;;
  esac
done

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd 2>/dev/null || echo "."
)"
FETCH_SCRIPT() {
  local name="$1"
  local local_path="${SCRIPT_DIR}/${name}"
  if [ -f "$local_path" ]; then
    echo "$local_path"
  else
    curl -fsSL "${REPO_URL}/${name}" -o "/tmp/kizuna-${name}" 2>/dev/null
    chmod +x "/tmp/kizuna-${name}" 2>/dev/null || true
    echo "/tmp/kizuna-${name}"
  fi
}

bold
echo "  Kizuna Install Script"
echo "  ======================"
echo ""

# ── OS detection ──────────────────────────────────────────────────────
OS="$(uname -s)"
case "$OS" in
  Linux)  PLATFORM=linux ;;
  MINGW*|MSYS*|CYGWIN*) PLATFORM=windows ;;
  Darwin) PLATFORM=macos ;;
  *)
    err "Unsupported OS: $OS"
    exit 1
    ;;
esac

log "Platform detected: ${PLATFORM}"

# ── Toolchain checks ──────────────────────────────────────────────────

NEED_RUST=false
NEED_NODE=false
NEED_PNPM=false

if command -v rustc &>/dev/null; then
  log "Rust: $(rustc --version)"
else
  warn "Rust not found"
  NEED_RUST=true
fi

if command -v node &>/dev/null; then
  NODE_VER=$(node -v | sed 's/v//' | cut -d. -f1)
  if [ "$NODE_VER" -ge 18 ] 2>/dev/null; then
    log "Node.js: $(node -v)"
  else
    warn "Node.js $(node -v) is too old (need >= 18)"
    NEED_NODE=true
  fi
else
  warn "Node.js not found"
  NEED_NODE=true
fi

if command -v pnpm &>/dev/null; then
  log "pnpm: $(pnpm --version)"
else
  warn "pnpm not found"
  NEED_PNPM=true
fi

# ── Install toolchains ────────────────────────────────────────────────

install_rust() {
  log "Installing Rust via rustup..."
  curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh -s -- -y --default-toolchain stable
  # shellcheck disable=SC1090
  source "$HOME/.cargo/env"
  log "Rust installed: $(rustc --version)"
}

install_node() {
  log "Installing Node.js LTS via fnm..."
  if command -v fnm &>/dev/null; then
    fnm install --lts && fnm default lts-latest
  else
    curl -fsSL https://fnm.vercel.app/install | bash
    # shellcheck disable=SC1090
    source "$HOME/.bashrc" 2>/dev/null || true
    export PATH="$HOME/.local/share/fnm:$PATH"
    fnm install --lts && fnm default lts-latest
  fi
  eval "$(fnm env)"
  log "Node.js installed: $(node -v)"
}

install_pnpm() {
  log "Installing pnpm..."
  npm install -g pnpm 2>/dev/null || curl -fsSL https://get.pnpm.io/install.sh | sh -
  export PNPM_HOME="$HOME/.local/share/pnpm"
  export PATH="$PNPM_HOME:$PATH"
  log "pnpm installed: $(pnpm --version)"
}

$NEED_RUST && install_rust
$NEED_NODE && install_node
$NEED_PNPM && install_pnpm

# Reload shell env if needed
source "$HOME/.cargo/env" 2>/dev/null || true
export PNPM_HOME="${PNPM_HOME:-$HOME/.local/share/pnpm}"
export PATH="$HOME/.cargo/bin:$PNPM_HOME:$HOME/.local/share/fnm:$PATH"

# ── Platform-specific install ─────────────────────────────────────────

if [ "$PLATFORM" = "linux" ]; then
  LINUX_SCRIPT=$(FETCH_SCRIPT "install-linux.sh")
  SKIP_FLAG=""
  $SKIP_WEBRTC && SKIP_FLAG="--skip-webrtc"
  $AUTO_YES    && SKIP_FLAG="$SKIP_FLAG --yes"
  bash "$LINUX_SCRIPT" $SKIP_FLAG
elif [ "$PLATFORM" = "windows" ]; then
  WIN_SCRIPT=$(FETCH_SCRIPT "install-windows.ps1")
  powershell -ExecutionPolicy Bypass -File "$WIN_SCRIPT"
else
  warn "macOS: Tauri is supported but no native install script yet."
  warn "Please install Rust, Node.js, and pnpm manually, then run:"
  echo ""
  echo "  pnpm install"
  echo "  pnpm build"
  echo ""
  info "See: https://tauri.app/start/prerequisites/"
  exit 0
fi

# ── Install & build Kizuna ────────────────────────────────────────────

PROJECT_DIR="${1:-$HOME/kizuna}"
if [ ! -d "$PROJECT_DIR" ]; then
  log "Cloning Kizuna to $PROJECT_DIR ..."
  git clone https://github.com/ItsAshn/kizuna.git "$PROJECT_DIR"
fi

log "Installing dependencies..."
(cd "$PROJECT_DIR" && pnpm install --frozen-lockfile)

log "Building..."
(cd "$PROJECT_DIR" && pnpm build)

if [ -d "$PROJECT_DIR/apps/desktop" ]; then
  echo ""
  log "Kizuna installation complete!"
  echo ""
  echo "  To start the server:   cd $PROJECT_DIR && pnpm --filter server dev"
  echo "  To build the desktop app: cd $PROJECT_DIR/apps/desktop && pnpm tauri build"
  echo "  To run the web client:   cd $PROJECT_DIR/apps/desktop && pnpm dev"
  echo ""
fi
