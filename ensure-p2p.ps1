# =========================================================================
# Jellyfin Private WebRTC P2P Self-Healing Update Watchdog
# Automatically checks, updates, and re-injects P2P hooks after Jellyfin updates
# =========================================================================

param(
    [string]$JellyfinWebPath = $null
)

$ErrorActionPreference = "SilentlyContinue"

$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
if (-not $scriptDir) { $scriptDir = (Get-Location).Path }

Write-Host "=========================================================" -ForegroundColor Cyan
Write-Host "  Jellyfin Private WebRTC P2P Self-Healing Watchdog      " -ForegroundColor Cyan
Write-Host "=========================================================" -ForegroundColor Cyan

# 1. Candidate Jellyfin installation roots (handles portable, custom, and standard installs)
$candidateRoots = [System.Collections.Generic.List[string]]::new()

if ($JellyfinWebPath -and (Test-Path $JellyfinWebPath -ErrorAction SilentlyContinue)) {
    $candidateRoots.Add($JellyfinWebPath)
}

# Local relative candidates
$candidateRoots.Add((Join-Path $scriptDir "jellyfin-web"))
$candidateRoots.Add((Join-Path $scriptDir "Install\Server\jellyfin-web"))
$candidateRoots.Add((Join-Path $scriptDir "..\Install\Server\jellyfin-web"))
$candidateRoots.Add((Join-Path $scriptDir "..\jellyfin-web"))

# Standard install candidates
$candidateRoots.Add("$env:ProgramFiles\Jellyfin\Server\jellyfin-web")
$candidateRoots.Add("${env:ProgramFiles(x86)}\Jellyfin\Server\jellyfin-web")
$candidateRoots.Add("$env:LOCALAPPDATA\Jellyfin\Server\jellyfin-web")
$candidateRoots.Add("$env:ProgramData\Jellyfin\Server\jellyfin-web")

# Drive-root candidates across all mounted drives (e.g. C:\Jellyfin, D:\Jellyfin)
try {
    Get-PSDrive -PSProvider FileSystem -ErrorAction SilentlyContinue | ForEach-Object {
        $root = $_.Root
        $candidateRoots.Add((Join-Path $root "Jellyfin\Install\Server\jellyfin-web"))
        $candidateRoots.Add((Join-Path $root "Jellyfin\Server\jellyfin-web"))
        $candidateRoots.Add((Join-Path $root "Jellyfin\jellyfin-web"))
    }
} catch {}

$targetWebDir = $null
foreach ($c in $candidateRoots) {
    if (-not [string]::IsNullOrWhiteSpace($c)) {
        try {
            if (Test-Path (Join-Path $c "index.html") -ErrorAction SilentlyContinue) {
                $targetWebDir = $c
                break
            }
        } catch {}
    }
}

