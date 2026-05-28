$ErrorActionPreference = "Stop"

[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$OutputEncoding = [System.Text.Encoding]::UTF8

$repo = "zeroclaw-labs/zeroclaw"
$assetName = "zeroclaw-x86_64-pc-windows-msvc.zip"
$installDir = Join-Path $env:USERPROFILE ".zeroclaw\bin"
$targetExe = Join-Path $installDir "zeroclaw.exe"
$headers = @{
    "User-Agent" = "agent-console-zeroclaw-updater"
    "Accept" = "application/vnd.github+json"
}

function Invoke-GitHubJson($url) {
    Invoke-RestMethod -Headers $headers -Uri $url
}

function Download-File($url, $path) {
    Invoke-WebRequest -Headers $headers -Uri $url -OutFile $path
}

function Add-UserPath($path) {
    $current = [Environment]::GetEnvironmentVariable("Path", "User")
    $parts = @()
    if ($current) {
        $parts = $current -split ";" | Where-Object { $_ }
    }
    if ($parts | Where-Object { $_ -ieq $path }) {
        return $false
    }
    $next = @($parts + $path) -join ";"
    [Environment]::SetEnvironmentVariable("Path", $next, "User")
    return $true
}

Write-Host "ZeroClaw GitHub release update"
Write-Host "Source: https://github.com/$repo/releases/latest"
Write-Host ""

$release = Invoke-GitHubJson "https://api.github.com/repos/$repo/releases/latest"
$tag = [string]$release.tag_name
if (-not $tag) {
    throw "Could not resolve GitHub latest release tag."
}

$asset = $release.assets | Where-Object { $_.name -eq $assetName } | Select-Object -First 1
$sums = $release.assets | Where-Object { $_.name -eq "SHA256SUMS" } | Select-Object -First 1
if (-not $asset) {
    throw "Release $tag does not include Windows asset: $assetName"
}
if (-not $sums) {
    throw "Release $tag does not include SHA256SUMS; refusing to install without verification."
}

$tmp = Join-Path ([IO.Path]::GetTempPath()) ("agent-console-zeroclaw-" + [Guid]::NewGuid().ToString("N"))
$zipPath = Join-Path $tmp $assetName
$sumsPath = Join-Path $tmp "SHA256SUMS"
$extractDir = Join-Path $tmp "extract"

try {
    New-Item -ItemType Directory -Path $tmp, $extractDir | Out-Null
    Write-Host "Downloading $tag..."
    Download-File $asset.browser_download_url $zipPath
    Download-File $sums.browser_download_url $sumsPath

    $sumLine = Get-Content -LiteralPath $sumsPath | Where-Object { $_ -match [regex]::Escape($assetName) } | Select-Object -First 1
    if (-not $sumLine) {
        throw "Could not find $assetName in SHA256SUMS."
    }
    $expected = ($sumLine -split "\s+")[0].ToLowerInvariant()
    $actual = (Get-FileHash -Algorithm SHA256 -LiteralPath $zipPath).Hash.ToLowerInvariant()
    if ($actual -ne $expected) {
        throw "SHA256 mismatch. Expected $expected, got $actual"
    }
    Write-Host "Checksum verified: $actual"

    Expand-Archive -LiteralPath $zipPath -DestinationPath $extractDir -Force
    $newExe = Get-ChildItem -LiteralPath $extractDir -Recurse -Filter "zeroclaw.exe" | Select-Object -First 1
    if (-not $newExe) {
        throw "Could not find zeroclaw.exe in the downloaded archive."
    }

    New-Item -ItemType Directory -Path $installDir -Force | Out-Null
    if (Test-Path -LiteralPath $targetExe) {
        $stamp = Get-Date -Format "yyyyMMdd_HHmmss"
        $backup = "$targetExe.bak.$stamp"
        Copy-Item -LiteralPath $targetExe -Destination $backup -Force
        Write-Host "Backup: $backup"
    }

    Copy-Item -LiteralPath $newExe.FullName -Destination $targetExe -Force
    Write-Host "Installed: $targetExe"

    if (Add-UserPath $installDir) {
        Write-Host "Added to user PATH: $installDir"
        $env:PATH = "$env:PATH;$installDir"
    }

    $version = & $targetExe --version
    Write-Host "Version: $version"

    $active = (& where.exe zeroclaw 2>$null | Select-Object -First 1)
    if ($active -and ((Resolve-Path -LiteralPath $active).Path -ine (Resolve-Path -LiteralPath $targetExe).Path)) {
        Write-Host ""
        Write-Host "Warning: the first zeroclaw on PATH is a different executable: $active"
        Write-Host "Agent Console will prefer this executable after restart: $targetExe"
    }
} finally {
    Remove-Item -LiteralPath $tmp -Recurse -Force -ErrorAction SilentlyContinue
}
