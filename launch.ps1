# Starts the server if it is not running yet, then opens the app in the default browser.
# The server runs in a minimized "Money Monitoring" window; closing that window stops it.
$port = if ($env:PORT) { $env:PORT } else { 3001 }
$url = "http://localhost:$port"

function Test-Server {
  try {
    Invoke-WebRequest "$url/api/health" -UseBasicParsing -TimeoutSec 2 | Out-Null
    return $true
  } catch {
    return $false
  }
}

if (-not (Test-Server)) {
  # /k keeps the window open if the server crashes, so the error stays readable.
  Start-Process cmd -ArgumentList '/k', 'title Money Monitoring && node server.js' `
    -WorkingDirectory $PSScriptRoot -WindowStyle Minimized

  for ($i = 0; $i -lt 40 -and -not (Test-Server); $i++) {
    Start-Sleep -Milliseconds 250
  }
}

Start-Process $url
