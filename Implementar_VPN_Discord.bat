@echo off
title Implementar VPN 1ms no Discord
cd /d "%~dp0"

echo ===================================================================
echo     IMPLEMENTAR VPN DE 1MS NO DISCORD (DESBLOQUEIO DE TELA)
echo ===================================================================
echo.
echo  - Roteia apenas o Discord por saida fora do Brasil na inicializacao.
echo  - Desbloqueia transmissao de tela ("Go Live") e camera.
echo  - Protecao 100% permanente: chamadas e transmissao com 1ms nativo direto!
echo  - Seu PC, jogos e navegadores continuam na sua internet normal.
echo.
echo ===================================================================
echo Fechando Discord e aplicando patch na pasta do app...
echo.

powershell -NoProfile -ExecutionPolicy Bypass -File "core\discord_vpn_manager.ps1" -Action Install

if %errorLevel% equ 0 (
    echo.
    echo ===================================================================
    echo   [SUCESSO] VPN de 1ms implementada com sucesso no Discord!
    echo   O Discord foi reaberto e a transmissao de tela esta liberada.
    echo ===================================================================
) else (
    echo.
    echo [ERRO] Ocorreu uma falha ao aplicar o patch no Discord.
)

echo.
pause
