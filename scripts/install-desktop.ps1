# ── Kizuna Desktop Install Script (Windows) ─────────────────────────────
# Downloads the latest pre-built MSI installer for Windows.
#
# Usage (PowerShell):
#   irm https://raw.githubusercontent.com/ItsAshn/kizuna/main/scripts/install-desktop.ps1 | iex
# ─────────────────────────────────────────────────────────────────────────

$ErrorActionPreference = "Stop"
$ProgressPreference = "SilentlyContinue"

$Repo    = "ItsAshn/kizuna"
$ApiUrl  = "https://api.github.com/repos/$Repo/releases/latest"

Write-Host ""
Write-Host "  Kizuna Desktop Installer" -ForegroundColor White
Write-Host "  =========================" -ForegroundColor White
Write-Host ""

# ── Architecture detection ──────────────────────────────────────────────

$Arch = if ([Environment]::Is64BitOperatingSystem) { "x86_64" } else { "x86" }
Write-Host "[+] Platform: Windows ($Arch)" -ForegroundColor Green

# ── Fetch latest release ─────────────────────────────────────────────────

Write-Host "[+] Fetching latest release info..." -ForegroundColor Green

try {
    $Release = Invoke-RestMethod -Uri $ApiUrl -Method Get -TimeoutSec 30
} catch {
    Write-Host "[x] Failed to fetch release info: $_" -ForegroundColor Red
    exit 1
}

$TagName = $Release.tag_name
Write-Host "[+] Latest release: $TagName" -ForegroundColor Green

# ── Find MSI asset ───────────────────────────────────────────────────────

$MsiAsset = $Release.assets | Where-Object { $_.name -like "*.msi" -and $_.name -notlike "*.msi.sig" } | Select-Object -First 1

if (-not $MsiAsset) {
    # Fallback: try NSIS .exe installer
    $MsiAsset = $Release.assets | Where-Object { $_.name -like "*_x64-setup.exe" -and $_.name -notlike "*.sig" } | Select-Object -First 1
    if (-not $MsiAsset) {
        $MsiAsset = $Release.assets | Where-Object { $_.name -like "*.exe" -and $_.name -notlike "*.sig" } | Select-Object -First 1
    }
}

if (-not $MsiAsset) {
    Write-Host "[x] No MSI or EXE installer found in the latest release." -ForegroundColor Red
    Write-Host "[i] Check: https://github.com/ItsAshn/kizuna/releases/latest" -ForegroundColor Cyan
    exit 1
}

Write-Host "[+] Found installer: $($MsiAsset.name) ($([math]::Round($MsiAsset.size / 1MB, 1)) MB)" -ForegroundColor Green

# ── Check for WebView2 Runtime ───────────────────────────────────────────

$WebView2Key = "HKLM:\SOFTWARE\WOW6432Node\Microsoft\EdgeUpdate\Clients\{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}"
$WebView2Installed = $false

try {
    if (Test-Path $WebView2Key) {
        $WebView2Installed = $true
    }
} catch { }

# Also check via Get-AppxPackage (for per-user installs)
if (-not $WebView2Installed) {
    $wv2 = Get-ItemProperty "HKLM:\SOFTWARE\Microsoft\EdgeUpdate\Clients\{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}" -ErrorAction SilentlyContinue
    if ($wv2) { $WebView2Installed = $true }
}

if (-not $WebView2Installed) {
    Write-Host "[!] WebView2 Runtime is not installed." -ForegroundColor Yellow
    Write-Host "[!] The desktop app requires WebView2 to run." -ForegroundColor Yellow
    Write-Host "[i] Downloading WebView2 Evergreen Bootstrapper..." -ForegroundColor Cyan

    $WebView2Url = "https://go.microsoft.com/fwlink/p/?LinkId=2124703"
    $WebView2Path = "$env:TEMP\MicrosoftEdgeWebview2Setup.exe"

    try {
        Invoke-WebRequest -Uri $WebView2Url -OutFile $WebView2Path -UseBasicParsing
        Write-Host "[+] Installing WebView2 Runtime..." -ForegroundColor Green
        Start-Process -FilePath $WebView2Path -ArgumentList "/silent /install" -Wait -NoNewWindow
        Remove-Item $WebView2Path -Force -ErrorAction SilentlyContinue
        Write-Host "[+] WebView2 Runtime installed." -ForegroundColor Green
    } catch {
        Write-Host "[!] Could not install WebView2 automatically." -ForegroundColor Yellow
        Write-Host "[i] Download it manually from: https://developer.microsoft.com/microsoft-edge/webview2/" -ForegroundColor Cyan
    }
} else {
    Write-Host "[+] WebView2 Runtime is already installed." -ForegroundColor Green
}

# ── Download installer ───────────────────────────────────────────────────

$InstallerPath = "$env:TEMP\$($MsiAsset.name)"
Write-Host "[+] Downloading installer to $InstallerPath ..." -ForegroundColor Green

try {
    Invoke-WebRequest -Uri $MsiAsset.browser_download_url -OutFile $InstallerPath -UseBasicParsing
} catch {
    Write-Host "[x] Download failed: $_" -ForegroundColor Red
    exit 1
}

Write-Host "[+] Download complete." -ForegroundColor Green

# ── Signature verification (optional) ────────────────────────────────────

$SigAsset = $Release.assets | Where-Object { $_.name -eq "$($MsiAsset.name).sig" } | Select-Object -First 1
if ($SigAsset) {
    try {
        $SigPath = "$InstallerPath.sig"
        Invoke-WebRequest -Uri $SigAsset.browser_download_url -OutFile $SigPath -UseBasicParsing
        Write-Host "[+] Signature downloaded. Verification is handled by the auto-updater." -ForegroundColor Green
    } catch { }
}

# ── Run installer ────────────────────────────────────────────────────────

Write-Host ""
Write-Host "[+] Launching installer..." -ForegroundColor Green
Write-Host ""

if ($MsiAsset.name -like "*.msi") {
    Start-Process msiexec.exe -ArgumentList "/i `"$InstallerPath`"" -Wait
} else {
    Start-Process -FilePath $InstallerPath -Wait
}

Write-Host ""
Write-Host "[+] Kizuna Desktop $TagName installation complete!" -ForegroundColor Green

# Cleanup
Remove-Item $InstallerPath -Force -ErrorAction SilentlyContinue
Remove-Item "$InstallerPath.sig" -Force -ErrorAction SilentlyContinue
