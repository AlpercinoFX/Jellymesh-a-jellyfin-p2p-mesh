@echo off
cd /d "%~dp0"
title Jellyfin P2P Live Mesh Monitor

echo =========================================================================
echo  Jellyfin P2P Live Mesh Monitor (localhost only)  http://127.0.0.1:8001/
echo =========================================================================
echo.

node "%~dp0p2p-monitor.js"
if %errorlevel% neq 0 (
    echo.
    echo [ERROR] Monitor failed to start or exited with an error.
    echo Make sure Node.js is installed (node -v) and port 8001 is free.
    echo.
    pause
)
