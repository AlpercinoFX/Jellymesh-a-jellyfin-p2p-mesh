@echo off
cd /d "%~dp0"
title Jellyfin P2P Caddy Server

echo ===================================================
echo  Jellyfin Private WebRTC P2P + Caddy Server
echo ===================================================

powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0ensure-p2p.ps1"

echo [Caddy] Starting reverse proxy...
caddy_windows_amd64.exe run
if %errorlevel% neq 0 (
    echo.
    echo [ERROR] Caddy stopped with exit code %errorlevel%.
    pause
)
