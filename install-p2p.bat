@echo off
cd /d "%~dp0"
title Jellyfin P2P Plugin - Automated Setup & Healer

echo =========================================================================
echo  Jellyfin Private WebRTC P2P Plugin - 1-Click Installer
echo =========================================================================
echo.

powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0install-p2p.ps1"

echo.
pause
