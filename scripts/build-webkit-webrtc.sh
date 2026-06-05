#!/usr/bin/env bash
set -euo pipefail

# ── Build webkit2gtk with WebRTC ─────────────────────────────────────
# Rebuilds webkit2gtk-4.1 from source with ENABLE_WEB_RTC=ON.
# Supports Arch (PKGBUILD), Debian/Ubuntu (apt source), Fedora (dnf).
# WARNING: 30-60 minute build, ~20 GB disk space required.
# ──────────────────────────────────────────────────────────────────────

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
CYAN='\033[0;36m'
BOLD='\033[1m'
NC='\033[0m'

log()   { printf "${GREEN}[+]${NC} %s\n" "$1"; }
warn()  { printf "${YELLOW}[!]${NC} %s\n" "$1"; }
err()   { printf "${RED}[x]${NC} %s\n" "$1"; }
info()  { printf "${CYAN}[i]${NC} %s\n" "$1"; }
bold()  { printf "${BOLD}%s${NC}\n" "$1"; }

# ── Warning ──────────────────────────────────────────────────────────

bold
echo "  build-webkit-webrtc.sh"
echo "  ======================"
echo ""
warn "This will rebuild webkit2gtk-4.1 from source with WebRTC support."
warn "Estimated time: 30-60 minutes."
warn "Disk space needed: ~20 GB (mostly in /tmp or working dir)."
warn "Make sure you have at least 8 GB RAM free."
echo ""
echo "This is necessary for voice channels to work in the Kizuna desktop app."
echo ""

read -rp "Proceed? [y/N] " answer
if [[ ! "$answer" =~ ^[Yy]$ ]]; then
  info "Skipping."
  exit 0
fi

# ── Detect distro ────────────────────────────────────────────────────

DISTRO="unknown"
if [ -f /etc/arch-release ] || command -v pacman &>/dev/null; then
  DISTRO="arch"
elif [ -f /etc/debian_version ]; then
  DISTRO="debian"
elif [ -f /etc/fedora-release ] || [ -f /etc/redhat-release ]; then
  DISTRO="fedora"
fi

WORKDIR="$(mktemp -d)"
trap 'log "Cleaning up $WORKDIR"; rm -rf "$WORKDIR"' EXIT
log "Working directory: $WORKDIR"

# ── Arch ─────────────────────────────────────────────────────────────

build_arch() {
  log "Building webkit2gtk-4.1 with WebRTC on Arch..."

  local ver
  ver=$(pacman -Q webkit2gtk-4.1 2>/dev/null | awk '{print $2}')
  if [ -z "$ver" ]; then
    err "webkit2gtk-4.1 is not installed. Install it first:"
    err "  sudo pacman -S webkit2gtk-4.1"
    exit 1
  fi
  info "Current version: $ver"

  cd "$WORKDIR"
  info "Cloning PKGBUILD from gitlab..."
  git clone --depth 1 https://gitlab.archlinux.org/archlinux/packaging/packages/webkit2gtk-4.1.git pkgsrc
  cd pkgsrc

  # We must match the installed version, so checkout the tag
  local tag="webkit2gtk-4.1-${ver}"
  local pkgsrc_ver
  pkgsrc_ver=$(grep '^pkgver=' PKGBUILD | head -1 | cut -d= -f2)
  info "PKGBUILD upstream version: $pkgsrc_ver (installed: $ver)"
  if [ "$pkgsrc_ver" != "$ver" ]; then
    warn "PKGBUILD version ($pkgsrc_ver) doesn't match installed ($ver)."
    warn "This means the repo was updated. Building the latest version."
  fi

  if grep -q '\-DENABLE_WEB_RTC=OFF' PKGBUILD; then
    info "Patching PKGBUILD: OFF -> ON"
    sed -i 's/-DENABLE_WEB_RTC=OFF/-DENABLE_WEB_RTC=ON/' PKGBUILD
  fi

  # Ensure ccache and clang if available (speeds up the build)
  if command -v ccache &>/dev/null; then
    export CC="ccache clang"
    export CXX="ccache clang++"
  fi

  log "Installing build dependencies (this can take a while)..."
  makepkg -s --noconfirm --needed --nobuild

  log "Building webkit2gtk with WebRTC..."
  makepkg -si --noconfirm

  # Prevent pacman from downgrading on next -Syu
  local pacconf="/etc/pacman.conf"
  log "Pinning version in $pacconf..."
  if ! grep -q '^IgnorePkg.*webkit2gtk-4.1' "$pacconf"; then
    echo 'IgnorePkg = webkit2gtk-4.1' | sudo tee -a "$pacconf" > /dev/null
    log "Added 'IgnorePkg = webkit2gtk-4.1' to $pacconf"
  else
    info "Already pinned."
  fi

  log "Arch build complete."
}

# ── Debian/Ubuntu ────────────────────────────────────────────────────

