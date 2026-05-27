$ErrorActionPreference = "Stop"

$root = (Resolve-Path -LiteralPath $PSScriptRoot).Path.TrimEnd("\")
$port = if ($env:AGENT_CONSOLE_PORT) { [int]$env:AGENT_CONSOLE_PORT } else { 8765 }
$listeners = Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue

if (-not $listeners) {
    Write-Host "Agent Console is not running."
    Read-Host "Press Enter to close"
    exit 0
}

$targets = @()
foreach ($listener in $listeners) {
    $proc = Get-CimInstance Win32_Process -Filter "ProcessId = $($listener.OwningProcess)" -ErrorAction SilentlyContinue
    $cmd = if ($proc) { [string]$proc.CommandLine } else { "" }
    if ($cmd -like "*$root*" -or $cmd -match "server\.ts") {
        $targets += $listener.OwningProcess
    } else {
        Write-Host "Port $port is used by another process. Not stopping PID $($listener.OwningProcess): $cmd"
    }
}

$targets = $targets | Select-Object -Unique
if (-not $targets) {
    Read-Host "Press Enter to close"
    exit 1
}

$targets | ForEach-Object {
    Stop-Process -Id $_ -Force -ErrorAction SilentlyContinue
}

Write-Host "Agent Console stopped."
Read-Host "Press Enter to close"
