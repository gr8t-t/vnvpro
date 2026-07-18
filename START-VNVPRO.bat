@echo off
title VNV Pro Launcher
echo ============================================================
echo   VNV Pro - One-Click Launcher
echo ============================================================
echo.
echo This starts all FOUR servers (Voice 1.0, Voice 2.0, Voice
echo Clone, Cloudflare Tunnel) AND auto-points your website at it
echo address - no pasting.
echo.
echo FOUR windows will open and must STAY OPEN while users are
echo online: "Voice 1.0", "Voice 2.0", "Voice Clone", and "Cloudflare Tunnel".
echo Close them to take voice offline.
echo ============================================================
echo.

powershell -NoProfile -ExecutionPolicy Bypass -File "C:\Users\USER\Desktop\vnvpro\launch.ps1"
