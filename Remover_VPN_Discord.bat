@echo off
title Remover VPN do Discord
cd /d "%~dp0"

echo ===================================================================
echo     REMOVER VPN DO DISCORD (VOLTAR AO PADRAO ORIGINAL)
echo ===================================================================
echo.
echo Fechando Discord e restaurando app.asar original...
echo.

powershell -NoProfile -ExecutionPolicy Bypass -File "core\discord_vpn_manager.ps1" -Action Uninstall

if %errorLevel% equ 0 (
    echo.
    echo ===================================================================
    echo   [SUCESSO] Discord restaurado para o padrao original com sucesso!
    echo ===================================================================
) else (
    echo.
    echo [ERRO] Ocorreu uma falha ao restaurar o Discord.
)

echo.
pause
