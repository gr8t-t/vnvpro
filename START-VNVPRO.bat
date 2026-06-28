@echo off
title VNV Pro Launcher
echo ============================================================
echo   VNV Pro - One-Click Launcher
echo ============================================================
echo.
echo This starts all THREE servers (Voice 1.0, Voice 2.0, ngrok)
echo AND points your website at your permanent address - no pasting.
echo.
echo THREE windows will open and must STAY OPEN while users are
echo online: "Voice 1.0", "Voice 2.0", and "ngrok". Close them to
echo take voice offline.
echo ============================================================
echo.

powershell -NoProfile -ExecutionPolicy Bypass -File "C:\Users\USER\Desktop\vnvpro\launch.ps1"
