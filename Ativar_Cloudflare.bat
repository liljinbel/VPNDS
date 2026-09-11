@echo off
title Ativando Cloudflare DNS (1.1.1.1)
cd /d "%~dp0"

net session >nul 2>&1
if %errorLevel% neq 0 (
    powershell -NoProfile -ExecutionPolicy Bypass -Command "Start-Process '%~f0' -Verb RunAs"
    exit /b
)

echo ===================================================================
echo   ATIVANDO CLOUDFLARE DNS (1.1.1.1 e 1.0.0.1)
echo ===================================================================
echo.

powershell -NoProfile -ExecutionPolicy Bypass -Command "$a = Get-NetAdapter | Where-Object { $_.Status -eq 'Up' -and $_.InterfaceDescription -notmatch 'Tailscale|Virtual|Loopback|TAP|VPN' }; foreach ($i in $a) { Set-DnsClientServerAddress -InterfaceAlias $i.Name -ServerAddresses ('1.1.1.1', '1.0.0.1') }; Clear-DnsClientCache"

echo [OK] Cloudflare DNS ativado com sucesso!
echo [OK] Cache DNS liberado.
echo.
timeout /t 3
