# Discord 1ms Native VPN Injector / Manager with Tor local SOCKS5 backend
param(
    [ValidateSet('Status', 'Install', 'Uninstall', 'AutoPatch')]
    [string]$Action = 'Status'
)

$ErrorActionPreference = 'Stop'
$localApp = [Environment]::GetFolderPath([Environment+SpecialFolder]::LocalApplicationData)
if (-not $localApp) { $localApp = Join-Path $env:USERPROFILE 'AppData\Local' }

$discordDir = Join-Path $localApp 'Discord'
$installDir = Join-Path $localApp 'GoLiveBypass'
$patcherDest = Join-Path $installDir 'golivebypass.js'
$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
if (-not $scriptDir) { $scriptDir = (Get-Location).Path }
$sourcePatcher = Join-Path $scriptDir 'discord_bypass.js'

$torDir = Join-Path $installDir 'Tor'
$torExe = Join-Path $torDir 'tor\tor.exe'
$torrc = Join-Path $torDir 'torrc'
$torPort = 9060

function Get-ActiveDiscordResources {
    if (-not (Test-Path -LiteralPath $discordDir)) { return @() }
    $appDirs = Get-ChildItem -Path $discordDir -Directory -Filter 'app-*' | Sort-Object Name -Descending
    $list = @()
    foreach ($d in $appDirs) {
        $res = Join-Path $d.FullName 'resources'
        if (Test-Path -LiteralPath $res) {
            $list += $res
        }
    }
    return $list
}

function Get-DiscordStatus {
    $resourcesList = Get-ActiveDiscordResources
    if ($resourcesList.Count -eq 0) { return "DiscordNotFound" }
    foreach ($res in $resourcesList) {
        $orig = Join-Path $res '_app.asar'
        $asar = Join-Path $res 'app.asar'
        if ((Test-Path -LiteralPath $orig) -and (Test-Path -LiteralPath (Join-Path $asar 'index.js'))) {
            return "Installed"
        }
    }
    return "NotInstalled"
}

function Close-Discord {
    $procs = Get-Process -Name 'Discord', 'DiscordPTB', 'DiscordCanary' -ErrorAction SilentlyContinue
    if ($procs) {
        $procs | Stop-Process -Force -ErrorAction SilentlyContinue
        Start-Sleep -Milliseconds 800
    }
}

function Start-Discord {
    $appDirs = Get-ChildItem -Path $discordDir -Directory -Filter 'app-*' | Sort-Object Name -Descending
    if ($appDirs.Count -gt 0) {
        $exe = Join-Path $appDirs[0].FullName 'Discord.exe'
        if (Test-Path -LiteralPath $exe) {
            Start-Process $exe
        }
    }
}

function Start-TorDaemon {
    $startScript = Join-Path $scriptDir 'start_tor.ps1'
    if (Test-Path -LiteralPath $startScript) {
        & powershell -NoProfile -ExecutionPolicy Bypass -File $startScript | Out-Null
    }
}

function Stop-TorDaemon {
    Get-Process tor -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue
}

function Patch-DiscordResources {
    if (-not (Test-Path -LiteralPath $installDir)) {
        New-Item -ItemType Directory -Path $installDir -Force | Out-Null
    }
    Copy-Item -LiteralPath $sourcePatcher -Destination $patcherDest -Force

    $srcTorrc = Join-Path $scriptDir 'torrc'
    if (Test-Path -LiteralPath $srcTorrc) {
        if (-not (Test-Path -LiteralPath $torDir)) {
            New-Item -ItemType Directory -Path $torDir -Force | Out-Null
        }
        Copy-Item -LiteralPath $srcTorrc -Destination (Join-Path $torDir 'torrc') -Force
    }

    $settingsPath = Join-Path $installDir 'settings.json'
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

    $resourcesList = Get-ActiveDiscordResources
    if ($resourcesList.Count -eq 0) {
        return $false
    }

    $packageJsonContent = '{"name":"discord","main":"index.js","version":"1.0.0"}'
    $indexJsContent = "require($($patcherDest | ConvertTo-Json));"

    foreach ($res in $resourcesList) {
        $asar = Join-Path $res 'app.asar'
        $orig = Join-Path $res '_app.asar'

        if (Test-Path -LiteralPath $orig) {
            if (Test-Path -LiteralPath $asar) {
                Remove-Item -LiteralPath $asar -Recurse -Force -ErrorAction SilentlyContinue
            }
        } else {
            if (Test-Path -LiteralPath $asar) {
                Rename-Item -LiteralPath $asar -NewName '_app.asar' -Force
            }
        }

        New-Item -ItemType Directory -Path $asar -Force | Out-Null
        [IO.File]::WriteAllText((Join-Path $asar 'package.json'), $packageJsonContent, [Text.Encoding]::UTF8)
        [IO.File]::WriteAllText((Join-Path $asar 'index.js'), $indexJsContent, [Text.Encoding]::UTF8)
    }
    return $true
}

if ($Action -eq 'Status') {
    $status = Get-DiscordStatus
    Write-Output $status
    exit 0
}

if ($Action -eq 'AutoPatch') {
    Start-TorDaemon
    $ok = Patch-DiscordResources
    if ($ok) {
        Write-Output "AutoPatchedSuccessfully"
    } else {
        Write-Output "DiscordNotFound"
    }
    exit 0
}

if ($Action -eq 'Install') {
    Close-Discord
    Start-TorDaemon
    $ok = Patch-DiscordResources
    if (-not $ok) {
        throw "Pasta de instalacao do Discord nao foi encontrada em $discordDir"
    }
    Write-Output "InstalledSuccessfully"
    Start-Discord
    exit 0
}

if ($Action -eq 'Uninstall') {
    Close-Discord
    Stop-TorDaemon
    $resourcesList = Get-ActiveDiscordResources
    foreach ($res in $resourcesList) {
        $asar = Join-Path $res 'app.asar'
        $orig = Join-Path $res '_app.asar'

        if (Test-Path -LiteralPath $orig) {
            if (Test-Path -LiteralPath $asar) {
                Remove-Item -LiteralPath $asar -Recurse -Force -ErrorAction SilentlyContinue
            }
            Rename-Item -LiteralPath $orig -NewName 'app.asar' -Force
        }
    }
    Write-Output "UninstalledSuccessfully"
    Start-Discord
    exit 0
}
