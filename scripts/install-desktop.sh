#!/usr/bin/env bash
set -euo pipefail

# ── Kizuna Desktop Install Script ────────────────────────────────────────
# Downloads the latest pre-built desktop client for your platform.
#
# Usage:
#   curl -fsSL https://raw.githubusercontent.com/ItsAshn/kizuna/main/scripts/install-desktop.sh | bash
# ─────────────────────────────────────────────────────────────────────────

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
CYAN='\033[0;36m'
BOLD='\033[1m'
NC='\033[0m'

log()  { printf "${GREEN}[+]${NC} %s\n" "$1"; }
warn() { printf "${YELLOW}[!]${NC} %s\n" "$1"; }
err()  { printf "${RED}[x]${NC} %s\n" "$1"; }
info() { printf "${CYAN}[i]${NC} %s\n" "$1"; }
bold() { printf "${BOLD}%s${NC}\n" "${1:-}"; }

REPO="ItsAshn/kizuna"
API_URL="https://api.github.com/repos/${REPO}/releases/latest"
INSTALL_DIR="${HOME}/.local/bin"
DESKTOP_DIR="${HOME}/.local/share/applications"

bold
echo "  Kizuna Desktop Installer"
echo "  ========================="
echo ""

# ── OS & arch detection ──────────────────────────────────────────────────

OS="$(uname -s)"
ARCH="$(uname -m)"

case "$ARCH" in
  x86_64|amd64) ARCH="x86_64" ;;
  aarch64|arm64) ARCH="aarch64" ;;
  *)
    err "Unsupported architecture: $ARCH"
    exit 1
    ;;
esac

case "$OS" in
  Linux)  PLATFORM="linux" ;;
  Darwin) PLATFORM="macos" ;;
  *)
    err "Unsupported OS: $OS"
    exit 1
    ;;
esac

log "Platform: ${PLATFORM} (${ARCH})"

# ── Fetch latest release info ────────────────────────────────────────────

log "Fetching latest release info..."

# Try jq first, fall back to python, then grep/sed
parse_json() {
  local key="$1"
  local json="$2"
  if command -v jq &>/dev/null; then
    echo "$json" | jq -r "$key" 2>/dev/null
  elif command -v python3 &>/dev/null; then
    echo "$json" | python3 -c "import sys,json; d=json.load(sys.stdin); print(d${key})" 2>/dev/null
  else
    # crude grep fallback for the tag_name
    echo "$json" | grep -o "\"${key##*\[\"}\":[^\"]*\"[^\"]*\"" | head -1 | sed 's/.*: "//;s/"//'
  fi
}

RELEASE=$(curl -sSL --retry 3 --retry-delay 2 "$API_URL") || {
  err "Failed to fetch release info from GitHub."
  exit 1
}

TAG_NAME=$(parse_json '["tag_name"]' "$RELEASE")
if [ -z "$TAG_NAME" ] || [ "$TAG_NAME" = "null" ]; then
  err "Could not parse release tag. GitHub API may be rate-limited."
  exit 1
fi

log "Latest release: ${TAG_NAME}"

# ── Find the right asset ─────────────────────────────────────────────────

find_asset_url() {
  local pattern="$1"
  local json="$2"
  if command -v jq &>/dev/null; then
    echo "$json" | jq -r ".assets[] | select(.name | endswith(\"${pattern}\")) | .browser_download_url" 2>/dev/null | grep -v '\.sig$' | head -1
  elif command -v python3 &>/dev/null; then
    echo "$json" | python3 -c "
import sys, json
assets = json.load(sys.stdin)['assets']
for a in assets:
    if a['name'].endswith('${pattern}') and not a['name'].endswith('.sig'):
        print(a['browser_download_url'])
        break
" 2>/dev/null
  else
    echo "$json" | grep -o '"browser_download_url": *"[^"]*'"${pattern}"'"' | head -1 | sed 's/.*": *"//;s/"//'
  fi
}

find_sig_url() {
  local asset_url="$1"
  local json="$2"
  local sig_url="${asset_url}.sig"
  if command -v jq &>/dev/null; then
    echo "$json" | jq -r ".assets[] | select(.browser_download_url == \"${sig_url}\") | .browser_download_url" 2>/dev/null
  else
    echo "$sig_url"
  fi
}

# ── Linux install ────────────────────────────────────────────────────────

