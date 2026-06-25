# ============================================================
#  VNV Pro — ONE-CLICK LAUNCHER
#  Starts the voice server + ngrok, then AUTO-UPDATES the RVC
#  URL in your website's admin so you never have to paste it.
#  Just double-click START-VNVPRO.bat (which runs this).
# ============================================================

$RvcDir        = 'C:\Users\USER\Desktop\vnvpro\rvc-server'
$AdminApi      = 'https://vnvpro.vercel.app/api/admin'
$AdminPassword = '09130370801Maviegr8@'   # <-- if you changed ADMIN_PASSWORD in Vercel, update this line
$Port          = 8765

Write-Host '============================================================'
Write-Host '   VNV Pro - starting everything in one go'
Write-Host '============================================================'

# 0) Clean up any old instances so the port is free (prevents the
#    "only one usage of each socket address" error you hit before).
Write-Host 'Clearing any previous server/ngrok instances...'
try {
  Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue |
    ForEach-Object { Stop-Process -Id $_.OwningProcess -Force -ErrorAction SilentlyContinue }
} catch {}
Get-Process ngrok -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue
Start-Sleep -Milliseconds 800

# 1) Start the RVC voice server (using the venv = latest code) in its own window
Write-Host 'Starting voice server...'
Start-Process cmd -ArgumentList '/k', "cd /d `"$RvcDir`" && venv\Scripts\python.exe server.py"

# 2) Start ngrok in its own window
Write-Host 'Starting ngrok tunnel...'
Start-Process cmd -ArgumentList '/k', "ngrok http $Port"

# 3) Wait for ngrok's local API, then read the public https URL automatically
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

if (-not $publicUrl) {
  Write-Host ''
  Write-Host 'Could not auto-detect the ngrok URL. Open the ngrok window, copy the' -ForegroundColor Yellow
  Write-Host 'https://....ngrok-free.dev address, and paste it into Admin > Settings > RVC Server URL.' -ForegroundColor Yellow
  Read-Host 'Press Enter to close'
  exit
}

Write-Host ''
Write-Host "Detected ngrok URL: $publicUrl"

# 4) Push it to the website's admin so voice goes live with no manual step
Write-Host 'Updating your website automatically...'
try {
  $body = @{ action = 'set_rvc_url'; password = $AdminPassword; url = $publicUrl } | ConvertTo-Json
  Invoke-RestMethod -Uri $AdminApi -Method Post -ContentType 'application/json' -Body $body -TimeoutSec 15 | Out-Null
  Write-Host ''
  Write-Host '============================================================' -ForegroundColor Green
  Write-Host '   DONE. Voice is LIVE. Nothing else to do.' -ForegroundColor Green
  Write-Host '   Keep the Voice Server and ngrok windows open.' -ForegroundColor Green
  Write-Host '============================================================' -ForegroundColor Green
} catch {
  Write-Host ''
  Write-Host "Auto-update failed: $($_.Exception.Message)" -ForegroundColor Yellow
  Write-Host "Paste this into Admin > Settings > RVC Server URL:  $publicUrl" -ForegroundColor Yellow
  Write-Host '(If it says Unauthorized, your ADMIN_PASSWORD in Vercel differs from the one in this script.)' -ForegroundColor Yellow
}

Write-Host ''
Read-Host 'Press Enter to close this launcher window (the server/ngrok windows stay open)'
