@echo off
setlocal EnableDelayedExpansion
title VPNDS - Controle Rapido
cd /d "%~dp0"

:: Verificar se esta executando como Administrador
net session >nul 2>&1
if %errorLevel% neq 0 (
    echo Solicitando privilegios de Administrador...
    powershell -NoProfile -ExecutionPolicy Bypass -Command "Start-Process '%~f0' -Verb RunAs"
    exit /b
)

:MENU
cls
echo ===================================================================
echo                        VPNDS - CONTROLE RAPIDO
echo ===================================================================

:: Obter DNS atual via PowerShell
for /f "usebackq delims=" %%i in (`powershell -NoProfile -Command "$a = Get-NetAdapter | Where-Object { $_.Status -eq 'Up' -and $_.InterfaceDescription -notmatch 'Tailscale|Virtual|Loopback|TAP|VPN' } | Select-Object -First 1; if ($a) { $d = (Get-DnsClientServerAddress -InterfaceAlias $a.Name -AddressFamily IPv4).ServerAddresses -join ', '; Write-Output \"$($a.Name): $d\" } else { Write-Output 'Nenhum' }"`) do (
    set "CURRENT_INFO=%%i"
)

echo  Placa e DNS Atuais: !CURRENT_INFO!
echo ===================================================================
echo.
echo  [1] Ativar Cloudflare  (1.1.1.1 e 1.0.0.1)      - Ultra rapido
echo  [2] Ativar Google      (8.8.8.8 e 8.8.4.4)      - Global / Estavel
echo  [3] Ativar Quad9       (9.9.9.9 e 149.112.112)  - Foco em Seguranca
echo  [4] Ativar OpenDNS     (208.67.222.222 / 220)   - Protecao Familiar
echo  [5] Ativar AdGuard     (94.140.14.14 / 15)      - Bloqueia Anuncios
echo  -----------------------------------------------------------------
echo  [D] LIGAR VPN Discord (Desbloquear Camera e Tela)
echo  [E] LIGAR VPN Estados Unidos + Discord (Sempre Ativa ou Timer 20 min)
echo  [X] DESLIGAR VPN Discord
echo  [K] REINICIAR Discord Rapido (Destravar Camera/Chamada)
echo  -----------------------------------------------------------------
echo  [B] Ligar VPN Leve (Bypass DPI GoodbyeDPI 1ms)
echo  [N] Desligar VPN Leve (Bypass DPI)
echo  -----------------------------------------------------------------
echo  [R] Desinstalar VPN do Discord (Voltar 100%% ao Original)
echo  [0] DESATIVAR e Voltar para meu DNS (192.168.0.113)
echo  -----------------------------------------------------------------
echo  [U] Verificar se ha Atualizacoes (Auto-Update)
echo  [P] Publicar Atualizacao no GitHub (Dev)
echo  -----------------------------------------------------------------
echo  [V] Abrir Aplicativo Visual (Interface Grafica)
echo  [S] Sair
echo.
echo ===================================================================
set /p "OPC=Digite sua opcao e pressione Enter: "

if /i "%OPC%"=="1" goto CLOUDFLARE
if /i "%OPC%"=="2" goto GOOGLE
if /i "%OPC%"=="3" goto QUAD9
if /i "%OPC%"=="4" goto OPENDNS
if /i "%OPC%"=="5" goto ADGUARD
if /i "%OPC%"=="D" goto DISCORD_LIGAR
if /i "%OPC%"=="E" goto DISCORD_LIGAR_EUA
if /i "%OPC%"=="X" goto DISCORD_DESLIGAR
if /i "%OPC%"=="K" goto DISCORD_RESTART
if /i "%OPC%"=="B" goto DPI_LIGAR
if /i "%OPC%"=="N" goto DPI_DESLIGAR
if /i "%OPC%"=="R" goto DISCORD_UNINSTALL
if /i "%OPC%"=="0" goto RESTAURAR
if /i "%OPC%"=="U" goto CHECK_UPDATE
if /i "%OPC%"=="P" goto PUBLISH_UPDATE
if /i "%OPC%"=="V" goto VISUAL
if /i "%OPC%"=="S" exit /b
goto MENU

:CLOUDFLARE
echo.
echo Aplicando Cloudflare DNS (1.1.1.1, 1.0.0.1)...
powershell -NoProfile -Command "$a = Get-NetAdapter | Where-Object { $_.Status -eq 'Up' -and $_.InterfaceDescription -notmatch 'Tailscale|Virtual|Loopback|TAP|VPN' }; foreach ($i in $a) { Set-DnsClientServerAddress -InterfaceAlias $i.Name -ServerAddresses ('1.1.1.1', '1.0.0.1') }; Clear-DnsClientCache"
echo DNS Cloudflare Ativado com sucesso!
timeout /t 2 >nul
goto MENU

:GOOGLE
echo.
echo Aplicando Google Public DNS (8.8.8.8, 8.8.4.4)...
powershell -NoProfile -Command "$a = Get-NetAdapter | Where-Object { $_.Status -eq 'Up' -and $_.InterfaceDescription -notmatch 'Tailscale|Virtual|Loopback|TAP|VPN' }; foreach ($i in $a) { Set-DnsClientServerAddress -InterfaceAlias $i.Name -ServerAddresses ('8.8.8.8', '8.8.4.4') }; Clear-DnsClientCache"
echo DNS Google Ativado com sucesso!
timeout /t 2 >nul
goto MENU

