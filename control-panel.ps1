# ============================================================
#  VNV CONTROL PANEL
#  One small window that replaces the four cmd windows.
#   - Servers run HIDDEN in the background (output goes to
#     log files in vnvpro\logs\ instead of windows)
#   - Green / orange / red light per server + Start/Stop toggle
#   - START ALL / STOP ALL (same logic as the old launcher)
#   - Tunnel URL shown, Copy button, auto-pushed to the website
#   - View Log button per server (reads even while locked)
#  Double-click VNV-CONTROL-PANEL.bat to open this panel.
#  Closing the panel does NOT stop the servers.
# ============================================================

Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
[System.Windows.Forms.Application]::EnableVisualStyles()

# ---- CONFIG (same as launch.ps1) ----------------------------
$script:RvcDir         = 'C:\Users\USER\Desktop\vnvpro\rvc-server'
$script:WokadaDir      = 'C:\Users\USER\Downloads\vcclient_win_cuda_2.0.78-beta\dist\main'
$script:CloneDir       = 'C:\Users\USER\seed-vc'
$script:AdminApi       = 'https://vnvpro.vercel.app/api/admin'
$script:AdminPassword  = '09130370801Maviegr8@'
$script:CloudflaredExe = 'C:\Users\USER\cloudflared\cloudflared.exe'
$script:RvcPort        = 8765
$script:LogDir         = 'C:\Users\USER\Desktop\vnvpro\logs'
if (-not (Test-Path $script:LogDir)) { New-Item -ItemType Directory -Path $script:LogDir -Force | Out-Null }

$script:tunnelUrl    = $null
$script:awaitingUrl  = $false
$script:urlWaitTicks = 0

# Order matters for START ALL: heavy servers first, tunnel last.
$script:servers = @(
  @{ Key='wokada'; Name='Voice 2.0 (w-okada)';   Port=18000;           Log=(Join-Path $script:LogDir 'voice2-wokada.log') },
  @{ Key='clone';  Name='Voice Clone (Seed-VC)'; Port=18100;           Log=(Join-Path $script:LogDir 'voiceclone-seedvc.log') },
  @{ Key='rvc';    Name='Voice 1.0 (RVC)';       Port=$script:RvcPort; Log=(Join-Path $script:LogDir 'voice1-rvc.log') },
  @{ Key='tunnel'; Name='Cloudflare Tunnel';     Port=0;               Log=(Join-Path $script:LogDir 'cloudflared.log') }
)

function Get-VnvServer([string]$key) {
  foreach ($s in $script:servers) { if ($s.Key -eq $key) { return $s } }
  return $null
}

# ---- server control ------------------------------------------------------

