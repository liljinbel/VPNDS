@echo off
title Reiniciar Discord Rapido - Destravar Camera
cd /d "%~dp0"

:: Verificar se esta como Administrador para fechar processos do Discord sem erro de permissao
net session >nul 2>&1
if %errorLevel% neq 0 (
    powershell -NoProfile -ExecutionPolicy Bypass -Command "Start-Process '%~f0' -Verb RunAs"
    exit /b
)

echo ===================================================================
echo     REINICIAR DISCORD RAPIDO (DESTRAVAR CAMERA E TRANSMISSAO)
echo ===================================================================
echo.
echo [1/3] Encerrando processos antigos (Discord, Tor, GoodbyeDPI)...
taskkill /F /IM Discord.exe >nul 2>&1
taskkill /F /IM DiscordPTB.exe >nul 2>&1
taskkill /F /IM DiscordCanary.exe >nul 2>&1
taskkill /F /IM tor.exe >nul 2>&1
taskkill /F /IM goodbyedpi.exe >nul 2>&1
timeout /t 1 /nobreak >nul

echo [2/3] Aplicando sincronizacao dos scripts e iniciando Tor 9060...
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0core\aplicar_correcao_camera.ps1"

echo.
echo [3/3] Concluido com sucesso!
echo ===================================================================
timeout /t 3 >nul

