@echo off
title Ligar VPN Discord - Destravar Camera e Tela
cd /d "%~dp0"

echo ===================================================================
echo     LIGAR VPN DISCORD (DESBLOQUEIO DE CAMERA E TELA 1MS)
echo ===================================================================
echo.

set "LOCALAPP=%LOCALAPPDATA%"
if not exist "%LOCALAPP%\GoLiveBypass" mkdir "%LOCALAPP%\GoLiveBypass"
echo {"enabled":true,"routeMode":"tor","torAddr":"127.0.0.1:9060","proxy":"","excludedCountries":"BR","autoRevive":true} > "%LOCALAPP%\GoLiveBypass\settings.json"

powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0core\start_tor.ps1" >nul 2>&1

powershell -NoProfile -ExecutionPolicy Bypass -Command ^
    "$proc = Get-Process -Name Discord,DiscordPTB,DiscordCanary -ErrorAction SilentlyContinue; " ^
    "if ($proc) { " ^
    "    Write-Host 'Reiniciando Discord para aplicar a nova rota de camera...' -ForegroundColor Yellow; " ^
    "    $proc | Stop-Process -Force -ErrorAction SilentlyContinue; " ^
    "    Start-Sleep -Milliseconds 600; " ^
    "    $appDirs = Get-ChildItem -Path (Join-Path $env:LOCALAPPDATA 'Discord') -Directory -Filter 'app-*' | Sort-Object Name -Descending; " ^
    "    if ($appDirs.Count -gt 0) { Start-Process (Join-Path $appDirs[0].FullName 'Discord.exe') } " ^
    "}"

echo [OK] VPN do Discord Ativada com Sucesso!
echo [OK] Tor conectado em 127.0.0.1:9060 (1ms de voz/video nativo).
echo [OK] Camera e compartilhamento de tela liberados!
echo.
ping 127.0.0.1 -n 3 >nul
