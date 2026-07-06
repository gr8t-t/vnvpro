# ============================================================
#  VNV Pro - ONE-CLICK LAUNCHER  (Option A: permanent ngrok domain)
#  Starts ALL THREE servers and points the website at your
#  permanent ngrok address so you never paste a URL again.
#    1) w-okada      (Voice 2.0, port 18000)
#    2) RVC server   (Voice 1.0, port 8765)
#    3) ngrok        (tunnel on 8765, your permanent domain)
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

# Your PERMANENT ngrok domain (Option A). Paste the bare domain only -
# e.g.  tough-cat-1234.ngrok-free.app   (NO https://, no slash).
# Get it once at https://dashboard.ngrok.com/domains  then paste here.
# Leave it as '' to fall back to a random URL.
$NgrokDomain   = 'exerciser-overvalue-stoppable.ngrok-free.dev'
# -------------------------------------------------------------

$NgrokDomain = $NgrokDomain.Trim()
if ($NgrokDomain) { $NgrokDomain = ($NgrokDomain -replace '^https?://','') -replace '/+$','' }

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

# 3) Start ngrok in its own window (permanent domain if set, else random)
if ($NgrokDomain) {
  Write-Host "Starting ngrok on your permanent domain: $NgrokDomain"
  Start-Process cmd -ArgumentList '/k', "title VNV - ngrok && ngrok http --url=https://$NgrokDomain $Port"
} else {
  Write-Host 'Starting ngrok (random URL - no permanent domain set yet)...' -ForegroundColor Yellow
  Start-Process cmd -ArgumentList '/k', "title VNV - ngrok && ngrok http $Port"
}

# 4) Wait for ngrok's local API, then read the public https URL
Write-Host 'Waiting for the ngrok tunnel to come up...'
$publicUrl = $null
for ($i = 0; $i -lt 30; $i++) {
  Start-Sleep -Seconds 2
  try {
    $t = Invoke-RestMethod -Uri 'http://127.0.0.1:4040/api/tunnels' -TimeoutSec 3
    $https = $t.tunnels | Where-Object { $_.public_url -like 'https://*' } | Select-Object -First 1
    if ($https) { $publicUrl = $https.public_url; break }
  } catch {}
}
# With a permanent domain we know the URL even if the local API was slow
if (-not $publicUrl -and $NgrokDomain) { $publicUrl = "https://$NgrokDomain" }

if (-not $publicUrl) {
  Write-Host ''
  Write-Host 'Could not auto-detect the ngrok URL. Open the ngrok window, copy the' -ForegroundColor Yellow
  Write-Host 'https://... address, and paste it into Admin > Settings > RVC Server URL.' -ForegroundColor Yellow
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
