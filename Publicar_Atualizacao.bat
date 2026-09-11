@echo off
setlocal EnableDelayedExpansion
title Publicador de Atualizacoes - VPNDS
cd /d "%~dp0"
chcp 65001 >nul

echo ===================================================================
echo           PUBLICADOR DE ATUALIZAÇÕES GLOBAIS - VPNDS
echo ===================================================================
echo  Este script compila a nova versão, empacota o instalador e
echo  publica tudo diretamente no GitHub.
echo.
echo  Quando publicado, TODOS os usuarios com o VPNDS instalado receberao
echo  o aviso em tempo real: "NOVA VERSAO DISPONIVEL" e poderao atualizar
echo  com 1 clique!
echo ===================================================================
echo.

:: Obter versao atual de version.json
for /f "usebackq tokens=2 delims=:, " %%a in (`powershell -NoProfile -Command "(Get-Content version.json | ConvertFrom-Json).version"`) do (
    set "OLD_VER=%%a"
)
if "%OLD_VER%"=="" set "OLD_VER=1.1.0"
echo Versao atual instalada: v%OLD_VER%
echo.

set "NEW_VER=%~1"
if "%NEW_VER%"=="" (
    set /p "NEW_VER=Digite a NOVA versao (ex: 1.2.0): "
)
if "%NEW_VER%"=="" (
    echo [ERRO] Versao nao pode ser vazia! Operacao cancelada.
    pause
    exit /b 1
)

set "NEW_TITLE=%~2"
if "%NEW_TITLE%"=="" (
    set /p "NEW_TITLE=Digite o Titulo/Destaque da versao (ou Enter para padrao): "
)
if "%NEW_TITLE%"=="" (
    set "NEW_TITLE=VPNDS v%NEW_VER% - Atualizacoes e Melhorias de Conexao"
)

set "NEW_LOG=%~3"
if "%NEW_LOG%"=="" (
    set /p "NEW_LOG=Digite as Novidades (ou Enter para padrao): "
)
if "%NEW_LOG%"=="" (
    set "NEW_LOG=- Otimizacoes no sistema de bypass e conexao 1ms\n- Atualizacoes de estabilidade e novas rotas de DNS"
)

echo.
echo ===================================================================
echo  [1/5] Atualizando versao nos fontes e version.json...
echo ===================================================================

powershell -NoProfile -ExecutionPolicy Bypass -Command ^
    "$date = (Get-Date).ToString('yyyy-MM-dd');" ^
    "$jsonObj = [PSCustomObject]@{" ^
    "    version = '%NEW_VER%';" ^
    "    releaseDate = $date;" ^
    "    title = '%NEW_TITLE%';" ^
    "    changelog = '%NEW_LOG%';" ^
    "    downloadUrl = 'https://raw.githubusercontent.com/liljinbel/VPNDS/main/VPNDS.exe';" ^
    "    packageUrl = 'https://raw.githubusercontent.com/liljinbel/VPNDS/main/VPNDS_Instalador.zip'" ^
    "};" ^
    "$jsonObj | ConvertTo-Json -Depth 4 | Set-Content -Path 'version.json' -Encoding UTF8;" ^
    "$cs = Get-Content 'DnsVpnPanel.cs' -Raw;" ^
    "$cs = $cs -replace 'public const string CURRENT_VERSION = \"\"[^\"]+\"\";', 'public const string CURRENT_VERSION = \"\"%NEW_VER%\"\";';" ^
    "Set-Content -Path 'DnsVpnPanel.cs' -Value $cs -Encoding UTF8;"

echo [OK] version.json e DnsVpnPanel.cs atualizados para v%NEW_VER%!

echo.
echo ===================================================================
echo  [2/5] Compilando novo executavel VPNDS.exe...
echo ===================================================================
call Compilar.bat
if not exist "VPNDS.exe" (
    echo [ERRO] Falha ao compilar VPNDS.exe! Abortando publicacao.
    pause
    exit /b 1
)

echo.
echo ===================================================================
echo  [3/5] Gerando instalador e pacote VPNDS_Instalador.zip...
echo ===================================================================
call Criar_Pacote_Amigos.bat
if not exist "VPNDS_Instalador.zip" (
    echo [ERRO] Falha ao gerar VPNDS_Instalador.zip!
    pause
    exit /b 1
)

echo.
echo ===================================================================
echo  [4/5] Enviando atualizacao para o repositorio GitHub...
echo ===================================================================

git add version.json DnsVpnPanel.cs VPNDS.exe Instalador_VPNDS.exe VPNDS_Instalador.zip .gitignore *.bat core/ 2>nul
git add -A
git commit -m "Publicada versao v%NEW_VER%: %NEW_TITLE%"
git branch -M main
git push -u origin main

if %errorLevel% equ 0 (
    echo.
    echo ===================================================================
    echo  [SUCESSO ABSOLUTO] VPNDS v%NEW_VER% PUBLICADO NO GITHUB!
    echo ===================================================================
    echo.
    echo  Todos os clientes e amigos que tiverem o VPNDS no PC agora verao:
    echo  - O aviso azul "NOVA VERSAO DISPONIVEL (v%NEW_VER%)"
    echo  - O botao "ATUALIZAR AGORA" que baixa e reinicia sozinho!
    echo.
    echo ===================================================================
) else (
    echo.
    echo [AVISO] O 'git push' retornou um codigo de atencao.
    echo Verifique suas credenciais do GitHub ou rode 'git push origin main'.
)

echo.
pause
