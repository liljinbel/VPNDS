@echo off
title Desligar VPN Leve - Bypass DPI
cd /d "%~dp0"

net session >nul 2>&1
if %errorLevel% neq 0 (
    powershell -NoProfile -ExecutionPolicy Bypass -Command "Start-Process '%~f0' -Verb RunAs"
    exit /b
)

echo ===================================================================
echo     DESLIGAR VPN LEVE (BYPASS DPI)
echo ===================================================================
echo.

powershell -NoProfile -ExecutionPolicy Bypass -Command ^
    "Get-Process goodbyedpi -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue; " ^
    "taskkill /F /IM goodbyedpi.exe >nul 2>&1"

echo [OK] VPN Leve Desligada.
echo.
ping 127.0.0.1 -n 3 >nul
