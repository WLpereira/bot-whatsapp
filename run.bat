@echo off
chcp 65001 >nul
title Bot WhatsApp - Seu Atendente Automatico
color 0A
mode con: cols=80 lines=30
cls

echo.
echo ============================================================
echo        BOT WHATSAPP - SEU ATENDENTE AUTOMATICO
echo                     INICIANDO...
echo ============================================================
echo.
echo  Conectando ao WhatsApp Web...
echo  Aguarde 10-30 segundos...
echo  Um codigo QR vai aparecer abaixo
echo.

REM Usar Node.js que est  dentro da pasta nodejs
set NODE_PATH=%~dp0nodejs\node.exe

if exist "%NODE_PATH%" (
    echo  Node.js encontrado!
    echo.
    "%NODE_PATH%" index.js
) else (
    color 0C
    echo.
    echo  ERRO: Node.js nao encontrado!
    echo.
    echo  A pasta 'nodejs' nao existe.
    echo  Reinstale o pacote completo.
    echo.
)

echo.
echo  Bot encerrado.
echo.
pause