$ErrorActionPreference = 'SilentlyContinue'

Write-Host "Fechando Discord e Tor..." -ForegroundColor Yellow
Get-Process Discord, DiscordPTB, DiscordCanary, tor -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue
Start-Sleep -Milliseconds 1200

$localApp = [Environment]::GetFolderPath([Environment+SpecialFolder]::LocalApplicationData)
if (-not $localApp) { $localApp = Join-Path $env:USERPROFILE 'AppData\Local' }

$glbDir = Join-Path $localApp 'GoLiveBypass'
if (-not (Test-Path -LiteralPath $glbDir)) {
    New-Item -ItemType Directory -Path $glbDir -Force | Out-Null
}

$targetJs = Join-Path $glbDir 'golivebypass.js'
$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
if (-not $scriptDir) { $scriptDir = (Get-Location).Path }
$sourceJs = Join-Path $scriptDir 'discord_bypass.js'

Write-Host "Copiando discord_bypass.js atualizado para $targetJs..." -ForegroundColor Cyan
Copy-Item -LiteralPath $sourceJs -Destination $targetJs -Force

Write-Host "Gravando settings.json sem BOM..." -ForegroundColor Cyan
$settingsPath = Join-Path $glbDir 'settings.json'
$settingsJson = @'
{
  "enabled": true,
  "routeMode": "tor",
  "torAddr": "127.0.0.1:9060",
  "proxy": "",
  "excludedCountries": "BR",
  "autoRevive": true
}
'@
$utf8NoBom = New-Object System.Text.UTF8Encoding($false)
[IO.File]::WriteAllText($settingsPath, $settingsJson, $utf8NoBom)

Write-Host "Iniciando Tor configurado..." -ForegroundColor Cyan
$startTor = Join-Path $scriptDir 'start_tor.ps1'
& powershell -NoProfile -ExecutionPolicy Bypass -File $startTor

Write-Host "Iniciando GoodbyeDPI (Bypass DPI de video/camera)..." -ForegroundColor Cyan
Get-Process goodbyedpi -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue
$gdpiExe = Join-Path $scriptDir 'goodbyedpi.exe'
if (Test-Path -LiteralPath $gdpiExe) {
    Start-Process -FilePath $gdpiExe -ArgumentList '-1' -WorkingDirectory $scriptDir -WindowStyle Hidden
}

Write-Host "Iniciando Discord..." -ForegroundColor Green
$discordDir = Join-Path $localApp 'Discord'
$appDirs = Get-ChildItem -Path $discordDir -Directory -Filter 'app-*' | Sort-Object Name -Descending
if ($appDirs.Count -gt 0) {
    $exe = Join-Path $appDirs[0].FullName 'Discord.exe'
    if (Test-Path -LiteralPath $exe) {
        Start-Process $exe
    }
}

Write-Host "[SUCESSO] Sistema sincronizado, Tor 9060 ativo, GoodbyeDPI ativo e Discord reiniciado!" -ForegroundColor Green
