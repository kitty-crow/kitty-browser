$ErrorActionPreference = 'Stop'

$Repo = if ($env:KITTY_BROWSER_REPO) { $env:KITTY_BROWSER_REPO } else { 'kitty-crow/kitty-browser' }
$ArchRaw = if ($env:PROCESSOR_ARCHITEW6432) { $env:PROCESSOR_ARCHITEW6432 } else { $env:PROCESSOR_ARCHITECTURE }

switch ($ArchRaw.ToUpperInvariant()) {
    'AMD64' { $Arch = 'x64' }
    'ARM64' { $Arch = 'arm64' }
    default { throw "kitty-browser: unsupported CPU architecture: $ArchRaw" }
}

$Suffix = "windows-$Arch"
$Asset = "kitty-browser-$Suffix.tar.gz"
$Base = "https://github.com/$Repo/releases/latest/download"
$BundleUrl = "$Base/$Asset"
$ChecksumUrl = "$Base/$Asset.sha256"
$CacheRoot = Join-Path $env:LOCALAPPDATA 'KittyBrowser'
$BundlesRoot = Join-Path $CacheRoot 'bundles'
$InstallDir = Join-Path $BundlesRoot $Suffix
$Binary = Join-Path $InstallDir 'kitty-browser.exe'
$Marker = Join-Path $InstallDir '.archive.sha256'
$ChecksumTmp = Join-Path $CacheRoot ".$Asset.sha256.tmp"
$BundleTmp = Join-Path $CacheRoot ".$Asset.tmp"

New-Item -ItemType Directory -Force -Path $BundlesRoot | Out-Null
Invoke-WebRequest -UseBasicParsing -Uri $ChecksumUrl -OutFile $ChecksumTmp

$ChecksumText = (Get-Content -LiteralPath $ChecksumTmp -Raw).Trim()
$Expected = ($ChecksumText -split '\s+')[0].ToLowerInvariant()
if (-not $Expected) {
    Remove-Item -Force -ErrorAction SilentlyContinue $ChecksumTmp
    throw 'kitty-browser: release checksum is empty'
}

$Installed = ''
if (Test-Path -LiteralPath $Marker) {
    $Installed = (Get-Content -LiteralPath $Marker -Raw).Trim().ToLowerInvariant()
}

if (($Installed -ne $Expected) -or -not (Test-Path -LiteralPath $Binary)) {
    Write-Host "kitty-browser: downloading $Asset (includes Chromium)" -ForegroundColor DarkGray
    Remove-Item -Force -ErrorAction SilentlyContinue $BundleTmp
    Invoke-WebRequest -UseBasicParsing -Uri $BundleUrl -OutFile $BundleTmp

    $Actual = (Get-FileHash -Algorithm SHA256 -LiteralPath $BundleTmp).Hash.ToLowerInvariant()
    if ($Actual -ne $Expected) {
        Remove-Item -Force -ErrorAction SilentlyContinue $BundleTmp, $ChecksumTmp
        throw "kitty-browser: SHA-256 verification failed`nexpected: $Expected`nactual:   $Actual"
    }

    $Stage = Join-Path $CacheRoot ('.kitty-browser-' + $Suffix + '-' + [Guid]::NewGuid().ToString('N'))
    New-Item -ItemType Directory -Force -Path $Stage | Out-Null
    try {
        & tar.exe -xzf $BundleTmp -C $Stage
        if ($LASTEXITCODE -ne 0) {
            throw "kitty-browser: tar extraction failed with exit code $LASTEXITCODE"
        }
        if (-not (Test-Path -LiteralPath (Join-Path $Stage 'kitty-browser.exe'))) {
            throw 'kitty-browser: release bundle does not contain kitty-browser.exe'
        }
        if (-not (Test-Path -LiteralPath (Join-Path $Stage 'chromium'))) {
            throw 'kitty-browser: release bundle does not contain Chromium'
        }

        Set-Content -NoNewline -LiteralPath (Join-Path $Stage '.archive.sha256') -Value $Expected
        Remove-Item -Recurse -Force -ErrorAction SilentlyContinue $InstallDir
        Move-Item -LiteralPath $Stage -Destination $InstallDir
    }
    finally {
        Remove-Item -Recurse -Force -ErrorAction SilentlyContinue $Stage
        Remove-Item -Force -ErrorAction SilentlyContinue $BundleTmp
    }
}

Remove-Item -Force -ErrorAction SilentlyContinue $ChecksumTmp
Unblock-File -LiteralPath $Binary -ErrorAction SilentlyContinue
& $Binary @args
exit $LASTEXITCODE
