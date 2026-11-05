@echo off
cd /d "%~dp0"
title Jellyfin Private P2P Full Stack (Caddy + Tracker + Monitor)

echo =========================================================================
echo  Jellyfin Private P2P Full Stack Launcher
echo  - Caddy Reverse Proxy:     (configured domain in caddyfile)
echo  - WebRTC Tracker Service:  ws://127.0.0.1:8000/tracker
echo  - Live Mesh Web Monitor:   http://127.0.0.1:8001/
echo =========================================================================
echo.

powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0ensure-p2p.ps1"

echo.
echo [Caddy] Starting reverse proxy...
caddy_windows_amd64.exe run
if %errorlevel% neq 0 (
    echo.
    echo [ERROR] Caddy stopped with exit code %errorlevel%.
    pause
)
