$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $MyInvocation.MyCommand.Path
Set-Location $root

$port = if ($env:AGENT_CONSOLE_PORT) { [int]$env:AGENT_CONSOLE_PORT } else { 8765 }
$url = "http://127.0.0.1:$port"
$listener = Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1

if ($listener) {
    $process = Get-CimInstance Win32_Process -Filter "ProcessId = $($listener.OwningProcess)" -ErrorAction SilentlyContinue
    $commandLine = if ($process) { [string]$process.CommandLine } else { "" }
    if ($commandLine -notlike "*$root*" -and $commandLine -notmatch "server\.ts") {
        Write-Host "Port $port is already used by another process:"
        Write-Host "PID $($listener.OwningProcess) $commandLine"
        Read-Host "Press Enter to close this window"
        exit 1
    }
    Write-Host "Agent Console is already running: $url"
    Start-Process $url
    Read-Host "Press Enter to close this window"
    exit 0
}

$openWhenReady = @"
`$ErrorActionPreference = "SilentlyContinue"
`$url = "$url"
`$deadline = (Get-Date).AddSeconds(20)
while ((Get-Date) -lt `$deadline) {
    try {
        `$response = Invoke-WebRequest -UseBasicParsing -Uri `$url -TimeoutSec 1
        if (`$response.StatusCode -ge 200 -and `$response.StatusCode -lt 500) {
            Start-Process `$url
            exit 0
        }
    } catch {
    }
    Start-Sleep -Milliseconds 250
}
Start-Process `$url
"@

Start-Process powershell -WindowStyle Hidden -ArgumentList @(
    "-NoProfile",
    "-Command",
    $openWhenReady
)

try {
    bun server.ts
}
finally {
    Write-Host ""
    Read-Host "Server stopped. Press Enter to close this window"
}