if (-not $targetWebDir) {
    Write-Host "[P2P-Watchdog] WARNING: Could not automatically find jellyfin-web directory." -ForegroundColor Yellow
    Write-Host "[P2P-Watchdog] Please ensure Jellyfin is installed or specify the directory." -ForegroundColor Yellow
} else {
    Write-Host "[P2P-Watchdog] Detected Jellyfin Web Root: $targetWebDir" -ForegroundColor Green
    
    $targetIndex = Join-Path $targetWebDir "index.html"

    # Step 1: Sync client scripts to jellyfin-web
    $filesToSync = @("jellyfin-p2p-engine.js", "jellyfin-p2p-ui.js", "jellyfin-p2p.js")
    $anyUpdated = $false
    foreach ($fname in $filesToSync) {
        $sourceScript = Join-Path $scriptDir $fname
        $targetScript = Join-Path $targetWebDir $fname
        if (Test-Path $sourceScript -ErrorAction SilentlyContinue) {
            $shouldCopy = $false
            if (-not (Test-Path $targetScript -ErrorAction SilentlyContinue)) {
                $shouldCopy = $true
            } else {
                $srcHash = (Get-FileHash $sourceScript).Hash
                $dstHash = (Get-FileHash $targetScript).Hash
                if ($srcHash -ne $dstHash) { $shouldCopy = $true }
            }
            if ($shouldCopy) {
                Copy-Item -Path $sourceScript -Destination $targetScript -Force
                $anyUpdated = $true
                Write-Host "[P2P-Watchdog] Updated $fname in web folder (OK)." -ForegroundColor Green
            } else {
                Write-Host "[P2P-Watchdog] $fname is up to date (OK)." -ForegroundColor DarkGray
            }
        }
    }

    # Step 2: Auto-heal or refresh cache-buster in index.html
    if (Test-Path $targetIndex -ErrorAction SilentlyContinue) {
        $htmlContent = [System.IO.File]::ReadAllText($targetIndex, [System.Text.Encoding]::UTF8)
        $hasEngine = $htmlContent -match "jellyfin-p2p-engine\.js"
        $hasUI     = $htmlContent -match "jellyfin-p2p-ui\.js"
        $hasLegacy = $htmlContent -match '<script[^>]*src="jellyfin-p2p\.js[^"]*"[^>]*></script>'

        if ($anyUpdated -or -not $hasEngine -or -not $hasUI -or $hasLegacy) {
            Write-Host "[P2P-Watchdog] Index hook update or cache-bust required! Re-injecting clean P2P scripts into index.html..." -ForegroundColor Yellow
            
            # Backup original index.html before modifying
            $backupPath = Join-Path $targetWebDir "index.html.original"
            if (-not (Test-Path $backupPath -ErrorAction SilentlyContinue)) {
                Copy-Item -Path $targetIndex -Destination $backupPath -Force
                Write-Host "[P2P-Watchdog] Created backup: index.html.original" -ForegroundColor DarkGray
            }

            # Strip all legacy or prior jellyfin-p2p script tags
            $cleanHtml = [System.Text.RegularExpressions.Regex]::Replace(
                $htmlContent,
                '<script[^>]*src="jellyfin-p2p[^"]*"[^>]*></script>',
                ''
            )

            $ts = Get-Date -Format "yyyyMMdd_HHmmss"
            $tag = "<script defer=`"defer`" src=`"jellyfin-p2p-engine.js?v=$ts`"></script><script defer=`"defer`" src=`"jellyfin-p2p-ui.js?v=$ts`"></script>"
            if ($cleanHtml -match "</body>") {
                $newContent = $cleanHtml -replace "</body>", "$tag</body>"
            } else {
                $newContent = $cleanHtml -replace "</head>", "$tag</head>"
            }
            [System.IO.File]::WriteAllText($targetIndex, $newContent, [System.Text.Encoding]::UTF8)
            Write-Host "[P2P-Watchdog] Successfully restored P2P Engine + UI hooks in index.html (v=$ts)!" -ForegroundColor Green
        } else {
            Write-Host "[P2P-Watchdog] index.html hook verified (OK)." -ForegroundColor DarkGray
        }
    }
}

# 3. Ensure Private WebRTC Tracker daemon on port 8000 is active
$trackerScript = Join-Path $scriptDir "p2p-tracker.js"

$trackerListening = Get-NetTCPConnection -LocalPort 8000 -State Listen -ErrorAction SilentlyContinue
if (-not $trackerListening) {
    Write-Host "[P2P-Watchdog] Starting private WebRTC tracker service on port 8000..." -ForegroundColor Cyan
    if (Test-Path $trackerScript -ErrorAction SilentlyContinue) {
        Start-Process node -ArgumentList "`"$trackerScript`"" -WorkingDirectory (Split-Path $trackerScript) -WindowStyle Minimized
        Start-Sleep -Milliseconds 800
        $checkAgain = Get-NetTCPConnection -LocalPort 8000 -State Listen -ErrorAction SilentlyContinue
        if ($checkAgain) {
            Write-Host "[P2P-Watchdog] Private WebRTC tracker is now listening on ws://127.0.0.1:8000/tracker (OK)." -ForegroundColor Green
        } else {
            Write-Host "[P2P-Watchdog] Tracker launched in background." -ForegroundColor DarkGray
        }
    } else {
        Write-Host "[P2P-Watchdog] Could not find p2p-tracker.js!" -ForegroundColor Red
    }
} else {
    Write-Host "[P2P-Watchdog] Private WebRTC tracker is listening on port 8000 (OK)." -ForegroundColor DarkGray
}

# 4. Ensure Live Mesh Monitor daemon on port 8001 is active
$monitorScript = Join-Path $scriptDir "p2p-monitor.js"

$monitorListening = Get-NetTCPConnection -LocalPort 8001 -State Listen -ErrorAction SilentlyContinue
if (-not $monitorListening) {
    Write-Host "[P2P-Watchdog] Starting live mesh monitor service on port 8001..." -ForegroundColor Cyan
    if (Test-Path $monitorScript -ErrorAction SilentlyContinue) {
        Start-Process node -ArgumentList "`"$monitorScript`"" -WorkingDirectory (Split-Path $monitorScript) -WindowStyle Minimized
        Start-Sleep -Milliseconds 800
        $checkAgain = Get-NetTCPConnection -LocalPort 8001 -State Listen -ErrorAction SilentlyContinue
        if ($checkAgain) {
            Write-Host "[P2P-Watchdog] Live mesh monitor is now listening on http://127.0.0.1:8001/ (OK)." -ForegroundColor Green
        } else {
            Write-Host "[P2P-Watchdog] Monitor launched in background." -ForegroundColor DarkGray
        }
    } else {
        Write-Host "[P2P-Watchdog] Could not find p2p-monitor.js!" -ForegroundColor Red
    }
} else {
    Write-Host "[P2P-Watchdog] Live mesh monitor is listening on http://127.0.0.1:8001/ (OK)." -ForegroundColor DarkGray
}

Write-Host "=========================================================" -ForegroundColor Cyan