function Start-VnvServer([string]$key) {
  $s = Get-VnvServer $key
  if ($key -eq 'tunnel') {
    Remove-Item $s.Log -Force -ErrorAction SilentlyContinue
    $script:tunnelUrl = $null
    # http2 + IPv4: avoids the Windows QUIC UDP-buffer wedge and flaky IPv6 (2026-07-18 incident)
    Start-Process -WindowStyle Hidden -FilePath $script:CloudflaredExe -ArgumentList `
      'tunnel', '--url', "http://127.0.0.1:$($script:RvcPort)", '--protocol', 'http2', '--edge-ip-version', '4', '--logfile', $s.Log
    $script:awaitingUrl = $true
    $script:urlWaitTicks = 0
    return
  }
  if ($key -eq 'wokada') {
    if (-not (Test-Path (Join-Path $script:WokadaDir 'main.exe'))) { return }
    Start-Process -WindowStyle Hidden -FilePath cmd -ArgumentList '/c', "cd /d $($script:WokadaDir) && main.exe cui --https false --no_cui True > $($s.Log) 2>&1"
    return
  }
  if ($key -eq 'clone') {
    if (-not (Test-Path (Join-Path $script:CloneDir 'clone_server.py'))) { return }
    Start-Process -WindowStyle Hidden -FilePath cmd -ArgumentList '/c', "cd /d $($script:CloneDir) && venv\Scripts\python.exe clone_server.py > $($s.Log) 2>&1"
    return
  }
  if ($key -eq 'rvc') {
    Start-Process -WindowStyle Hidden -FilePath cmd -ArgumentList '/c', "cd /d $($script:RvcDir) && venv\Scripts\python.exe server.py > $($s.Log) 2>&1"
    return
  }
}

# Find the background processes belonging to one server, even before its
# port is listening (models still loading). Path-based, so nothing else
# on the laptop can ever be killed by mistake.
function Get-VnvProcesses([string]$key) {
  $procs = @()
  $s = Get-VnvServer $key
  if ($key -eq 'tunnel') {
    $procs += @(Get-Process cloudflared -ErrorAction SilentlyContinue)
  } else {
    if ($s.Port -gt 0) {
      foreach ($c in @(Get-NetTCPConnection -LocalPort $s.Port -State Listen -ErrorAction SilentlyContinue)) {
        $p = Get-Process -Id $c.OwningProcess -ErrorAction SilentlyContinue
        if ($p) { $procs += $p }
      }
    }
    $dir = $null
    if ($key -eq 'wokada') { $dir = $script:WokadaDir }
    if ($key -eq 'clone')  { $dir = $script:CloneDir }
    if ($key -eq 'rvc')    { $dir = $script:RvcDir }
    if ($dir) {
      $procs += @(Get-Process -ErrorAction SilentlyContinue | Where-Object {
        $_.Path -and $_.Path.StartsWith($dir, [System.StringComparison]::OrdinalIgnoreCase)
      })
    }
  }
  return @($procs | Where-Object { $_ } | Sort-Object Id -Unique)
}

function Stop-VnvServer([string]$key) {
  foreach ($p in @(Get-VnvProcesses $key)) {
    Stop-Process -Id $p.Id -Force -ErrorAction SilentlyContinue
  }
  if ($key -eq 'wokada') {
    # w-okada's GUI client and engine live/die together - always clear both
    Get-Process 'voice-changer-native-client' -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue
  }
  if ($key -eq 'tunnel') {
    $script:tunnelUrl = $null
    $script:awaitingUrl = $false
  }
}

# 'on' = port listening / URL live; 'starting' = process alive, not ready; 'off' = nothing
function Get-VnvStatus([string]$key) {
  $s = Get-VnvServer $key
  if ($key -eq 'tunnel') {
    if (-not (Get-Process cloudflared -ErrorAction SilentlyContinue)) { return 'off' }
    if ($script:tunnelUrl) { return 'on' }
    return 'starting'
  }
  if (Get-NetTCPConnection -LocalPort $s.Port -State Listen -ErrorAction SilentlyContinue) { return 'on' }
  if (@(Get-VnvProcesses $key).Count -gt 0) { return 'starting' }
  return 'off'
}

function Stop-AllVnv {
  # Legacy sweep: also close any visible "VNV - ..." windows from the old bat launcher
  cmd /c 'taskkill /F /T /FI "WINDOWTITLE eq VNV - *" >nul 2>&1'
  foreach ($s in $script:servers) { Stop-VnvServer $s.Key }
}

function Start-AllVnv {
  Stop-AllVnv
  Start-Sleep -Milliseconds 800
  foreach ($s in $script:servers) { Start-VnvServer $s.Key }
}

# ---- tunnel URL + website ------------------------------------------------

# Shared-read open: cloudflared/cmd keep their logs write-locked, a plain
# Get-Content can fail with a sharing violation (the old launcher bug).
function Read-VnvLogText([string]$path) {
  if (-not (Test-Path $path)) { return $null }
  try {
    $fs = [System.IO.File]::Open($path, 'Open', 'Read', 'ReadWrite')
    $sr = New-Object System.IO.StreamReader($fs)
    $txt = $sr.ReadToEnd()
    $sr.Close(); $fs.Close()
    return $txt
  } catch { return $null }
}

function Read-TunnelUrl {
  $paths = @((Get-VnvServer 'tunnel').Log, (Join-Path $env:TEMP 'vnv_cloudflared.log'))  # 2nd = old launcher's log
  foreach ($p in $paths) {
    $txt = Read-VnvLogText $p
    if ($txt) {
      $m = [regex]::Match($txt, 'https://[a-z0-9-]+\.trycloudflare\.com')
      if ($m.Success) { return $m.Value }
    }
  }
  return $null
}

function Push-UrlToWebsite([string]$url) {
  try {
    $body = @{ action = 'set_rvc_url'; password = $script:AdminPassword; url = $url } | ConvertTo-Json
    Invoke-RestMethod -Uri $script:AdminApi -Method Post -ContentType 'application/json' -Body $body -TimeoutSec 10 | Out-Null
    return $true
  } catch { return $false }
}

# ---- log viewer ------------------------------------------------------------

function Show-VnvLog([string]$key) {
  $s = Get-VnvServer $key
  $txt = Read-VnvLogText $s.Log
  if (-not $txt) { $txt = '(no log yet - start the server first)' }
  $lines = $txt -split "`r?`n"
  if ($lines.Count -gt 400) { $lines = $lines[($lines.Count - 400)..($lines.Count - 1)] }  # last 400 lines

  $lf = New-Object System.Windows.Forms.Form
  $lf.Text = "Log - $($s.Name)"
  $lf.Size = New-Object System.Drawing.Size(820, 480)
  $lf.StartPosition = 'CenterParent'
  $tb = New-Object System.Windows.Forms.TextBox
  $tb.Multiline = $true; $tb.ReadOnly = $true; $tb.ScrollBars = 'Both'; $tb.WordWrap = $false
  $tb.Dock = 'Fill'
  $tb.Font = New-Object System.Drawing.Font('Consolas', 9)
  $tb.Text = ($lines -join "`r`n")
  $lf.Controls.Add($tb)
  $lf.Add_Shown({ $tb.SelectionStart = $tb.Text.Length; $tb.ScrollToCaret() })
  [void]$lf.ShowDialog()
  $lf.Dispose()
}

# ---- UI --------------------------------------------------------------------

$script:form = New-Object System.Windows.Forms.Form
$script:form.Text = 'VNV Control Panel'
$script:form.Size = New-Object System.Drawing.Size(520, 415)
$script:form.FormBorderStyle = 'FixedSingle'
$script:form.MaximizeBox = $false
$script:form.StartPosition = 'CenterScreen'

$script:ui = @{}
$y = 15
foreach ($srv in $script:servers) {
  $key = $srv.Key

  $dot = New-Object System.Windows.Forms.Label
  $dot.Text = [char]0x25CF   # ●
  $dot.Font = New-Object System.Drawing.Font('Segoe UI', 14, [System.Drawing.FontStyle]::Bold)
  $dot.ForeColor = [System.Drawing.Color]::IndianRed
  $dot.Location = New-Object System.Drawing.Point(12, ($y - 3))
  $dot.Size = New-Object System.Drawing.Size(24, 26)
  $script:form.Controls.Add($dot)

  $name = New-Object System.Windows.Forms.Label
  $name.Text = $srv.Name
  $name.Font = New-Object System.Drawing.Font('Segoe UI', 10, [System.Drawing.FontStyle]::Bold)
  $name.Location = New-Object System.Drawing.Point(38, $y)
  $name.Size = New-Object System.Drawing.Size(180, 20)
  $script:form.Controls.Add($name)

  $status = New-Object System.Windows.Forms.Label
  $status.Text = '...'
  $status.Font = New-Object System.Drawing.Font('Segoe UI', 9)
  $status.ForeColor = [System.Drawing.Color]::DimGray
  $status.Location = New-Object System.Drawing.Point(222, ($y + 2))
  $status.Size = New-Object System.Drawing.Size(150, 18)
  $script:form.Controls.Add($status)

  $btn = New-Object System.Windows.Forms.Button
  $btn.Text = 'Start'
  $btn.Location = New-Object System.Drawing.Point(378, ($y - 3))
  $btn.Size = New-Object System.Drawing.Size(55, 26)
  $btn.Add_Click({
    $st = Get-VnvStatus $key
    if ($st -eq 'off') { Start-VnvServer $key } else { Stop-VnvServer $key }
    Update-VnvUI
  }.GetNewClosure())
  $script:form.Controls.Add($btn)

  $logBtn = New-Object System.Windows.Forms.Button
  $logBtn.Text = 'Log'
  $logBtn.Location = New-Object System.Drawing.Point(438, ($y - 3))
  $logBtn.Size = New-Object System.Drawing.Size(48, 26)
  $logBtn.Add_Click({ Show-VnvLog $key }.GetNewClosure())
  $script:form.Controls.Add($logBtn)

  $script:ui[$key] = @{ Dot = $dot; Status = $status; Btn = $btn }
  $y += 40
}

# Tunnel URL row
$urlLabel = New-Object System.Windows.Forms.Label
$urlLabel.Text = 'Tunnel URL:'
$urlLabel.Font = New-Object System.Drawing.Font('Segoe UI', 9)
$urlLabel.Location = New-Object System.Drawing.Point(12, ($y + 4))
$urlLabel.Size = New-Object System.Drawing.Size(72, 18)
$script:form.Controls.Add($urlLabel)

$script:urlBox = New-Object System.Windows.Forms.TextBox
$script:urlBox.ReadOnly = $true
$script:urlBox.Location = New-Object System.Drawing.Point(88, $y)
$script:urlBox.Size = New-Object System.Drawing.Size(280, 24)
$script:form.Controls.Add($script:urlBox)

$copyBtn = New-Object System.Windows.Forms.Button
$copyBtn.Text = 'Copy'
$copyBtn.Location = New-Object System.Drawing.Point(378, ($y - 2))
$copyBtn.Size = New-Object System.Drawing.Size(55, 26)
$copyBtn.Add_Click({
  if ($script:urlBox.Text) { [System.Windows.Forms.Clipboard]::SetText($script:urlBox.Text) }
})
$script:form.Controls.Add($copyBtn)

$pushBtn = New-Object System.Windows.Forms.Button
$pushBtn.Text = 'Site'
$pushBtn.Location = New-Object System.Drawing.Point(438, ($y - 2))
$pushBtn.Size = New-Object System.Drawing.Size(48, 26)
$toolTip = New-Object System.Windows.Forms.ToolTip
$toolTip.SetToolTip($pushBtn, 'Push this URL to the website (admin) again')
$pushBtn.Add_Click({
  if ($script:urlBox.Text) {
    if (Push-UrlToWebsite $script:urlBox.Text) { $script:footer.Text = 'Website updated.' }
    else { $script:footer.Text = 'Website update FAILED - check internet / password.' }
  }
})
$script:form.Controls.Add($pushBtn)
$y += 38

# Start All / Stop All
$startAll = New-Object System.Windows.Forms.Button
$startAll.Text = 'START ALL'
$startAll.Font = New-Object System.Drawing.Font('Segoe UI', 10, [System.Drawing.FontStyle]::Bold)
$startAll.BackColor = [System.Drawing.Color]::FromArgb(46, 160, 67)
$startAll.ForeColor = [System.Drawing.Color]::White
$startAll.FlatStyle = 'Flat'
$startAll.Location = New-Object System.Drawing.Point(12, $y)
$startAll.Size = New-Object System.Drawing.Size(232, 38)
$startAll.Add_Click({
  $script:footer.Text = 'Starting all servers... (models take 30-60s to load)'
  Start-AllVnv
  Update-VnvUI
})
$script:form.Controls.Add($startAll)

$stopAll = New-Object System.Windows.Forms.Button
$stopAll.Text = 'STOP ALL'
$stopAll.Font = New-Object System.Drawing.Font('Segoe UI', 10, [System.Drawing.FontStyle]::Bold)
$stopAll.BackColor = [System.Drawing.Color]::FromArgb(180, 60, 60)
$stopAll.ForeColor = [System.Drawing.Color]::White
$stopAll.FlatStyle = 'Flat'
$stopAll.Location = New-Object System.Drawing.Point(254, $y)
$stopAll.Size = New-Object System.Drawing.Size(232, 38)
$stopAll.Add_Click({
  Stop-AllVnv
  $script:urlBox.Text = ''
  $script:footer.Text = 'All servers stopped. Voice engines on the website will grey out.'
  Update-VnvUI
})
$script:form.Controls.Add($stopAll)
$y += 48

$script:footer = New-Object System.Windows.Forms.Label
$script:footer.Text = 'Closing this panel does NOT stop the servers.'
$script:footer.Font = New-Object System.Drawing.Font('Segoe UI', 8.5)
$script:footer.ForeColor = [System.Drawing.Color]::DimGray
$script:footer.Location = New-Object System.Drawing.Point(12, $y)
$script:footer.Size = New-Object System.Drawing.Size(474, 30)
$script:form.Controls.Add($script:footer)

# ---- status refresh --------------------------------------------------------

function Update-VnvUI {
  foreach ($srv in $script:servers) {
    $key = $srv.Key
    $st = Get-VnvStatus $key
    $row = $script:ui[$key]
    if ($st -eq 'on') {
      $row.Dot.ForeColor = [System.Drawing.Color]::LimeGreen
      $row.Status.Text = 'online'
      $row.Btn.Text = 'Stop'
    } elseif ($st -eq 'starting') {
      $row.Dot.ForeColor = [System.Drawing.Color]::Orange
      if ($key -eq 'tunnel') { $row.Status.Text = 'getting URL...' } else { $row.Status.Text = 'starting...' }
      $row.Btn.Text = 'Stop'
    } else {
      $row.Dot.ForeColor = [System.Drawing.Color]::IndianRed
      $row.Status.Text = 'offline'
      $row.Btn.Text = 'Start'
    }
  }
  if ($script:tunnelUrl -and $script:urlBox.Text -ne $script:tunnelUrl) { $script:urlBox.Text = $script:tunnelUrl }
}

$script:timer = New-Object System.Windows.Forms.Timer
$script:timer.Interval = 4000
$script:timer.Add_Tick({
  if ($script:awaitingUrl) {
    $u = Read-TunnelUrl
    if ($u) {
      $script:tunnelUrl = $u
      $script:awaitingUrl = $false
      $script:urlBox.Text = $u
      if (Push-UrlToWebsite $u) { $script:footer.Text = 'Tunnel live - website updated automatically.' }
      else { $script:footer.Text = 'Tunnel live but website update FAILED - click the Site button to retry.' }
    } else {
      $script:urlWaitTicks++
      if ($script:urlWaitTicks -gt 30) {   # ~2 minutes
        $script:awaitingUrl = $false
        $script:footer.Text = 'Tunnel URL not found after 2 min - check the Tunnel log.'
      }
    }
  }
  Update-VnvUI
})

# On open: adopt whatever is already running (e.g. started by the old bat)
$script:form.Add_Shown({
  $u = Read-TunnelUrl
  if ($u -and (Get-Process cloudflared -ErrorAction SilentlyContinue)) {
    $script:tunnelUrl = $u
    $script:urlBox.Text = $u
  }
  Update-VnvUI
  $script:timer.Start()
})
$script:form.Add_FormClosed({ $script:timer.Stop() })

[System.Windows.Forms.Application]::Run($script:form)
