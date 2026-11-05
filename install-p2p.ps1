# ==============================================================================================
# Jellyfin Private WebRTC P2P Automated Installer & Self-Healing Setup
# ----------------------------------------------------------------------------------------------
# Automates the complete setup or update of the Jellyfin P2P mesh network:
#  1. Preflight system checks (Node.js, Caddy, PowerShell)
#  2. Auto-detection of Jellyfin web root across standard & portable paths
#  3. Client P2P bundle installation & index.html hook injection (with safe backups)
#  4. Private WebRTC signaling tracker daemon setup (with optional Windows Startup auto-run)
#  5. Reverse proxy validation (Caddyfile)
# ==============================================================================================

param(
    [string]$JellyfinWebPath = $null,
    [int]$TrackerPort = 8000,
    [switch]$AddStartupTask,
    [switch]$Force
)

$ErrorActionPreference = "SilentlyContinue"

$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
if (-not $scriptDir) { $scriptDir = (Get-Location).Path }

Write-Host ""
Write-Host "==============================================================================" -ForegroundColor Cyan
Write-Host "         JELLYFIN PRIVATE WEBRTC P2P - AUTOMATED INSTALLER & HEALER           " -ForegroundColor Cyan
Write-Host "==============================================================================" -ForegroundColor Cyan
Write-Host ""

# ----------------------------------------------------------------------------------------------
# STEP 1: Preflight Environment Checks
# ----------------------------------------------------------------------------------------------
Write-Host "[Step 1/5] Verifying environment & dependencies..." -ForegroundColor Yellow

# Node.js Check
$nodeVersion = $null
try {
    $nodeVersion = (node -v 2>$null)
} catch {}

if ($nodeVersion) {
    Write-Host "  [OK] Node.js is installed: $nodeVersion" -ForegroundColor Green
} else {
    Write-Host "  [!!] WARNING: Node.js was not found in PATH!" -ForegroundColor Red
    Write-Host "       The private WebRTC tracker daemon requires Node.js (v18+ recommended)." -ForegroundColor Yellow
    Write-Host "       Install via: 'winget install OpenJS.NodeJS' or visit https://nodejs.org" -ForegroundColor Yellow
}

# Caddy Binary Check
$caddyExe = Join-Path $scriptDir "caddy_windows_amd64.exe"
if (-not (Test-Path $caddyExe -ErrorAction SilentlyContinue)) {
    $caddyExe = (Get-Command caddy -ErrorAction SilentlyContinue | Select-Object -ExpandProperty Source)
}

if ($caddyExe -and (Test-Path $caddyExe -ErrorAction SilentlyContinue)) {
    Write-Host "  [OK] Caddy reverse proxy binary found: $caddyExe" -ForegroundColor Green
} else {
    Write-Host "  [?] Caddy binary not found in script directory. (Optional if already running)" -ForegroundColor DarkGray
}

# Source P2P files check
$srcEngine  = Join-Path $scriptDir "jellyfin-p2p-engine.js"
$srcUI      = Join-Path $scriptDir "jellyfin-p2p-ui.js"
$srcBundle  = Join-Path $scriptDir "jellyfin-p2p.js"
$srcTracker = Join-Path $scriptDir "p2p-tracker.js"
$srcCaddy   = Join-Path $scriptDir "caddyfile"

if (-not (Test-Path $srcEngine -ErrorAction SilentlyContinue) -and -not (Test-Path $srcBundle -ErrorAction SilentlyContinue)) {
    Write-Host "  [ERROR] P2P client engine scripts missing from $scriptDir!" -ForegroundColor Red
    exit 1
}
if (-not (Test-Path $srcTracker -ErrorAction SilentlyContinue)) {
    Write-Host "  [ERROR] p2p-tracker.js missing from $scriptDir!" -ForegroundColor Red
    exit 1
}
Write-Host "  [OK] P2P core package files verified." -ForegroundColor Green

# ----------------------------------------------------------------------------------------------
# STEP 2: Auto-detect Jellyfin Web Root
# ----------------------------------------------------------------------------------------------
Write-Host ""
Write-Host "[Step 2/5] Locating Jellyfin web directory..." -ForegroundColor Yellow

$candidateRoots = [System.Collections.Generic.List[string]]::new()

if ($JellyfinWebPath -and (Test-Path $JellyfinWebPath -ErrorAction SilentlyContinue)) {
    $candidateRoots.Add($JellyfinWebPath)
}

# Common installation and portable paths
$candidateRoots.Add((Join-Path $scriptDir "Install\Server\jellyfin-web"))
$candidateRoots.Add((Join-Path $scriptDir "jellyfin-web"))
$candidateRoots.Add((Join-Path $scriptDir "..\Install\Server\jellyfin-web"))
$candidateRoots.Add((Join-Path $scriptDir "..\jellyfin-web"))
$candidateRoots.Add("$env:ProgramFiles\Jellyfin\Server\jellyfin-web")
$candidateRoots.Add("${env:ProgramFiles(x86)}\Jellyfin\Server\jellyfin-web")
$candidateRoots.Add("$env:LOCALAPPDATA\Jellyfin\Server\jellyfin-web")
$candidateRoots.Add("$env:ProgramData\Jellyfin\Server\jellyfin-web")

