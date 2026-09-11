@echo off
title Gerador de Pacote para Amigos - VPNDS
cd /d "%~dp0"

echo ===================================================================
echo     GERANDO PACOTE PROFISSIONAL DO VPNDS PARA AMIGOS (.ZIP)
echo ===================================================================
echo.

set CSC="C:\Windows\Microsoft.NET\Framework64\v4.0.30319\csc.exe"
if not exist %CSC% (
    echo [ERRO] Compilador csc.exe nao encontrado em %CSC%
    pause
    exit /b
)

echo [1/4] Compilando VPNDS.exe atualizado...
call Compilar.bat >nul 2>&1

echo [2/4] Compilando Instalador_VPNDS.exe com tema Vidro Fosco...
%CSC% /target:winexe /win32manifest:"app.manifest" /win32icon:"app_vpnds.ico" /r:"C:\Windows\Microsoft.NET\Framework64\v4.0.30319\WPF\PresentationFramework.dll" /r:"C:\Windows\Microsoft.NET\Framework64\v4.0.30319\WPF\PresentationCore.dll" /r:"C:\Windows\Microsoft.NET\Framework64\v4.0.30319\WPF\WindowsBase.dll" /r:"C:\Windows\Microsoft.NET\Framework64\v4.0.30319\System.Xaml.dll" /r:"C:\Windows\Microsoft.NET\Framework64\v4.0.30319\System.Windows.Forms.dll" /r:"System.dll" /r:"System.Core.dll" /r:"System.Xml.dll" /out:"Instalador_VPNDS.exe" "SetupWizard.cs" >nul 2>&1

echo [3/4] Montando pasta de distribuicao limpa...
if exist "VPNDS_Instalador" rd /s /q "VPNDS_Instalador"
mkdir "VPNDS_Instalador"
mkdir "VPNDS_Instalador\core"

copy /y "Instalador_VPNDS.exe" "VPNDS_Instalador\" >nul
copy /y "VPNDS.exe" "VPNDS_Instalador\" >nul
copy /y "app_vpnds.ico" "VPNDS_Instalador\" >nul
copy /y "config.json" "VPNDS_Instalador\" >nul
copy /y "LEIA_ME.txt" "VPNDS_Instalador\" >nul
copy /y "*.bat" "VPNDS_Instalador\" >nul
xcopy /e /i /y "core" "VPNDS_Instalador\core" >nul

echo [4/4] Criando arquivo zip VPNDS_Instalador.zip...
if exist "VPNDS_Instalador.zip" del /f /q "VPNDS_Instalador.zip"
tar.exe -caf "VPNDS_Instalador.zip" "VPNDS_Instalador" >nul 2>&1
if not exist "VPNDS_Instalador.zip" (
    powershell -Command "Compress-Archive -Path 'VPNDS_Instalador' -DestinationPath 'VPNDS_Instalador.zip' -Force"
)

echo.
echo ===================================================================
echo [SUCESSO] Pacote gerado com sucesso!
if exist "VPN_de_DNS.exe" del /f /q "VPN_de_DNS.exe" >nul 2>&1
if exist "VPN_de_DNS_v2.exe" del /f /q "VPN_de_DNS_v2.exe" >nul 2>&1
echo.
echo Arquivos prontos para enviar aos seus amigos:
echo 1. Pasta:  VPNDS_Instalador\
echo 2. Zip:    VPNDS_Instalador.zip
echo.
echo Seus amigos so precisam abrir o 'Instalador_VPNDS.exe' e clicar Next!
echo ===================================================================
echo.
ping 127.0.0.1 -n 3 >nul
