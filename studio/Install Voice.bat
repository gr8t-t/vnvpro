@echo off
REM vnvpro Studio — installs a new voice the admin sent you. Double-click me.
start "" powershell -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File "%~dp0install-voice.ps1"
