@echo off
title Desligar VPN Discord
cd /d "%~dp0"

echo ===================================================================
echo     DESLIGAR VPN DISCORD
echo ===================================================================
echo.

set "LOCALAPP=%LOCALAPPDATA%"
if not exist "%LOCALAPP%\GoLiveBypass" mkdir "%LOCALAPP%\GoLiveBypass"
echo {"enabled":false,"routeMode":"tor","torAddr":"127.0.0.1:9060","proxy":"","excludedCountries":"BR","autoRevive":true} > "%LOCALAPP%\GoLiveBypass\settings.json"

powershell -NoProfile -ExecutionPolicy Bypass -Command "Stop-Process -Name tor -Force -ErrorAction SilentlyContinue"

echo [OK] VPN do Discord desativada.
echo [OK] Processo Tor finalizado (0%% de uso de RAM/CPU).
echo.
ping 127.0.0.1 -n 3 >nul
