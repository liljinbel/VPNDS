$dest = Join-Path $env:LOCALAPPDATA 'GoLiveBypass\Tor'
if (-not (Test-Path -LiteralPath $dest)) {
    New-Item -ItemType Directory -Path $dest -Force | Out-Null
}

$torExe = Join-Path $dest 'tor\tor.exe'
if (Test-Path -LiteralPath $torExe) {
    Write-Output "TorAlreadyInstalled"
    exit 0
}

$archive = Join-Path $env:TEMP 'tor-expert.tar.gz'
$url = 'https://dist.torproject.org/torbrowser/15.0.22/tor-expert-bundle-windows-x86_64-15.0.22.tar.gz'

Write-Host "Baixando Tor Expert Bundle..."
curl.exe -sL $url -o $archive

if (-not (Test-Path -LiteralPath $archive)) {
    Write-Error "Falha ao baixar arquivo do Tor."
    exit 1
}

Write-Host "Extraindo Tor..."
& tar.exe -xzf $archive -C $dest

Remove-Item -LiteralPath $archive -Force -ErrorAction SilentlyContinue

if (Test-Path -LiteralPath $torExe) {
    Write-Output "TorInstalledSuccessfully"
    exit 0
} else {
    Write-Error "Arquivo tor.exe nao foi encontrado apos extracao."
    exit 1
}
