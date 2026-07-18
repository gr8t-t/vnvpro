# ============================================================
#  VNV Pro - ONE-CLICK LAUNCHER
#  Starts all servers + a Cloudflare Tunnel and auto-points the
#  website at it, so you never paste a URL. (Switched from ngrok
#  to Cloudflare - much lower latency from Nigeria, no limits.)
#    1) w-okada      (Voice 2.0, port 18000)
#    2) Seed-VC      (Voice Clone, port 18100)
#    3) RVC server   (Voice 1.0 + proxy, port 8765)
#    4) Cloudflare Tunnel (on 8765, fresh URL each run, auto-set)
#  Just double-click START-VNVPRO.bat (which runs this).
# ============================================================

# ---- CONFIG -------------------------------------------------
$RvcDir        = 'C:\Users\USER\Desktop\vnvpro\rvc-server'
$WokadaDir     = 'C:\Users\USER\Downloads\vcclient_win_cuda_2.0.78-beta\dist\main'
$AdminApi      = 'https://vnvpro.vercel.app/api/admin'
$AdminPassword = '09130370801Maviegr8@'   # <-- if you change ADMIN_PASSWORD in Vercel, update this line
$Port          = 8765
$WokadaPort    = 18000
$CloneDir      = 'C:\Users\USER\seed-vc'
$ClonePort     = 18100
$CloudflaredExe = 'C:\Users\USER\cloudflared\cloudflared.exe'   # tunnel (replaced ngrok - lower latency from Nigeria, no limits)
$CfLog          = Join-Path $env:TEMP 'vnv_cloudflared.log'

# (Old ngrok domain, kept only for reference in case you ever revert:
#  exerciser-overvalue-stoppable.ngrok-free.dev)
# -------------------------------------------------------------

Write-Host '============================================================'
Write-Host '   VNV Pro - starting everything in one go'
Write-Host '============================================================'

# 0) Free the ports so we never hit "only one usage of each socket address"
Write-Host 'Clearing any previous server/ngrok instances...'
foreach ($p in @($Port, $WokadaPort, $ClonePort)) {
  try {
    Get-NetTCPConnection -LocalPort $p -State Listen -ErrorAction SilentlyContinue |
      ForEach-Object { Stop-Process -Id $_.OwningProcess -Force -ErrorAction SilentlyContinue }
  } catch {}
}
Get-Process ngrok -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue
Get-Process cloudflared -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue
Remove-Item $CfLog -Force -ErrorAction SilentlyContinue
Start-Sleep -Milliseconds 800

# 1) Start w-okada (Voice 2.0) in its own window
if (Test-Path (Join-Path $WokadaDir 'main.exe')) {
  Write-Host 'Starting Voice 2.0 (w-okada)...'
  Start-Process cmd -ArgumentList '/k', "title VNV - Voice 2.0 (w-okada) && cd /d `"$WokadaDir`" && main.exe cui --https false --no_cui True"
} else {
  Write-Host "w-okada not found at $WokadaDir - Voice 2.0 will stay offline." -ForegroundColor Yellow
}

# 1b) Start the Seed-VC voice-clone server in its own window (if installed)
if (Test-Path (Join-Path $CloneDir 'clone_server.py')) {
  Write-Host 'Starting Voice Clone (Seed-VC)...'
  Start-Process cmd -ArgumentList '/k', "title VNV - Voice Clone (Seed-VC) && cd /d `"$CloneDir`" && venv\Scripts\python.exe clone_server.py"
} else {
  Write-Host "Seed-VC not found at $CloneDir - voice cloning will stay offline." -ForegroundColor Yellow
}

# 2) Start the RVC voice server (Voice 1.0) in its own window (venv = latest code)
Write-Host 'Starting Voice 1.0 (RVC server)...'
Start-Process cmd -ArgumentList '/k', "title VNV - Voice 1.0 (RVC server) && cd /d `"$RvcDir`" && venv\Scripts\python.exe server.py"

# 3) Start the Cloudflare Tunnel in its own window (replaces ngrok - far lower
#    latency from Nigeria, and no request/bandwidth limits). It gets a fresh free
#    random URL each run, which we auto-push to admin below so you never paste it.
Write-Host 'Starting Cloudflare Tunnel...'
#    --protocol http2   : TCP transport instead of QUIC/UDP - avoids the Windows UDP
#                         buffer bug ("wsasendto: system lacked sufficient buffer space")
#                         that wedged the tunnel into a permanent retry loop on 2026-07-18.
#    --edge-ip-version 4: the laptop's IPv6 is flaky (every "unreachable network" error
#                         in that incident was an IPv6 edge IP) - stick to IPv4.
Start-Process cmd -ArgumentList '/k', "title VNV - Cloudflare Tunnel && echo Cloudflare Tunnel is running. Keep this window open while users are online. && `"$CloudflaredExe`" tunnel --url http://127.0.0.1:$Port --protocol http2 --edge-ip-version 4 --logfile `"$CfLog`""

# 4) Wait for cloudflared to write its public https URL to the logfile, then read
#    it with a SHARED read (cloudflared keeps the file open, so a plain Get-Content
#    can hit a sharing violation and silently fail - that was breaking the auto-update).
Write-Host 'Waiting for the Cloudflare Tunnel to come up...'
$publicUrl = $null
for ($i = 0; $i -lt 40; $i++) {
  Start-Sleep -Seconds 2
  if (Test-Path $CfLog) {
    try {
      $fs = [System.IO.File]::Open($CfLog, 'Open', 'Read', 'ReadWrite')
      $sr = New-Object System.IO.StreamReader($fs)
      $txt = $sr.ReadToEnd(); $sr.Close(); $fs.Close()
      $m = [regex]::Match($txt, 'https://[a-z0-9-]+\.trycloudflare\.com')
      if ($m.Success) { $publicUrl = $m.Value; break }
    } catch {}
  }
}

if (-not $publicUrl) {
  Write-Host ''
  Write-Host 'Could not auto-detect the Cloudflare URL. Open the Cloudflare Tunnel window/log' -ForegroundColor Yellow
  Write-Host 'and copy the https://...trycloudflare.com address into Admin > RVC Server URL.' -ForegroundColor Yellow
  Read-Host 'Press Enter to close'
  exit
}

Write-Host ''
Write-Host "Tunnel URL: $publicUrl"

# 5) Push it to the website's admin so voice goes live with no manual step
Write-Host 'Updating your website automatically...'
try {
  $body = @{ action = 'set_rvc_url'; password = $AdminPassword; url = $publicUrl } | ConvertTo-Json
  Invoke-RestMethod -Uri $AdminApi -Method Post -ContentType 'application/json' -Body $body -TimeoutSec 15 | Out-Null
  Write-Host ''
  Write-Host '============================================================' -ForegroundColor Green
  Write-Host '   DONE. Voice will be LIVE once the two server windows' -ForegroundColor Green
  Write-Host '   finish loading (w-okada takes ~30-60s the first time).' -ForegroundColor Green
  Write-Host '   Keep the server windows open while users are online.' -ForegroundColor Green
  Write-Host '============================================================' -ForegroundColor Green
} catch {
  Write-Host ''
  Write-Host "Auto-update failed: $($_.Exception.Message)" -ForegroundColor Yellow
  Write-Host "Paste this into Admin > Settings > RVC Server URL:  $publicUrl" -ForegroundColor Yellow
  Write-Host '(If it says Unauthorized, your ADMIN_PASSWORD in Vercel differs from the one in this script.)' -ForegroundColor Yellow
}

Write-Host ''
Read-Host 'Press Enter to close this launcher window (the three server windows stay open)'
