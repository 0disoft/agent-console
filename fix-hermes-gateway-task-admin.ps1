$ErrorActionPreference = "Stop"

$taskName = "Hermes_Gateway"
$vbs = Join-Path $env:LOCALAPPDATA "hermes\gateway-service\Hermes_Gateway.vbs"

if (-not (Test-Path -LiteralPath $vbs)) {
    throw "Hermes gateway VBS not found: $vbs"
}

$action = New-ScheduledTaskAction `
    -Execute "$env:SystemRoot\System32\wscript.exe" `
    -Argument "`"$vbs`""

$task = Get-ScheduledTask -TaskName $taskName -ErrorAction Stop
$task.Actions = @($action)
$task.Settings.Hidden = $true

Set-ScheduledTask -InputObject $task | Out-Null

Write-Host "Hermes_Gateway task now starts hidden via wscript.exe:"
Get-ScheduledTask -TaskName $taskName | ForEach-Object {
    $_.Actions
    "Hidden: $($_.Settings.Hidden)"
}

Read-Host "Done. Press Enter to close"