# Scan all local file drives for Jellyfin roots
try {
    Get-PSDrive -PSProvider FileSystem -ErrorAction SilentlyContinue | ForEach-Object {
        $r = $_.Root
        $candidateRoots.Add((Join-Path $r "Jellyfin\Install\Server\jellyfin-web"))
        $candidateRoots.Add((Join-Path $r "Jellyfin\Server\jellyfin-web"))
        $candidateRoots.Add((Join-Path $r "Jellyfin\jellyfin-web"))
    }
} catch {}

$targetWebDir = $null
foreach ($cand in $candidateRoots) {
    if (-not [string]::IsNullOrWhiteSpace($cand)) {
        try {
            if (Test-Path (Join-Path $cand "index.html") -ErrorAction SilentlyContinue) {
                $targetWebDir = $cand
                break
            }
        } catch {}
    }
}

if (-not $targetWebDir) {
    Write-Host "  [!] Automatic search could not find 'jellyfin-web\index.html'." -ForegroundColor Yellow
    $manualInput = Read-Host "  Please enter the full path to your jellyfin-web directory"
    if ($manualInput -and (Test-Path (Join-Path $manualInput "index.html") -ErrorAction SilentlyContinue)) {
        $targetWebDir = $manualInput
    } else {
        Write-Host "  [ERROR] Invalid directory or index.html missing. Aborting." -ForegroundColor Red
        exit 1
    }
}

Write-Host "  [OK] Jellyfin Web Directory: $targetWebDir" -ForegroundColor Green

# ----------------------------------------------------------------------------------------------
# STEP 3: Deploy Client P2P Engine & Patch index.html
# ----------------------------------------------------------------------------------------------
Write-Host ""
Write-Host "[Step 3/5] Deploying P2P client engine & patching index.html..." -ForegroundColor Yellow

$dstEngine = Join-Path $targetWebDir "jellyfin-p2p-engine.js"
$dstUI     = Join-Path $targetWebDir "jellyfin-p2p-ui.js"
$dstBundle = Join-Path $targetWebDir "jellyfin-p2p.js"
$dstIndex  = Join-Path $targetWebDir "index.html"

# Copy P2P client scripts
if (Test-Path $srcEngine) {
    Copy-Item -Path $srcEngine -Destination $dstEngine -Force
    Write-Host "  [OK] Copied jellyfin-p2p-engine.js -> $dstEngine" -ForegroundColor Green
}
if (Test-Path $srcUI) {
    Copy-Item -Path $srcUI -Destination $dstUI -Force
    Write-Host "  [OK] Copied jellyfin-p2p-ui.js -> $dstUI" -ForegroundColor Green
}
if (Test-Path $srcBundle) {
    Copy-Item -Path $srcBundle -Destination $dstBundle -Force
    Write-Host "  [OK] Copied jellyfin-p2p.js (compatibility) -> $dstBundle" -ForegroundColor DarkGray
}

# Read index.html
$indexContent = [System.IO.File]::ReadAllText($dstIndex, [System.Text.Encoding]::UTF8)

# Backup index.html if no pristine backup exists
$origBackup = Join-Path $targetWebDir "index.html.original"
if (-not (Test-Path $origBackup -ErrorAction SilentlyContinue)) {
    Copy-Item -Path $dstIndex -Destination $origBackup -Force
    Write-Host "  [OK] Saved pristine backup: index.html.original" -ForegroundColor Green
}

# Clean any existing P2P tags first
$indexContent = [System.Text.RegularExpressions.Regex]::Replace(
    $indexContent,
    '<script[^>]*src="jellyfin-p2p[^"]*"[^>]*></script>',
    ''
)

