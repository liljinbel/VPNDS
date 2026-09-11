@echo off
title Compilador - VPNDS
cd /d "%~dp0"

echo ===================================================================
echo   COMPILANDO VPNDS.exe COM ICONE EMBUTIDO
echo ===================================================================
echo.

set CSC="C:\Windows\Microsoft.NET\Framework64\v4.0.30319\csc.exe"
if not exist %CSC% (
    echo [ERRO] Compilador csc.exe nao encontrado em %CSC%
    pause
    exit /b
)

taskkill /F /IM VPNDS.exe >nul 2>&1
taskkill /F /IM VPN_de_DNS.exe >nul 2>&1
ping 127.0.0.1 -n 2 >nul

set ICON="app.ico"
if exist "app_vpnds.ico" set ICON="app_vpnds.ico"

if exist "VPNDS.exe" (
    if exist "VPNDS.old" del /f /q "VPNDS.old" >nul 2>&1
    move /y "VPNDS.exe" "VPNDS.old" >nul 2>&1
)

%CSC% /target:winexe /win32manifest:"app.manifest" /win32icon:%ICON% /r:"C:\Windows\Microsoft.NET\Framework64\v4.0.30319\WPF\PresentationFramework.dll" /r:"C:\Windows\Microsoft.NET\Framework64\v4.0.30319\WPF\PresentationCore.dll" /r:"C:\Windows\Microsoft.NET\Framework64\v4.0.30319\WPF\WindowsBase.dll" /r:"C:\Windows\Microsoft.NET\Framework64\v4.0.30319\System.Xaml.dll" /r:"System.dll" /r:"System.Core.dll" /r:"System.Xml.dll" /out:"VPNDS.exe" "DnsVpnPanel.cs"

if %errorLevel% equ 0 (
    echo.
    echo [SUCESSO] VPNDS.exe gerado com sucesso!
    if exist "VPN_de_DNS.exe" del /f /q "VPN_de_DNS.exe" >nul 2>&1
    if exist "VPNDS.old" del /f /q "VPNDS.old" >nul 2>&1
    if exist "VPN_de_DNS_v2.exe" del /f /q "VPN_de_DNS_v2.exe" >nul 2>&1
) else (
    echo.
    echo [FALHA] Ocorreu um erro durante a compilacao.
    if exist "VPNDS.old" move /y "VPNDS.old" "VPNDS.exe" >nul 2>&1
)

echo.
ping 127.0.0.1 -n 2 >nul
