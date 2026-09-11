@echo off
title Ligar VPN Leve - Bypass DPI
cd /d "%~dp0"

net session >nul 2>&1
if %errorLevel% neq 0 (
    powershell -NoProfile -ExecutionPolicy Bypass -Command "Start-Process '%~f0' -Verb RunAs"
    exit /b
)

echo ===================================================================
echo     LIGAR VPN LEVE (BYPASS DPI - GOODBYEDPI 1MS)
echo ===================================================================
echo.

powershell -NoProfile -ExecutionPolicy Bypass -Command ^
    "$running = Get-Process goodbyedpi -ErrorAction SilentlyContinue; " ^
    "if (-not $running) { " ^
    "    $psi = New-Object System.Diagnostics.ProcessStartInfo; " ^
    "    $psi.FileName = (Join-Path (Get-Location).Path 'core\goodbyedpi.exe'); " ^
    "    $psi.Arguments = '-1'; " ^
    "    $psi.WorkingDirectory = (Join-Path (Get-Location).Path 'core'); " ^
    "    $psi.WindowStyle = [System.Diagnostics.ProcessWindowStyle]::Hidden; " ^
    "    $psi.CreateNoWindow = $true; " ^
    "    $psi.UseShellExecute = $false; " ^
    "    [System.Diagnostics.Process]::Start($psi) | Out-Null; " ^
    "}"

echo [OK] VPN Leve (Bypass DPI) Ativada com Sucesso! (1ms nativo)
echo.
ping 127.0.0.1 -n 3 >nul
