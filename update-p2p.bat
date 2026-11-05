@echo off
cd /d "%~dp0"
title Jellyfin P2P Plugin - Fast Update / Self-Heal

echo =========================================================================
echo  Jellyfin Private WebRTC P2P Plugin - Fast Update / Self-Heal
echo =========================================================================
echo.

powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0ensure-p2p.ps1"

echo.
echo Verification & self-healing complete!
echo.
pause
