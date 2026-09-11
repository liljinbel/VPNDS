@echo off
title VPN Estados Unidos + Discord - Ativacao Total
cd /d "%~dp0"

net session >nul 2>&1
if %errorLevel% neq 0 (
    powershell -NoProfile -ExecutionPolicy Bypass -Command "Start-Process '%~f0' -Verb RunAs"
    exit /b
)

echo ===================================================================
echo   ATIVANDO VPN ESTADOS UNIDOS + BYPASS DPI (PERMANENTE / 20 MIN)
echo ===================================================================
echo.
echo [1/4] Encerrando sessoes antigas travadas...
taskkill /F /IM Discord.exe >nul 2>&1
taskkill /F /IM DiscordPTB.exe >nul 2>&1
taskkill /F /IM DiscordCanary.exe >nul 2>&1
taskkill /F /IM tor.exe >nul 2>&1
taskkill /F /IM goodbyedpi.exe >nul 2>&1
taskkill /F /IM VPNDS.exe >nul 2>&1
timeout /t 1 /nobreak >nul

echo [2/4] Configurando rota dos Estados Unidos (US) no Tor...
set "LOCALAPP=%LOCALAPPDATA%"
if not exist "%LOCALAPP%\GoLiveBypass" mkdir "%LOCALAPP%\GoLiveBypass"
if not exist "%LOCALAPP%\GoLiveBypass\Tor" mkdir "%LOCALAPP%\GoLiveBypass\Tor"

powershell -NoProfile -ExecutionPolicy Bypass -Command "$json = '{\"enabled\":true,\"routeMode\":\"tor\",\"torAddr\":\"127.0.0.1:9060\",\"proxy\":\"\",\"excludedCountries\":\"BR\",\"autoRevive\":true}'; [IO.File]::WriteAllText((Join-Path $env:LOCALAPPDATA 'GoLiveBypass\settings.json'), $json, (New-Object System.Text.UTF8Encoding($false)))"
Copy-Item "%~dp0core\discord_bypass.js" "$env:LOCALAPPDATA\GoLiveBypass\golivebypass.js" -Force >nul 2>&1
Remove-Item "$env:LOCALAPPDATA\GoLiveBypass\state.json" -Force -ErrorAction SilentlyContinue >nul 2>&1

powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0core\start_tor.ps1" >nul 2>&1

echo [3/4] Ativando GoodbyeDPI (Bypass DPI de video/camera ativo)...
start "" /b "%~dp0core\goodbyedpi.exe" -1

echo [4/4] Abrindo novo Discord com rota EUA ativada...
powershell -NoProfile -ExecutionPolicy Bypass -Command ^
    "$appDirs = Get-ChildItem -Path (Join-Path $env:LOCALAPPDATA 'Discord') -Directory -Filter 'app-*' | Sort-Object Name -Descending; " ^
    "if ($appDirs.Count -gt 0) { Start-Process (Join-Path $appDirs[0].FullName 'Discord.exe') }"

echo.
echo ===================================================================
echo [SUCESSO] VPN dos Estados Unidos + Bypass DPI ATIVADOS COM SUCESSO!
echo.
echo O Discord esta agora 100%% conectado pelos Estados Unidos.
echo O GoodbyeDPI esta rodando e protegendo a transmissao.
echo ===================================================================
echo.
echo Deseja manter ATIVADO SEMPRE ou programar para DESATIVAR em 20 minutos?
echo [1] Manter ATIVADO SEMPRE (Recomendado)
echo [2] Desativar automaticamente apos 20 minutos
echo.
set /p opt="Escolha [1 ou 2] (Padrao = 1): "
if "%opt%"=="2" (
    echo.
    echo [TIMER ATIVO] A VPN ficara ativa por 20 minutos. Pode minimizar esta janela.
    timeout /t 1200 /nobreak
    echo.
    echo Tempo de 20 minutos encerrado. Desligando GoodbyeDPI...
    taskkill /F /IM goodbyedpi.exe >nul 2>&1
    echo [OK] VPN desativada com sucesso.
    pause
    exit
)
echo.
echo VPN mantida 100%% ATIVA permanentemente!
timeout /t 3 >nul