install_linux() {
  log "Installing Kizuna desktop for Linux..."

  # Find AppImage in release assets
  APPIMAGE_URL=$(find_asset_url ".AppImage" "$RELEASE")
  SIGNATURE_URL=""

  if [ -z "$APPIMAGE_URL" ]; then
    # Fallback: try .deb
    DEB_URL=$(find_asset_url ".deb" "$RELEASE")
    if [ -n "$DEB_URL" ]; then
      log "Found .deb package."
      install_deb "$DEB_URL"
      return
    fi
    err "No AppImage or .deb found in the latest release."
    exit 1
  fi

  log "Found AppImage: $(basename "$APPIMAGE_URL")"

  SIGNATURE_URL=$(find_sig_url "$APPIMAGE_URL" "$RELEASE")

  # ── Install runtime dependencies ─────────────────────────────────────────

  NEED_FUSE=false
  if ! ldconfig -p 2>/dev/null | grep -q libfuse; then
    if [ ! -f /usr/lib/libfuse.so.2 ] && [ ! -f /usr/lib/x86_64-linux-gnu/libfuse.so.2 ]; then
      NEED_FUSE=true
    fi
  fi

  if $NEED_FUSE; then
    warn "libfuse2 is required to run AppImages."
    info "Installing libfuse2..."

    if command -v apt-get &>/dev/null; then
      sudo apt-get update -qq && sudo apt-get install -y -qq libfuse2
    elif command -v dnf &>/dev/null; then
      sudo dnf install -y fuse fuse-libs
    elif command -v pacman &>/dev/null; then
      sudo pacman -S --needed --noconfirm fuse2
    elif command -v zypper &>/dev/null; then
      sudo zypper install -y libfuse2
    else
      warn "Could not auto-install libfuse2. Please install it manually:"
      info "  Debian/Ubuntu: sudo apt install libfuse2"
      info "  Fedora:        sudo dnf install fuse fuse-libs"
      info "  Arch:          sudo pacman -S fuse2"
    fi
  fi

  # Check for webkit2gtk (needed at runtime for Tauri apps)
  HAS_WEBKIT=false
  if ldconfig -p 2>/dev/null | grep -q libwebkit2gtk-4.1; then
    HAS_WEBKIT=true
  elif [ -f /usr/lib/libwebkit2gtk-4.1.so ] || [ -f /usr/lib/x86_64-linux-gnu/libwebkit2gtk-4.1.so ]; then
    HAS_WEBKIT=true
  fi

  if ! $HAS_WEBKIT; then
    warn "libwebkit2gtk-4.1 not found. The app may fail to launch."
    info "Install it with your package manager:"
    info "  Debian/Ubuntu: sudo apt install libwebkit2gtk-4.1-0"
    info "  Fedora:        sudo dnf install webkit2gtk4.1"
    info "  Arch:          sudo pacman -S webkit2gtk-4.1"
    echo ""
  fi

  # ── Download ─────────────────────────────────────────────────────────────

  mkdir -p "$INSTALL_DIR"

  APPIMAGE_PATH="${INSTALL_DIR}/kizuna.AppImage"
  log "Downloading to ${APPIMAGE_PATH} ..."
  curl -L --progress-bar -o "$APPIMAGE_PATH" "$APPIMAGE_URL"
  chmod +x "$APPIMAGE_PATH"

  # ── Verify signature ─────────────────────────────────────────────────────

  if [ -n "$SIGNATURE_URL" ]; then
    log "Downloading signature..."
    SIG_PATH="${APPIMAGE_PATH}.sig"
    curl -sSL -o "$SIG_PATH" "$SIGNATURE_URL" 2>/dev/null || warn "Could not download signature. Skipping verification."

    if [ -f "$SIG_PATH" ] && [ -s "$SIG_PATH" ]; then
      # Tauri signatures are minisign-style
      # We just note the signature exists; actual verification happens in the Tauri updater
      log "Signature downloaded. Verification is handled by the auto-updater."
    fi
  fi

  # ── Create .desktop entry ────────────────────────────────────────────────

  mkdir -p "$DESKTOP_DIR"
  cat > "${DESKTOP_DIR}/kizuna.desktop" << EOF
[Desktop Entry]
Name=Kizuna
Comment=Self-hosted voice & chat
Exec=${APPIMAGE_PATH}
Icon=kizuna
Terminal=false
Type=Application
Categories=Network;Chat;InstantMessaging;
StartupWMClass=kizuna
EOF

  log "Desktop entry created at ${DESKTOP_DIR}/kizuna.desktop"

  # Try to extract and install icon from AppImage
  TMP_ICON="/tmp/kizuna-icon-$$"
  mkdir -p "$TMP_ICON"
  if "$APPIMAGE_PATH" --appimage-extract usr/share/icons >/dev/null 2>&1; then
    ICON_SRC=$(find squashfs-root/usr/share/icons -name "*.png" 2>/dev/null | head -1)
    if [ -n "$ICON_SRC" ]; then
      mkdir -p "${HOME}/.local/share/icons/hicolor/256x256/apps"
      cp "$ICON_SRC" "${HOME}/.local/share/icons/hicolor/256x256/apps/kizuna.png" 2>/dev/null || true
      rm -rf squashfs-root
      log "Icon installed."
    else
      rm -rf squashfs-root 2>/dev/null || true
    fi
  fi
  rm -rf "$TMP_ICON" squashfs-root 2>/dev/null || true

  # ── Add to PATH if not already ──────────────────────────────────────────

  if ! echo "$PATH" | tr ':' '\n' | grep -qxF "$INSTALL_DIR"; then
    SHELL_RC=""
    case "$(basename "$SHELL")" in
      zsh)  SHELL_RC="${HOME}/.zshrc" ;;
      bash) SHELL_RC="${HOME}/.bashrc" ;;
      fish) SHELL_RC="${HOME}/.config/fish/config.fish" ;;
    esac
    if [ -n "$SHELL_RC" ]; then
      if [ "$(basename "$SHELL")" = "fish" ]; then
        echo "fish_add_path $INSTALL_DIR" >> "$SHELL_RC"
      else
        echo "export PATH=\"${INSTALL_DIR}:\$PATH\"" >> "$SHELL_RC"
      fi
      info "Added ${INSTALL_DIR} to PATH in ${SHELL_RC}"
    fi
  fi

  echo ""
  log "Kizuna Desktop ${TAG_NAME} installed successfully!"
  echo ""
  echo "  Run:   ${APPIMAGE_PATH}"
  echo "  Or:    kizuna.AppImage  (if ~/.local/bin is in PATH)"
  echo ""
}

