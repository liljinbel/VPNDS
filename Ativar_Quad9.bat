@echo off
title Ativando Quad9 DNS (9.9.9.9)
cd /d "%~dp0"

net session >nul 2>&1
if %errorLevel% neq 0 (
    powershell -NoProfile -ExecutionPolicy Bypass -Command "Start-Process '%~f0' -Verb RunAs"
    exit /b
)

echo ===================================================================
echo   ATIVANDO QUAD9 SECURITY DNS (9.9.9.9 e 149.112.112.112)
echo ===================================================================
echo.

powershell -NoProfile -ExecutionPolicy Bypass -Command "$a = Get-NetAdapter | Where-Object { $_.Status -eq 'Up' -and $_.InterfaceDescription -notmatch 'Tailscale|Virtual|Loopback|TAP|VPN' }; foreach ($i in $a) { Set-DnsClientServerAddress -InterfaceAlias $i.Name -ServerAddresses ('9.9.9.9', '149.112.112.112') }; Clear-DnsClientCache"

echo [OK] Quad9 Security DNS ativado com sucesso!
echo [OK] Cache DNS liberado.
echo.
timeout /t 3
