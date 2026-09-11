@echo off
setlocal EnableDelayedExpansion
title Verificar Atualizacoes - VPNDS
cd /d "%~dp0"
chcp 65001 >nul

echo ===================================================================
echo               VERIFICADOR DE ATUALIZACOES - VPNDS
echo ===================================================================
echo.
echo Consultando o servidor GitHub para verificar novas versoes...
echo.

set "MANIFEST_URL=https://raw.githubusercontent.com/liljinbel/VPNDS/main/version.json"

powershell -NoProfile -ExecutionPolicy Bypass -Command ^
    "[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12 -bor [Net.SecurityProtocolType]::Tls11 -bor [Net.SecurityProtocolType]::Tls;" ^
    "$wc = New-Object System.Net.WebClient;" ^
    "$wc.Headers.Add('User-Agent', 'VPNDS-Check');" ^
    "$wc.Headers.Add('Cache-Control', 'no-cache');" ^
    "try {" ^
    "    $raw = $wc.DownloadString('%MANIFEST_URL%?t=' + [DateTime]::UtcNow.Ticks);" ^
    "    $obj = $raw | ConvertFrom-Json;" ^
    "    $cur = '1.1.0';" ^
    "    if (Test-Path 'version.json') { $curObj = Get-Content 'version.json' | ConvertFrom-Json; $cur = $curObj.version; }" ^
    "    Write-Host 'Versao local instalada:' $cur -ForegroundColor Cyan;" ^
    "    Write-Host 'Versao mais recente online:' $obj.version -ForegroundColor Green;" ^
    "    Write-Host '';" ^
    "    Write-Host 'Titulo:' $obj.title -ForegroundColor Yellow;" ^
    "    Write-Host 'Data:' $obj.releaseDate;" ^
    "    Write-Host 'Novidades:' -ForegroundColor Gray;" ^
    "    Write-Host $obj.changelog;" ^
    "    Write-Host '';" ^
    "    $vRem = [System.Version]($obj.version.TrimStart('v'));" ^
    "    $vCur = [System.Version]($cur.TrimStart('v'));" ^
    "    if ($vRem -gt $vCur) {" ^
    "        Write-Host '[AVISO] Nova versao disponivel para download!' -ForegroundColor Green;" ^
    "        exit 10;" ^
    "    } else {" ^
    "        Write-Host '[OK] Seu VPNDS ja esta na versao mais recente!' -ForegroundColor Cyan;" ^
    "        exit 0;" ^
    "    }" ^
    "} catch {" ^
    "    Write-Host '[ERRO] Nao foi possivel conectar ao GitHub para checar atualizacao:' $_.Exception.Message -ForegroundColor Red;" ^
    "    exit 1;" ^
    "}"

set "EXIT_CODE=%errorLevel%"

if "%EXIT_CODE%"=="10" (
    echo.
    echo ===================================================================
    echo  Deseja abrir o VPNDS para atualizar agora?
    echo ===================================================================
    set /p "RESP=Digite S para Sim ou N para Nao: "
    if /i "!RESP!"=="S" (
        start "" "%~dp0VPNDS.exe"
    )
)

echo.
pause