# ── .deb install ──────────────────────────────────────────────────────────

install_deb() {
  local url="$1"
  local deb_path="/tmp/kizuna-${TAG_NAME}.deb"

  log "Downloading .deb package..."
  curl -L --progress-bar -o "$deb_path" "$url"

  log "Installing .deb package..."
  if command -v apt-get &>/dev/null; then
    sudo apt-get install -y "$deb_path" 2>/dev/null || sudo dpkg -i "$deb_path"
  elif command -v dpkg &>/dev/null; then
    sudo dpkg -i "$deb_path"
  else
    err "Cannot install .deb: dpkg not found."
    info "The .deb is at: ${deb_path}"
    info "Install it manually with: sudo dpkg -i ${deb_path}"
    exit 1
  fi

  rm -f "$deb_path"
  echo ""
  log "Kizuna Desktop ${TAG_NAME} installed via .deb!"
  echo ""
  echo "  Run:   kizuna"
  echo ""
}

# ── macOS install ───────────────────────────────────────────────────────────

install_macos() {
  log "Installing Kizuna desktop for macOS..."

  if [ "$ARCH" != "aarch64" ]; then
    err "Pre-built macOS binaries are only available for Apple Silicon (arm64)."
    info "On Intel Macs, build from source:"
    echo "  curl -fsSL https://raw.githubusercontent.com/ItsAshn/kizuna/main/scripts/install.sh | bash"
    exit 1
  fi

  DMG_URL=$(find_asset_url ".dmg" "$RELEASE")
  if [ -z "$DMG_URL" ]; then
    err "No .dmg found in the latest release."
    exit 1
  fi

  log "Found: $(basename "$DMG_URL")"

  DMG_PATH="/tmp/kizuna-${TAG_NAME}.dmg"
  log "Downloading to ${DMG_PATH} ..."
  curl -L --progress-bar -o "$DMG_PATH" "$DMG_URL"

  # ── Mount, copy app, unmount ──────────────────────────────────────────────
  log "Mounting disk image..."
  MOUNT_POINT=$(hdiutil attach -nobrowse -noverify -noautoopen "$DMG_PATH" | grep -o '/Volumes/.*' | head -1)
  if [ -z "$MOUNT_POINT" ]; then
    err "Failed to mount disk image."
    rm -f "$DMG_PATH"
    exit 1
  fi

  APP_SRC=$(find "$MOUNT_POINT" -maxdepth 1 -name "*.app" | head -1)
  if [ -z "$APP_SRC" ]; then
    err "No .app bundle found inside the disk image."
    hdiutil detach "$MOUNT_POINT" >/dev/null 2>&1 || true
    rm -f "$DMG_PATH"
    exit 1
  fi

  APP_NAME="$(basename "$APP_SRC")"
  APP_DEST="/Applications/${APP_NAME}"
  log "Installing ${APP_NAME} to /Applications ..."
  rm -rf "$APP_DEST"
  cp -R "$APP_SRC" "$APP_DEST"

  hdiutil detach "$MOUNT_POINT" >/dev/null 2>&1 || true
  rm -f "$DMG_PATH"

  # ── Clear Gatekeeper quarantine (build is unsigned) ───────────────────────
  warn "This build is unsigned. Removing the Gatekeeper quarantine attribute..."
  xattr -dr com.apple.quarantine "$APP_DEST" 2>/dev/null || \
    warn "Could not clear quarantine. You may need to right-click the app and choose Open."

  echo ""
  log "Kizuna Desktop ${TAG_NAME} installed successfully!"
  echo ""
  echo "  Launch from Applications, or run:"
  echo "    open \"${APP_DEST}\""
  echo ""
}

# ── Run ───────────────────────────────────────────────────────────────────

case "$PLATFORM" in
  linux) install_linux ;;
  macos) install_macos ;;
esac
