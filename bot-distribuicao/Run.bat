@echo off
chcp 65001 >nul
title Bot WhatsApp - Com Limpeza Automatica
color 0B
cls

echo.
echo ============================================================
echo        BOT WHATSAPP - SEU ATENDENTE AUTOMATICO
echo                     INICIANDO...
echo ============================================================
echo.

REM Verificar se porta 3000 esta em uso
for /f "tokens=5" %%a in ('netstat -ano ^| findstr :3000 ^| findstr LISTENING') do (
    echo Porta 3000 ja esta em uso. Matando processo anterior...
    taskkill /PID %%a /F >nul 2>&1
    timeout /t 2 /nobreak >nul
)

echo.
echo Conectando ao WhatsApp Web...
echo Aguarde 10-30 segundos...
echo Um codigo QR vai aparecer abaixo
echo.

REM Executar o bot
cd /d "%~dp0"
whatsapp-bot.exe

echo.
echo Bot encerrado.
echo.
pause