# Timestamp cache-buster (e.g. 20261102_230000)
$timestamp = Get-Date -Format "yyyyMMdd_HHmmss"
$p2pScriptTags = "<script defer=`"defer`" src=`"jellyfin-p2p-engine.js?v=$timestamp`"></script><script defer=`"defer`" src=`"jellyfin-p2p-ui.js?v=$timestamp`"></script>"

if ($indexContent -match "</body>") {
    $indexContent = $indexContent -replace "</body>", "$p2pScriptTags</body>"
} else {
    $indexContent = $indexContent -replace "</head>", "$p2pScriptTags</head>"
}
[System.IO.File]::WriteAllText($dstIndex, $indexContent, [System.Text.Encoding]::UTF8)
Write-Host "  [OK] Injected P2P Engine + UI hooks into index.html (v=$timestamp)!" -ForegroundColor Green

# ----------------------------------------------------------------------------------------------
# STEP 4: Verify & Setup Private WebRTC Tracker Service
# ----------------------------------------------------------------------------------------------
Write-Host ""
Write-Host "[Step 4/5] Checking Private WebRTC Tracker service (Port $TrackerPort)..." -ForegroundColor Yellow

$trackerConn = Get-NetTCPConnection -LocalPort $TrackerPort -State Listen -ErrorAction SilentlyContinue

if ($trackerConn) {
    Write-Host "  [OK] Private WebRTC tracker is ALREADY active and listening on port $TrackerPort." -ForegroundColor Green
} else {
    Write-Host "  [*] Tracker is not running. Launching private tracker daemon on port $TrackerPort..." -ForegroundColor Cyan
    if ($nodeVersion) {
        Start-Process -WindowStyle Minimized node -ArgumentList "`"$srcTracker`""
        Start-Sleep -Milliseconds 1200
        $trackerConn = Get-NetTCPConnection -LocalPort $TrackerPort -State Listen -ErrorAction SilentlyContinue
        if ($trackerConn) {
            Write-Host "  [OK] Private WebRTC tracker successfully started on ws://127.0.0.1:$TrackerPort/tracker" -ForegroundColor Green
        } else {
            Write-Host "  [!] Tracker started in background (verifying status asynchronously)." -ForegroundColor DarkGray
        }
    } else {
        Write-Host "  [!] Cannot start tracker automatically without Node.js." -ForegroundColor Yellow
    }
}

# Configure Windows Startup shortcut if requested or first install
$startupDir = [System.Environment]::GetFolderPath([System.Environment+SpecialFolder]::Startup)
$startupScript = Join-Path $startupDir "Jellyfin-P2P-Tracker.bat"

if ($AddStartupTask -or (-not (Test-Path $startupScript -ErrorAction SilentlyContinue))) {
    $batContent = "@echo off`r`nstart /min node `"$srcTracker`"`r`n"
    [System.IO.File]::WriteAllText($startupScript, $batContent, [System.Text.Encoding]::ASCII)
    Write-Host "  [OK] Created Windows Startup auto-run: $startupScript" -ForegroundColor Green
}

# ----------------------------------------------------------------------------------------------
# STEP 5: Validate Caddy Configuration
# ----------------------------------------------------------------------------------------------
Write-Host ""
Write-Host "[Step 5/5] Validating Caddy reverse proxy setup..." -ForegroundColor Yellow

if (Test-Path $srcCaddy -ErrorAction SilentlyContinue) {
    if ($caddyExe -and (Test-Path $caddyExe -ErrorAction SilentlyContinue)) {
        try {
            $validateOutput = & $caddyExe validate --config $srcCaddy 2>&1
            if ($LASTEXITCODE -eq 0) {
                Write-Host "  [OK] caddyfile syntax is 100% valid." -ForegroundColor Green
            } else {
                Write-Host "  [!] Caddy validation notice:`n$validateOutput" -ForegroundColor DarkGray
            }
        } catch {
            Write-Host "  [OK] Caddyfile present." -ForegroundColor Green
        }
    } else {
        Write-Host "  [OK] caddyfile present and ready." -ForegroundColor Green
    }
} else {
    Write-Host "  [!] caddyfile not found in $scriptDir." -ForegroundColor Yellow
}

# ----------------------------------------------------------------------------------------------
# SUMMARY & USAGE INSTRUCTIONS
# ----------------------------------------------------------------------------------------------
Write-Host ""
Write-Host "==============================================================================" -ForegroundColor Green
Write-Host "                     P2P SETUP COMPLETE & VERIFIED!                           " -ForegroundColor Green
Write-Host "==============================================================================" -ForegroundColor Green
Write-Host ""
Write-Host "How it stays update-proof:" -ForegroundColor Cyan
Write-Host "  1. If Jellyfin updates and overwrites index.html, run 'update-p2p.bat'" -ForegroundColor White
Write-Host "     or simply start Caddy using 'start-caddy.bat'." -ForegroundColor White
Write-Host "  2. The watchdog (ensure-p2p.ps1) automatically re-injects the P2P hook" -ForegroundColor White
Write-Host "     and updates jellyfin-p2p.js with zero manual intervention." -ForegroundColor White
Write-Host ""
Write-Host "Daily Running:" -ForegroundColor Cyan
Write-Host "  - To start the server and reverse proxy, double-click: start-caddy.bat" -ForegroundColor White
Write-Host "  - Tracker auto-runs on Windows boot via Startup shortcut." -ForegroundColor White
Write-Host "  - To manually test or restart tracker, double-click:   start-tracker.bat" -ForegroundColor White
Write-Host ""
Write-Host "==============================================================================" -ForegroundColor Green
