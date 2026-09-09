# vnvpro Studio (client side) - install a new voice the admin sent you.
# Finds voice-slot-*.zip in this folder, the Desktop, or Downloads, drops each
# voice into the local engine, and refreshes it. Safe to run anytime.
$ErrorActionPreference = 'Continue'
$root     = $PSScriptRoot
$wokDir   = Join-Path $root 'wokada'
$modelDir = Join-Path $wokDir 'model_dir'
$launch   = Join-Path $root 'studio-launch.ps1'
Add-Type -AssemblyName System.IO.Compression.FileSystem
Add-Type -AssemblyName System.Windows.Forms

function Msg($text, $icon) {
  [System.Windows.Forms.MessageBox]::Show($text, 'vnvpro Voice', 'OK', $icon) | Out-Null
}

# look where people usually save a download
$desktop   = [Environment]::GetFolderPath('Desktop')
$downloads = Join-Path $env:USERPROFILE 'Downloads'
$zips = @()
foreach ($d in @($root, $desktop, $downloads)) {
  if ($d -and (Test-Path $d)) {
    $zips += Get-ChildItem $d -Filter 'voice-slot-*.zip' -File -ErrorAction SilentlyContinue
  }
}
$zips = $zips | Sort-Object FullName -Unique

if (-not $zips -or $zips.Count -eq 0) {
  Msg("No new voice file found.`n`nSave the voice-slot-....zip I sent you to your Desktop or Downloads folder, then run this again.", 'Information')
  return
}

New-Item -ItemType Directory -Force -Path $modelDir | Out-Null
$installed = @()
foreach ($z in $zips) {
  try {
    $tmp = Join-Path $env:TEMP ('vinst_' + [Guid]::NewGuid().ToString('N'))
    New-Item -ItemType Directory -Force -Path $tmp | Out-Null
    [System.IO.Compression.ZipFile]::ExtractToDirectory($z.FullName, $tmp)
    # each zip's root is a slot folder (e.g. "12\voice.pth") -> copy into model_dir
    Get-ChildItem $tmp -Directory | ForEach-Object {
      $dest = Join-Path $modelDir $_.Name
      if (Test-Path $dest) { Remove-Item $dest -Recurse -Force -ErrorAction SilentlyContinue }
      Copy-Item $_.FullName $dest -Recurse -Force
      $installed += $_.Name
    }
    Remove-Item $tmp -Recurse -Force -ErrorAction SilentlyContinue
  } catch {
    Msg("Could not open $($z.Name).`n$($_.Exception.Message)", 'Warning')
  }
}

if ($installed.Count -eq 0) { Msg('No voice could be installed. Please re-download the file and try again.', 'Warning'); return }

# refresh the engine only if it is currently ON, so the new voice loads
$wasRunning = [bool](Get-NetTCPConnection -LocalPort 8765 -State Listen -ErrorAction SilentlyContinue)
if ($wasRunning -and (Test-Path $launch)) {
  & powershell -NoProfile -ExecutionPolicy Bypass -File $launch -Action stop  | Out-Null
  Start-Sleep -Milliseconds 800
  & powershell -NoProfile -ExecutionPolicy Bypass -File $launch -Action start | Out-Null
}

$list = ($installed | Sort-Object -Unique) -join ', '
if ($wasRunning) {
  Msg("New voice installed and ready.`n`nYour voice app was refreshed - pick the new voice in vnvpro.", 'Information')
} else {
  Msg("New voice installed.`n`nTurn your voice app ON (the vnvpro Voice button), then pick the new voice in vnvpro.", 'Information')
}
