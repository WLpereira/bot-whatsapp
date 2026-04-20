@echo off
setlocal enabledelayedexpansion
chcp 65001 >nul
title Compilando Bot WhatsApp para EXE
color 0B
cls

echo.
echo ============================================================
echo        COMPILANDO BOT WHATSAPP PARA EXE
echo ============================================================
echo.
echo Verificando se pkg esta instalado...
echo.

where pkg >nul 2>nul
if !ERRORLEVEL! neq 0 (
    echo Instalando pkg globalmente...
    call npm install -g pkg
    echo.
)

echo.
echo Verificando instalacao do pkg...
pkg --version >nul 2>nul
if !ERRORLEVEL! neq 0 (
    color 0C
    echo ERRO: pkg nao funcionando
    echo Tente: npm install -g pkg
    pause
    exit /b 1
)

echo [OK] pkg instalado
echo.
echo Limpando build anterior...
if exist dist (
    echo   Removendo dist anterior...
    rmdir /s /q dist >nul 2>nul
)

echo.
echo Compilando com pkg...
echo Isto pode levar 5-15 minutos...
echo.

pkg . --targets node18-win-x64 --out-path dist --compress Brotli

if !ERRORLEVEL! neq 0 (
    color 0C
    echo.
    echo ERRO: Falha na compilacao
    echo.
    echo Tente novamente ou verifique:
    echo   - npm install (para instalar dependencias)
    echo   - Espaco em disco (minimo 2GB)
    echo.
    pause
    exit /b 1
)

if not exist dist\whatsapp-bot.exe (
    color 0C
    echo.
    echo ERRO: whatsapp-bot.exe nao foi criado
    echo.
    pause
    exit /b 1
)

echo.
color 0A
echo ============================================================
echo        COMPILACAO CONCLUIDA COM SUCESSO!
echo ============================================================
echo.
echo Arquivo criado: %CD%\dist\whatsapp-bot.exe
echo Tamanho aproximado: 100-150 MB
echo.
echo Proxima etapa: Execute prep-distribution.bat
echo.
pause
