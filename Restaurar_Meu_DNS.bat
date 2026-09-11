@echo off
title Restaurando DNS Original (192.168.0.113)
cd /d "%~dp0"

net session >nul 2>&1
if %errorLevel% neq 0 (
    powershell -NoProfile -ExecutionPolicy Bypass -Command "Start-Process '%~f0' -Verb RunAs"
    exit /b
)

echo ===================================================================
echo   DESATIVANDO VPN DE DNS - RESTAURANDO DNS PADRAO
echo ===================================================================
echo.
echo Restaurando DNS para 192.168.0.113...

powershell -NoProfile -ExecutionPolicy Bypass -Command "$a = Get-NetAdapter | Where-Object { $_.Status -eq 'Up' -and $_.InterfaceDescription -notmatch 'Tailscale|Virtual|Loopback|TAP|VPN' }; foreach ($i in $a) { Set-DnsClientServerAddress -InterfaceAlias $i.Name -ServerAddresses ('192.168.0.113') }; Clear-DnsClientCache"

echo.
echo [OK] DNS restaurado com sucesso para 192.168.0.113!
echo [OK] Cache DNS liberado.
echo.
timeout /t 3
