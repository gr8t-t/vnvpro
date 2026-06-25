@echo off
title VNV Pro Launcher
echo ============================================================
echo   VNV Pro - One-Click Launcher
echo ============================================================
echo.
echo This starts the Voice Server + ngrok AND automatically
echo updates your website with the new address - no pasting.
echo.
echo Two windows will open and must STAY OPEN while users are
echo online: "Voice Server" and "ngrok". Close them to take
echo voice offline.
echo ============================================================
echo.

powershell -NoProfile -ExecutionPolicy Bypass -File "C:\Users\USER\Desktop\vnvpro\launch.ps1"
