# vnvpro Studio — local voice engine control.
#   -Action start | stop | toggle | status  → scriptable core (no window)
#   -Action gui (default)                    → the single on/off toggle window
# Starts w-okada (:18000) + the Studio proxy (:8765) on THIS machine. No tunnel:
# the vnvpro browser talks straight to http://localhost:8765.
param([string]$Action = 'gui')
$ErrorActionPreference = 'Continue'
$root     = $PSScriptRoot
$wokDir   = Join-Path $root 'wokada'
$wokExe   = Join-Path $wokDir 'main.exe'
$proxyExe = Join-Path $root 'studio-proxy.exe'
$logDir   = Join-Path $root 'logs'
New-Item -ItemType Directory -Force -Path $logDir | Out-Null
$wokLog   = Join-Path $logDir 'wokada.log'
$proxyLog = Join-Path $logDir 'proxy.log'

function Test-VoiceRunning {
  # ON = the proxy is listening on 8765
  [bool](Get-NetTCPConnection -LocalPort 8765 -State Listen -ErrorAction SilentlyContinue)
}

function Start-Voice {
  if (-not (Get-Process main -ErrorAction SilentlyContinue | Where-Object { $_.Path -eq $wokExe })) {
    if (Test-Path $wokExe) {
      Start-Process -WindowStyle Hidden -FilePath cmd -ArgumentList '/c', "cd /d `"$wokDir`" && `"$wokExe`" cui --https false --no_cui True > `"$wokLog`" 2>&1"
    }
  }
  if (-not (Get-Process studio-proxy -ErrorAction SilentlyContinue)) {
    if (Test-Path $proxyExe) {
      # cd /d prefix so cmd doesn't strip the quotes off a leading quoted path
      Start-Process -WindowStyle Hidden -FilePath cmd -ArgumentList '/c', "cd /d `"$root`" && `"$proxyExe`" 8765 > `"$proxyLog`" 2>&1"
    }
  }
}

function Stop-Voice {
  Get-Process studio-proxy -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue
  # w-okada = main.exe + its voice-changer-native-client.exe workers; only ours (this folder)
  Get-Process main,voice-changer-native-client -ErrorAction SilentlyContinue |
    Where-Object { $_.Path -like ($wokDir + '*') } | Stop-Process -Force -ErrorAction SilentlyContinue
}

switch ($Action.ToLower()) {
  'start'  { Start-Voice;  Write-Output 'started';  return }
  'stop'   { Stop-Voice;   Write-Output 'stopped';  return }
  'status' { Write-Output ($(if (Test-VoiceRunning) { 'ON' } else { 'OFF' })); return }
  'toggle' { if (Test-VoiceRunning) { Stop-Voice; Write-Output 'OFF' } else { Start-Voice; Write-Output 'ON' }; return }
}

# ── GUI: one big toggle ───────────────────────────────────────────────────────
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing

$form = New-Object System.Windows.Forms.Form
$form.Text = 'vnvpro Voice'
$form.Size = New-Object System.Drawing.Size(360, 230)
$form.StartPosition = 'CenterScreen'
$form.FormBorderStyle = 'FixedSingle'
$form.MaximizeBox = $false
$form.BackColor = [System.Drawing.Color]::FromArgb(14, 24, 38)

$lbl = New-Object System.Windows.Forms.Label
$lbl.AutoSize = $false
$lbl.Size = New-Object System.Drawing.Size(320, 30)
$lbl.Location = New-Object System.Drawing.Point(20, 20)
$lbl.TextAlign = 'MiddleCenter'
$lbl.ForeColor = [System.Drawing.Color]::FromArgb(157, 176, 189)
$lbl.Text = 'Turn your voice engine on before using vnvpro.'
$form.Controls.Add($lbl)

$btn = New-Object System.Windows.Forms.Button
$btn.Size = New-Object System.Drawing.Size(280, 90)
$btn.Location = New-Object System.Drawing.Point(40, 70)
$btn.FlatStyle = 'Flat'
$btn.Font = New-Object System.Drawing.Font('Segoe UI', 18, [System.Drawing.FontStyle]::Bold)
$btn.ForeColor = [System.Drawing.Color]::White
$form.Controls.Add($btn)

$refresh = {
  if (Test-VoiceRunning) {
    $btn.Text = "VOICE IS ON`r`n(click to turn off)"
    $btn.BackColor = [System.Drawing.Color]::FromArgb(22, 163, 74)
  } else {
    $btn.Text = "VOICE IS OFF`r`n(click to turn on)"
    $btn.BackColor = [System.Drawing.Color]::FromArgb(71, 85, 105)
  }
}

$btn.Add_Click({
  $btn.Enabled = $false
  if (Test-VoiceRunning) { Stop-Voice } else { Start-Voice }
  Start-Sleep -Milliseconds 800
  & $refresh
  $btn.Enabled = $true
})

& $refresh
[void]$form.ShowDialog()
