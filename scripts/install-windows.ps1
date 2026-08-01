# ── Kizuna Windows Install Script ──────────────────────────────────────
# Installs prerequisites for building Kizuna on Windows.
# Requires: PowerShell 5.1+ (or PowerShell 7)
# Usage:
#   powershell -ExecutionPolicy Bypass -File install-windows.ps1
#   or
#   irm https://raw.githubusercontent.com/ItsAshn/kizuna/main/scripts/install-windows.ps1 | iex
# ─────────────────────────────────────────────────────────────────────────

$ErrorActionPreference = "Stop"

Write-Host ""
Write-Host "  Kizuna Windows Install" -ForegroundColor Cyan
Write-Host "  ======================" -ForegroundColor Cyan
Write-Host ""

function Log   { Write-Host "[+] $args" -ForegroundColor Green }
function Warn  { Write-Host "[!] $args" -ForegroundColor Yellow }
function Err   { Write-Host "[x] $args" -ForegroundColor Red }
function Info  { Write-Host "[i] $args" -ForegroundColor Cyan }

# ── Check winget ───────────────────────────────────────────────────────

$HasWinget = $false
try {
    $null = Get-Command winget -ErrorAction Stop
    $HasWinget = $true
    Log "winget found"
} catch {
    Warn "winget not found. Install it from: https://aka.ms/getwinget"
    Warn "Falling back to manual install URLs..."
}

# ── Install Node.js LTS ────────────────────────────────────────────────

if (Get-Command node -ErrorAction SilentlyContinue) {
    Log "Node.js: $(node --version)"
} else {
    if ($HasWinget) {
        Log "Installing Node.js LTS via winget..."
        winget install -e --id OpenJS.NodeJS.LTS --accept-source-agreements --accept-package-agreements
    } else {
        Log "Downloading Node.js LTS installer..."
        $nodeUrl = "https://nodejs.org/dist/v22.11.0/node-v22.11.0-x64.msi"
        $nodeInstaller = "$env:TEMP\node-installer.msi"
        Invoke-WebRequest -Uri $nodeUrl -OutFile $nodeInstaller
        Start-Process msiexec.exe -Wait -ArgumentList "/i `"$nodeInstaller`" /quiet /norestart"
        Remove-Item $nodeInstaller
    }
    refreshenv 2>$null
    Log "Node.js installed: $(node --version)"
}

# ── Install pnpm ───────────────────────────────────────────────────────

if (Get-Command pnpm -ErrorAction SilentlyContinue) {
    Log "pnpm: $(pnpm --version)"
} else {
    Log "Installing pnpm..."
    npm install -g pnpm
    Log "pnpm installed: $(pnpm --version)"
}

# ── Install Rust ───────────────────────────────────────────────────────

if (Get-Command rustc -ErrorAction SilentlyContinue) {
    Log "Rust: $(rustc --version)"
} else {
    Log "Installing Rust via rustup..."
    $rustupUrl = "https://win.rustup.rs/x86_64"
    $rustupInstaller = "$env:TEMP\rustup-init.exe"
    Invoke-WebRequest -Uri $rustupUrl -OutFile $rustupInstaller
    & $rustupInstaller -y --default-toolchain stable
    Remove-Item $rustupInstaller
    $env:Path = "$env:USERPROFILE\.cargo\bin;$env:Path"
    Log "Rust installed: $(rustc --version)"
}

# ── Check WebView2 Runtime ─────────────────────────────────────────────

$WebView2Ok = $false
$regPaths = @(
    "HKLM:\SOFTWARE\WOW6432Node\Microsoft\EdgeUpdate\Clients\{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}",
    "HKLM:\SOFTWARE\Microsoft\EdgeUpdate\Clients\{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}"
)
foreach ($p in $regPaths) {
    try {
        if (Test-Path $p) {
            $pv = Get-ItemPropertyValue -Path $p -Name pv -ErrorAction SilentlyContinue
            if ($pv) {
                Log "WebView2 Runtime: found (version $pv)"
                $WebView2Ok = $true
                break
            }
        }
    } catch { }
}

if (-not $WebView2Ok) {
    Warn "WebView2 Runtime not found."
    Log "Downloading WebView2 Evergreen Bootstrapper..."
    $wv2Url = "https://go.microsoft.com/fwlink/p/?LinkId=2124703"
    $wv2Installer = "$env:TEMP\MicrosoftEdgeWebview2Setup.exe"
    Invoke-WebRequest -Uri $wv2Url -OutFile $wv2Installer
    Start-Process -FilePath $wv2Installer -ArgumentList "/silent /install" -Wait
    Remove-Item $wv2Installer
    Log "WebView2 Runtime installed."
}

# ── Check Visual C++ Build Tools ───────────────────────────────────────

$VCToolsOk = Test-Path "C:\Program Files\Microsoft Visual Studio\2022\BuildTools\VC\Tools\MSVC" -ErrorAction SilentlyContinue
if (-not $VCToolsOk) {
    $VCToolsOk = Test-Path "C:\Program Files (x86)\Microsoft Visual Studio\2022\BuildTools\VC\Tools\MSVC" -ErrorAction SilentlyContinue
}

if (-not $VCToolsOk) {
    Warn "Visual C++ Build Tools not found."
    Warn "The Rust MSVC toolchain requires these to compile native crates."
    Info  "Download and install from:"
    Info  "  https://visualstudio.microsoft.com/visual-cpp-build-tools/"
    Info  "Select: 'Desktop development with C++' workload"
} else {
    Log "Visual C++ Build Tools: found"
}

# ── Summary ────────────────────────────────────────────────────────────

Write-Host ""
Log "Windows setup complete!"
Write-Host ""

if ($HasWinget) {
    Write-Host "  Next steps:"
    Write-Host "  1. Clone Kizuna:        git clone https://github.com/ItsAshn/kizuna.git"
    Write-Host "  2. Install & build:       cd kizuna && pnpm install && pnpm build"
    Write-Host "  3. Build desktop app:     cd apps/desktop && pnpm tauri build"
} else {
    Write-Host "  Next steps:"
    Write-Host "  1. Install winget:      https://aka.ms/getwinget"
    Write-Host "  2. Clone Kizuna:        git clone https://github.com/ItsAshn/kizuna.git"
    Write-Host "  3. Install & build:       cd kizuna && pnpm install && pnpm build"
    Write-Host "  4. Build desktop app:     cd apps/desktop && pnpm tauri build"
}
Write-Host ""
