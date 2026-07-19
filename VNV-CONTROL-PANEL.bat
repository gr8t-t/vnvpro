@echo off
rem VNV Control Panel - one window, no cmd windows.
rem Servers run hidden; logs are in Desktop\vnvpro\logs\.
start "" powershell -STA -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File "C:\Users\USER\Desktop\vnvpro\control-panel.ps1"
