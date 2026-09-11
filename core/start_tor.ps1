$localApp = [Environment]::GetFolderPath([Environment+SpecialFolder]::LocalApplicationData)
if (-not $localApp) { $localApp = Join-Path $env:USERPROFILE 'AppData\Local' }

$torDir = Join-Path $localApp 'GoLiveBypass\Tor'
$torExe = Join-Path $torDir 'tor\tor.exe'
$torrc = Join-Path $torDir 'torrc'
$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
if (-not $scriptDir) { $scriptDir = (Get-Location).Path }
$bundledTor = Join-Path $scriptDir 'Tor'

# Se o Tor ainda nao estiver em AppData (computador de um amigo), copia o Tor embutido na pasta core
if (-not (Test-Path -LiteralPath $torExe)) {
    if (Test-Path -LiteralPath $bundledTor) {
        New-Item -ItemType Directory -Path $torDir -Force | Out-Null
        Copy-Item -Path (Join-Path $bundledTor 'tor'), (Join-Path $bundledTor 'data') -Destination $torDir -Recurse -Force -ErrorAction SilentlyContinue
    }
}

# Garante que o torrc existe e aponta corretamente com barras normais
if (Test-Path -LiteralPath $torExe) {
    $torData = (Join-Path $torDir 'data-state').Replace('\', '/')
    $geoip = (Join-Path $torDir 'data\geoip').Replace('\', '/')
    $geoip6 = (Join-Path $torDir 'data\geoip6').Replace('\', '/')

    $torrcContent = "SocksPort 9060`nDataDirectory `"$torData`"`nLog notice stdout`nExcludeNodes {BR}`nStrictNodes 1`nFastFirstHopPK 1`n"
    if (Test-Path -LiteralPath (Join-Path $torDir 'data\geoip')) { $torrcContent += "GeoIPFile `"$geoip`"`n" }
    if (Test-Path -LiteralPath (Join-Path $torDir 'data\geoip6')) { $torrcContent += "GeoIPv6File `"$geoip6`"`n" }
    [IO.File]::WriteAllText($torrc, $torrcContent, [Text.Encoding]::ASCII)

    # Registra no registro do Windows do usuario para iniciar com o Windows silenciosamente
    try {
        $vbs = Join-Path $torDir 'GoLiveBypassTor.vbs'
        $innerCommand = "`"$torExe`" -f `"$torrc`"".Replace('"', '""')
        $vbsScript = "CreateObject(`"WScript.Shell`").Run `"$innerCommand`", 0, False"
        [IO.File]::WriteAllText($vbs, $vbsScript, [Text.Encoding]::Unicode)
        Set-ItemProperty -Path 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Run' -Name 'GoLiveBypassTor' -Value "wscript.exe `"$vbs`"" -ErrorAction SilentlyContinue
    } catch { }
}

$running = Get-Process tor -ErrorAction SilentlyContinue
if (-not $running -and (Test-Path -LiteralPath $torExe)) {
    Start-Process -FilePath $torExe -ArgumentList @('-f', $torrc) -WindowStyle Hidden
}

$client = New-Object System.Net.Sockets.TcpClient
$task = $client.ConnectAsync('127.0.0.1', 9060)
if ($task.Wait(2500) -and $client.Connected) {
    Write-Output "TOR_LISTENING_OK"
    $client.Close()
} else {
    Write-Output "TOR_NOT_READY"
}