build_debian() {
  log "Building webkit2gtk-4.1 with WebRTC on Debian/Ubuntu..."

  cd "$WORKDIR"

  info "Installing build dependencies..."
  sudo apt-get update
  sudo apt-get build-dep -y webkit2gtk 2>/dev/null || {
    warn "build-dep failed, installing common deps manually..."
    sudo apt-get install -y \
      cmake ninja-build gperf bison flex ruby python3 perl \
      libgtk-3-dev libsoup-3.0-dev libsecret-1-dev \
      libgstreamer1.0-dev libgstreamer-plugins-base1.0-dev \
      libgstreamer-plugins-bad1.0-dev \
      libenchant-2-dev libhyphen-dev libmanette-0.2-dev \
      libgbm-dev libdrm-dev libegl1-mesa-dev libgles2-mesa-dev \
      libasound2-dev libpulse-dev \
      libwoff-dev libjpeg-dev libpng-dev libwebp-dev \
      libavif-dev libjxl-dev libopenjp2-7-dev \
      libxslt1-dev libxml2-dev libsqlite3-dev \
      libsystemd-dev libgcrypt20-dev libtasn1-6-dev \
      liblcms2-dev libseccomp-dev libbrotli-dev \
      libepoxy-dev libxt-dev libxcomposite-dev libxdamage-dev libxrender-dev \
      glib-networking
  }

  info "Downloading webkit2gtk source..."
  apt source webkit2gtk
  cd webkit2gtk-*

  log "Configuring with ENABLE_WEB_RTC=ON..."
  cmake -B build -G Ninja \
    -DPORT=GTK \
    -DCMAKE_BUILD_TYPE=Release \
    -DUSE_SOUP3=ON \
    -DENABLE_WEB_RTC=ON \
    -DENABLE_GAMEPAD=OFF \
    -DUSE_SYSTEM_MALLOC=ON

  log "Building (this will take a long time)..."
  ninja -C build -j"$(nproc)"

  log "Installing to /usr/local..."
  sudo ninja -C build install

  log "Updating ldconfig..."
  sudo ldconfig

  log "Debian/Ubuntu build complete."
  info "WebKit libraries installed to /usr/local/lib"
  info "PKG_CONFIG_PATH=/usr/local/lib/pkgconfig should be set when building the desktop app."
}

# ── Fedora ────────────────────────────────────────────────────────────

build_fedora() {
  log "Building webkit2gtk with WebRTC on Fedora..."

  cd "$WORKDIR"

  info "Installing build dependencies..."
  sudo dnf install -y cmake ninja-build gperf bison flex ruby python3 perl
  sudo dnf install -y \
    gtk3-devel libsoup3-devel libsecret-devel \
    gstreamer1-devel gstreamer1-plugins-base-devel \
    gstreamer1-plugins-bad-free-devel \
    enchant2-devel hyphen-devel libmanette-devel \
    mesa-libgbm-devel libdrm-devel libepoxy-devel \
    alsa-lib-devel pulseaudio-libs-devel \
    libjpeg-turbo-devel libpng-devel libwebp-devel \
    libavif-devel libjxl-devel openjpeg2-devel \
    libxslt-devel libxml2-devel sqlite-devel \
    systemd-devel libgcrypt-devel libtasn1-devel \
    lcms2-devel libseccomp-devel brotli-devel \
    woff2-devel
  # Fedora may need -devel variants; add what's missing

  sudo dnf builddep -y webkit2gtk4.1 2>/dev/null || true

  # Download source from webkitgtk.org
  local ver
  ver=$(pkg-config --modversion webkit2gtk-4.1 2>/dev/null || echo "2.52.3")
  local tarball="webkitgtk-${ver}.tar.xz"
  info "Downloading webkitgtk source $ver..."
  curl -fsSLO "https://webkitgtk.org/releases/${tarball}"
  tar xf "$tarball"
  cd webkitgtk-*

  log "Configuring with ENABLE_WEB_RTC=ON..."
  cmake -B build -G Ninja \
    -DPORT=GTK \
    -DCMAKE_BUILD_TYPE=Release \
    -DUSE_SOUP3=ON \
    -DENABLE_WEB_RTC=ON \
    -DENABLE_GAMEPAD=OFF \
    -DUSE_SYSTEM_MALLOC=ON

  log "Building (this will take a long time)..."
  ninja -C build -j"$(nproc)"

  log "Installing to /usr/local..."
  sudo ninja -C build install

  log "Updating ldconfig..."
  sudo ldconfig

  log "Fedora build complete."
  info "WebKit libraries installed to /usr/local/lib"
}

# ── Dispatch ──────────────────────────────────────────────────────────

case "$DISTRO" in
  arch)   build_arch ;;
  debian) build_debian ;;
  fedora) build_fedora ;;
  *)
    err "Unsupported distro: ${DISTRO:-unknown}"
    info "Manual build instructions: https://webkitgtk.org/"
    info "Set cmake flag: -DENABLE_WEB_RTC=ON"
    exit 1
    ;;
esac

echo ""
log "WebKit WebRTC build complete!"
log "You can now build Kizuna with full voice + screen sharing support."
echo ""
