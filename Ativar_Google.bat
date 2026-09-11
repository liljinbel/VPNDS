@echo off
title Ativando Google DNS (8.8.8.8)
cd /d "%~dp0"

net session >nul 2>&1
if %errorLevel% neq 0 (
    powershell -NoProfile -ExecutionPolicy Bypass -Command "Start-Process '%~f0' -Verb RunAs"
    exit /b
)

echo ===================================================================
echo   ATIVANDO GOOGLE PUBLIC DNS (8.8.8.8 e 8.8.4.4)
echo ===================================================================
echo.

powershell -NoProfile -ExecutionPolicy Bypass -Command "$a = Get-NetAdapter | Where-Object { $_.Status -eq 'Up' -and $_.InterfaceDescription -notmatch 'Tailscale|Virtual|Loopback|TAP|VPN' }; foreach ($i in $a) { Set-DnsClientServerAddress -InterfaceAlias $i.Name -ServerAddresses ('8.8.8.8', '8.8.4.4') }; Clear-DnsClientCache"

echo [OK] Google Public DNS ativado com sucesso!
echo [OK] Cache DNS liberado.
echo.
timeout /t 3
