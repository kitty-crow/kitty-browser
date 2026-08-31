$ErrorActionPreference = 'Stop'

$Repo = if ($env:KITTY_BROWSER_REPO) { $env:KITTY_BROWSER_REPO } else { 'kitty-crow/kitty-browser' }
$ArchRaw = if ($env:PROCESSOR_ARCHITEW6432) { $env:PROCESSOR_ARCHITEW6432 } else { $env:PROCESSOR_ARCHITECTURE }

switch ($ArchRaw.ToUpperInvariant()) {
    'AMD64' { $Arch = 'x64' }
    'ARM64' { $Arch = 'arm64' }
    default { throw "kitty-browser: unsupported CPU architecture: $ArchRaw" }
}

$Asset = "kitty-browser-windows-$Arch.exe"
$Base = "https://github.com/$Repo/releases/latest/download"
$BinaryUrl = "$Base/$Asset"
$ChecksumUrl = "$Base/$Asset.sha256"
$CacheRoot = Join-Path $env:LOCALAPPDATA 'KittyBrowser'
$BinDir = Join-Path $CacheRoot 'bin'
$Binary = Join-Path $BinDir $Asset
$ChecksumTmp = Join-Path $BinDir ".$Asset.sha256.tmp"
$BinaryTmp = Join-Path $BinDir ".$Asset.tmp"

New-Item -ItemType Directory -Force -Path $BinDir | Out-Null
Invoke-WebRequest -UseBasicParsing -Uri $ChecksumUrl -OutFile $ChecksumTmp

$ChecksumText = (Get-Content -LiteralPath $ChecksumTmp -Raw).Trim()
$Expected = ($ChecksumText -split '\s+')[0].ToLowerInvariant()
if (-not $Expected) {
    Remove-Item -Force -ErrorAction SilentlyContinue $ChecksumTmp
    throw 'kitty-browser: release checksum is empty'
}

$Current = ''
if (Test-Path -LiteralPath $Binary) {
    $Current = (Get-FileHash -Algorithm SHA256 -LiteralPath $Binary).Hash.ToLowerInvariant()
}

if ($Current -ne $Expected) {
    Write-Host "kitty-browser: downloading $Asset" -ForegroundColor DarkGray
    Invoke-WebRequest -UseBasicParsing -Uri $BinaryUrl -OutFile $BinaryTmp
    $Actual = (Get-FileHash -Algorithm SHA256 -LiteralPath $BinaryTmp).Hash.ToLowerInvariant()
    if ($Actual -ne $Expected) {
        Remove-Item -Force -ErrorAction SilentlyContinue $BinaryTmp, $ChecksumTmp
        throw "kitty-browser: SHA-256 verification failed`nexpected: $Expected`nactual:   $Actual"
    }
    Move-Item -Force -LiteralPath $BinaryTmp -Destination $Binary
}

Remove-Item -Force -ErrorAction SilentlyContinue $ChecksumTmp
& $Binary @args
exit $LASTEXITCODE
