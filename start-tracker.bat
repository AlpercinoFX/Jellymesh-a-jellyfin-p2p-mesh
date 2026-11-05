@echo off
cd /d "%~dp0"
title Jellyfin Private WebRTC Tracker

echo =========================================================================
echo  Jellyfin Private WebRTC Tracker Daemon (Port 8000)
echo =========================================================================
echo.

node "%~dp0p2p-tracker.js"
if %errorlevel% neq 0 (
    echo.
    echo [ERROR] Tracker failed to start or exited with an error.
    echo Make sure Node.js is installed (node -v).
    echo.
    pause
)
