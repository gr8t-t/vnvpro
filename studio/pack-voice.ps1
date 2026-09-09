# vnvpro Studio — package ONE trained voice to send to an already-installed client.
# Usage:  right-click > Run with PowerShell, or:
#         powershell -ExecutionPolicy Bypass -File pack-voice.ps1 -Slot 12
# Produces Desktop\voice-slot-<N>.zip (small — one voice). Send it to the client;
# they double-click "Install Voice" and it drops in. No need to resend the big file.
param(
  [Parameter(Mandatory = $true)][int]$Slot,
  [string]$WokadaDir = 'C:\Users\USER\Downloads\vcclient_win_cuda_2.0.78-beta\dist\main'
)
$ErrorActionPreference = 'Stop'
$desktop = [Environment]::GetFolderPath('Desktop')
$src = Join-Path $WokadaDir "model_dir\$Slot"
if (-not (Test-Path $src)) { Write-Host "MISSING voice slot $Slot -> $src" -ForegroundColor Red; exit 1 }

# stage the slot as a top-level folder "<N>\..." so it extracts straight into model_dir
$stageRoot = Join-Path $env:TEMP ('vpack_' + [Guid]::NewGuid().ToString('N'))
$stageSlot = Join-Path $stageRoot "$Slot"
New-Item -ItemType Directory -Force -Path $stageSlot | Out-Null
Get-ChildItem $src -File | Where-Object { $_.Name -notlike '*.bak' } | ForEach-Object {
  Copy-Item $_.FullName (Join-Path $stageSlot $_.Name) -Force
}

$zip = Join-Path $desktop "voice-slot-$Slot.zip"
if (Test-Path $zip) { Remove-Item $zip -Force }
Add-Type -AssemblyName System.IO.Compression.FileSystem
[System.IO.Compression.ZipFile]::CreateFromDirectory($stageRoot, $zip, [System.IO.Compression.CompressionLevel]::Optimal, $false)
Remove-Item $stageRoot -Recurse -Force -ErrorAction SilentlyContinue

$mb = [math]::Round((Get-Item $zip).Length / 1MB, 1)
Write-Host "Done -> $zip  ($mb MB)" -ForegroundColor Green
Write-Host "Send this file to the client, then tell them to run 'Install Voice'." -ForegroundColor Cyan
