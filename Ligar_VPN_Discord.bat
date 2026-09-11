@echo off
title Ligar VPN Discord - Destravar Camera e Tela (EUA)
cd /d "%~dp0"

net session >nul 2>&1
if %errorLevel% neq 0 (
    powershell -NoProfile -ExecutionPolicy Bypass -Command "Start-Process '%~f0' -Verb RunAs"
    exit /b
)

echo ===================================================================
echo     LIGAR VPN DISCORD (ROTA ESTADOS UNIDOS + BYPASS DPI 1MS)
echo ===================================================================
echo.

set "LOCALAPP=%LOCALAPPDATA%"
if not exist "%LOCALAPP%\GoLiveBypass" mkdir "%LOCALAPP%\GoLiveBypass"
powershell -NoProfile -ExecutionPolicy Bypass -Command "$json = '{\"enabled\":true,\"routeMode\":\"tor\",\"torAddr\":\"127.0.0.1:9060\",\"proxy\":\"\",\"excludedCountries\":\"BR\",\"autoRevive\":true}'; [IO.File]::WriteAllText((Join-Path $env:LOCALAPPDATA 'GoLiveBypass\settings.json'), $json, (New-Object System.Text.UTF8Encoding($false)))"

echo [1/3] Sincronizando scripts e iniciando Tor (Estados Unidos)...
taskkill /F /IM tor.exe >nul 2>&1
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0core\start_tor.ps1" >nul 2>&1

echo [2/3] Ativando GoodbyeDPI (Bypass DPI de video/camera)...
taskkill /F /IM goodbyedpi.exe >nul 2>&1
$gdpi = "%~dp0core\goodbyedpi.exe"
if exist "%~dp0core\goodbyedpi.exe" (
    powershell -NoProfile -ExecutionPolicy Bypass -Command "Start-Process -FilePath '%~dp0core\goodbyedpi.exe' -ArgumentList '-1' -WorkingDirectory '%~dp0core' -WindowStyle Hidden"
)

echo [3/3] Reiniciando Discord para carregar com IP dos Estados Unidos...
taskkill /F /IM Discord.exe >nul 2>&1
taskkill /F /IM DiscordPTB.exe >nul 2>&1
taskkill /F /IM DiscordCanary.exe >nul 2>&1
timeout /t 1 /nobreak >nul

powershell -NoProfile -ExecutionPolicy Bypass -Command ^
    "$appDirs = Get-ChildItem -Path (Join-Path $env:LOCALAPPDATA 'Discord') -Directory -Filter 'app-*' | Sort-Object Name -Descending; " ^
    "if ($appDirs.Count -gt 0) { Start-Process (Join-Path $appDirs[0].FullName 'Discord.exe') }"

echo.
echo ===================================================================
echo [OK] VPN Ativada! Rota: ESTADOS UNIDOS (US)
echo [OK] Bypass DPI Ativo (GoodbyeDPI 1ms nativo)
echo [OK] Discord aberto e desbloqueado!
echo ===================================================================
echo.
timeout /t 3 >nul