:QUAD9
echo.
echo Aplicando Quad9 Security DNS (9.9.9.9, 149.112.112.112)...
powershell -NoProfile -Command "$a = Get-NetAdapter | Where-Object { $_.Status -eq 'Up' -and $_.InterfaceDescription -notmatch 'Tailscale|Virtual|Loopback|TAP|VPN' }; foreach ($i in $a) { Set-DnsClientServerAddress -InterfaceAlias $i.Name -ServerAddresses ('9.9.9.9', '149.112.112.112') }; Clear-DnsClientCache"
echo DNS Quad9 Ativado com sucesso!
timeout /t 2 >nul
goto MENU

:OPENDNS
echo.
echo Aplicando OpenDNS Cisco (208.67.222.222, 208.67.220.220)...
powershell -NoProfile -Command "$a = Get-NetAdapter | Where-Object { $_.Status -eq 'Up' -and $_.InterfaceDescription -notmatch 'Tailscale|Virtual|Loopback|TAP|VPN' }; foreach ($i in $a) { Set-DnsClientServerAddress -InterfaceAlias $i.Name -ServerAddresses ('208.67.222.222', '208.67.220.220') }; Clear-DnsClientCache"
echo DNS OpenDNS Ativado com sucesso!
timeout /t 2 >nul
goto MENU

:ADGUARD
echo.
echo Aplicando AdGuard DNS (94.140.14.14, 94.140.15.15)...
powershell -NoProfile -Command "$a = Get-NetAdapter | Where-Object { $_.Status -eq 'Up' -and $_.InterfaceDescription -notmatch 'Tailscale|Virtual|Loopback|TAP|VPN' }; foreach ($i in $a) { Set-DnsClientServerAddress -InterfaceAlias $i.Name -ServerAddresses ('94.140.14.14', '94.140.15.15') }; Clear-DnsClientCache"
echo DNS AdGuard Ativado com sucesso!
timeout /t 2 >nul
goto MENU

:RESTAURAR
echo.
echo Restaurando para o seu DNS Original (192.168.0.113)...
powershell -NoProfile -Command "$a = Get-NetAdapter | Where-Object { $_.Status -eq 'Up' -and $_.InterfaceDescription -notmatch 'Tailscale|Virtual|Loopback|TAP|VPN' }; foreach ($i in $a) { Set-DnsClientServerAddress -InterfaceAlias $i.Name -ServerAddresses ('192.168.0.113') }; Clear-DnsClientCache"
echo Seu DNS Original (192.168.0.113) foi restaurado com sucesso!
timeout /t 2 >nul
goto MENU

:DISCORD_LIGAR
echo.
call "%~dp0Ligar_VPN_Discord.bat"
goto MENU

:DISCORD_LIGAR_EUA
echo.
call "%~dp0Ligar_VPN_EUA_Discord.bat"
goto MENU

:DISCORD_DESLIGAR
echo.
call "%~dp0Desligar_VPN_Discord.bat"
goto MENU

:DISCORD_RESTART
echo.
call "%~dp0Reiniciar_Discord_Rapido.bat"
goto MENU

:DPI_LIGAR
echo.
call "%~dp0Ligar_VPN_BypassDPI.bat"
goto MENU

:DPI_DESLIGAR
echo.
call "%~dp0Desligar_VPN_BypassDPI.bat"
goto MENU

:DISCORD_INSTALL
echo.
echo ===================================================================
echo   IMPLEMENTANDO VPN DE 1MS NO DISCORD (DESBLOQUEIO DE TELA)
echo ===================================================================
echo Fechando Discord e aplicando desbloqueio permanente de tela e camera...
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0core\discord_vpn_manager.ps1" -Action Install
echo.
echo VPN de 1ms implementada com sucesso no Discord!
echo O Discord foi reaberto e a transmissao de tela esta liberada.
timeout /t 3 >nul
goto MENU

:DISCORD_UNINSTALL
echo.
echo ===================================================================
echo   REMOVENDO VPN DO DISCORD (VOLTANDO AO PADRAO)
echo ===================================================================
echo Fechando Discord e restaurando instalacao original...
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0core\discord_vpn_manager.ps1" -Action Uninstall
echo.
echo Discord restaurado com sucesso!
timeout /t 3 >nul
goto MENU

:VISUAL
if exist "%~dp0VPNDS.exe" (
    start "" "%~dp0VPNDS.exe"
) else if exist "%~dp0VPN_de_DNS.exe" (
    start "" "%~dp0VPN_de_DNS.exe"
)
goto MENU

:CHECK_UPDATE
if exist "%~dp0Verificar_Atualizacoes.bat" (
    call "%~dp0Verificar_Atualizacoes.bat"
)
goto MENU

:PUBLISH_UPDATE
if exist "%~dp0Publicar_Atualizacao.bat" (
    call "%~dp0Publicar_Atualizacao.bat"
)
goto MENU
