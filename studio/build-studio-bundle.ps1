# Assembles the vnvpro Studio bundle: a self-contained folder the user unzips and
# runs on their OWN machine. w-okada + ALL voices + local proxy + one on/off toggle.
# No tunnel, no cloudflared, no config — the vnvpro browser reaches it at localhost.
param(
  [string]$WokadaDir = 'C:\Users\USER\Downloads\vcclient_win_cuda_2.0.78-beta\dist\main',
  [int[]] $Slots     = @(5, 6, 7, 8, 9, 10, 11)   # all vnvpro voices
)
$ErrorActionPreference = 'Stop'
$root    = $PSScriptRoot
$desktop = [Environment]::GetFolderPath('Desktop')
$stage   = Join-Path $desktop 'vnvpro-studio-dist\vnvpro-studio'
$zip     = Join-Path $desktop 'vnvpro-studio.zip'

function Need($p, $w) { if (-not (Test-Path $p)) { Write-Host "MISSING: $w -> $p" -ForegroundColor Red; exit 1 } }
Need (Join-Path $root 'studio-proxy.exe')  'studio-proxy.exe (run the freeze first)'
Need (Join-Path $root 'studio-launch.ps1') 'studio-launch.ps1'
Need (Join-Path $root 'vnvpro Voice.bat')  'vnvpro Voice.bat'
Need (Join-Path $WokadaDir 'main.exe')     'w-okada main.exe'
foreach ($s in $Slots) { Need (Join-Path $WokadaDir "model_dir\$s") "voice slot $s" }

if (Test-Path (Join-Path $desktop 'vnvpro-studio-dist')) { Remove-Item (Join-Path $desktop 'vnvpro-studio-dist') -Recurse -Force }
New-Item -ItemType Directory -Force -Path $stage | Out-Null

Write-Host 'Copying voice engine (w-okada)...' -ForegroundColor Cyan
$wokStage = Join-Path $stage 'wokada'
robocopy $WokadaDir $wokStage /E /R:1 /W:1 /NFL /NDL /NJH /NJS /NP /XF 'vcclient.log' `
  /XD (Join-Path $WokadaDir 'model_dir') (Join-Path $WokadaDir 'tmp_dir') (Join-Path $WokadaDir 'upload_dir') | Out-Null
foreach ($s in $Slots) {
  $src = Join-Path $WokadaDir "model_dir\$s"; $dst = Join-Path $wokStage "model_dir\$s"
  New-Item -ItemType Directory -Force -Path $dst | Out-Null
  Get-ChildItem $src -File | Where-Object { $_.Name -notlike '*.bak' } | ForEach-Object {
    Copy-Item $_.FullName (Join-Path $dst $_.Name) -Force
  }
}
# purge logs so a locked log can't abort the zip
Get-ChildItem $wokStage -Recurse -Filter *.log -ErrorAction SilentlyContinue | Remove-Item -Force -ErrorAction SilentlyContinue

Write-Host 'Copying proxy, launcher, toggle...' -ForegroundColor Cyan
Copy-Item (Join-Path $root 'studio-proxy.exe')  $stage -Force
Copy-Item (Join-Path $root 'studio-launch.ps1') $stage -Force
Copy-Item (Join-Path $root 'vnvpro Voice.bat')  $stage -Force
Copy-Item (Join-Path $root 'proxy.py')          $stage -Force   # fallback source if the exe is ever blocked

Write-Host 'Zipping (contents at root -> one clean folder on Extract All)...' -ForegroundColor Cyan
if (Test-Path $zip) { Remove-Item $zip -Force }
Add-Type -AssemblyName System.IO.Compression.FileSystem
[System.IO.Compression.ZipFile]::CreateFromDirectory($stage, $zip, [System.IO.Compression.CompressionLevel]::Optimal, $false)
Write-Host ("Done -> $zip  " + [math]::Round((Get-Item $zip).Length / 1GB, 2) + ' GB') -ForegroundColor Green
