$ErrorActionPreference = "Stop"

$taskName = "Hermes_Gateway"
$vbs = Join-Path $env:LOCALAPPDATA "hermes\gateway-service\Hermes_Gateway.vbs"
$currentIdentity = [Security.Principal.WindowsIdentity]::GetCurrent()
$currentUser = $currentIdentity.Name
$currentSid = $currentIdentity.User.Value

if (-not (Test-Path -LiteralPath $vbs)) {
    throw "Hermes gateway VBS not found: $vbs"
}

$task = Get-ScheduledTask -TaskName $taskName -ErrorAction Stop
$principal = $task.Principal

if ($principal.RunLevel -eq "Highest") {
    throw "Refusing to point an elevated Hermes_Gateway task at a user-profile VBS. Recreate the task as a non-elevated per-user task."
}

if ($principal.GroupId) {
    throw "Refusing to modify a group-principal Hermes_Gateway task: $($principal.GroupId)"
}

if ($principal.UserId -and $principal.UserId -notin @($currentUser, $currentSid)) {
    throw "Refusing to modify Hermes_Gateway for a different principal: $($principal.UserId)"
}

$acl = Get-Acl -LiteralPath $vbs
$unsafeWriterSids = @(
    "S-1-1-0",
    "S-1-5-11",
    "S-1-5-32-545"
)
$writeRights = [System.Security.AccessControl.FileSystemRights]::Write `
    -bor [System.Security.AccessControl.FileSystemRights]::WriteData `
    -bor [System.Security.AccessControl.FileSystemRights]::CreateFiles `
    -bor [System.Security.AccessControl.FileSystemRights]::Modify `
    -bor [System.Security.AccessControl.FileSystemRights]::FullControl

foreach ($ace in $acl.Access) {
    if ($ace.AccessControlType -ne [System.Security.AccessControl.AccessControlType]::Allow) { continue }
    try {
        $sid = $ace.IdentityReference.Translate([Security.Principal.SecurityIdentifier]).Value
    } catch {
        continue
    }
    if (($unsafeWriterSids -contains $sid) -and (($ace.FileSystemRights -band $writeRights) -ne 0)) {
        throw "Refusing to use Hermes gateway VBS because a broad principal can write it: $($ace.IdentityReference)"
    }
}

$action = New-ScheduledTaskAction `
    -Execute "$env:SystemRoot\System32\wscript.exe" `
    -Argument "`"$vbs`""

$task.Actions = @($action)

Set-ScheduledTask -InputObject $task | Out-Null

Write-Host "Hermes_Gateway task now starts via wscript.exe:"
Get-ScheduledTask -TaskName $taskName | ForEach-Object {
    $_.Actions
    "Hidden: $($_.Settings.Hidden)"
}

Read-Host "Done. Press Enter to close"
