@echo off
chcp 65001 >nul
title Preparando Distribuicao do Bot
color 0B
cls

echo.
echo ============================================================
echo        PREPARANDO DISTRIBUICAO DO BOT
echo ============================================================
echo.

if not exist dist\whatsapp-bot.exe (
    color 0C
    echo ERRO: whatsapp-bot.exe nao encontrado em dist\
    echo.
    echo Execute build-exe.bat primeiro!
    echo.
    pause
    exit /b 1
)

echo Criando pasta de distribuicao...
if exist bot-distribuicao (
    rmdir /s /q bot-distribuicao
)
mkdir bot-distribuicao

echo.
echo Copiando executavel...
copy dist\whatsapp-bot.exe bot-distribuicao\

echo.
echo Copiando banco de dados default...
if exist data\db.sqlite (
    if not exist bot-distribuicao\data mkdir bot-distribuicao\data
    copy data\db.sqlite bot-distribuicao\data\
    echo    [OK] db.sqlite copiado
) else (
    echo    [AVISO] db.sqlite nao encontrado, sera criado na primeira execucao
)

echo.
echo Copiando configuracao...
copy config.json bot-distribuicao\

echo.
echo Copiando interface web (public)...
if not exist bot-distribuicao\public mkdir bot-distribuicao\public
xcopy /E /I public bot-distribuicao\public

echo.
echo Copiando arquivo de instrucoes...
copy LEIA-ME.txt bot-distribuicao\

echo.
echo Criando arquivo INICIAR.bat...
(
echo @echo off
echo chcp 65001 ^>nul
echo title Bot WhatsApp - Seu Atendente Automatico
echo color 0A
echo mode con: cols=80 lines=30
echo cls
echo.
echo echo ============================================================
echo echo        BOT WHATSAPP - SEU ATENDENTE AUTOMATICO
echo echo                     INICIANDO...
echo echo ============================================================
echo echo.
echo echo  Conectando ao WhatsApp Web...
echo echo  Aguarde 10-30 segundos...
echo echo  Um codigo QR vai aparecer abaixo
echo echo.
echo.
echo whatsapp-bot.exe
echo.
echo echo.
echo echo  Bot encerrado.
echo echo.
echo pause
) > bot-distribuicao\INICIAR.bat

echo.
color 0A
echo ============================================================
echo        DISTRIBUICAO PRONTA!
echo ============================================================
echo.
echo Pasta: %CD%\bot-distribuicao\
echo.
echo Conteudo:
echo   - whatsapp-bot.exe (executavel unico)
echo   - data\db.sqlite (banco de dados default)
echo   - config.json (configuracao)
echo   - public\ (interface web)
echo   - INICIAR.bat (atalho para rodar)
echo   - LEIA-ME.txt (instrucoes)
echo.
echo COMO DISTRIBUIR:
echo   1. Zip a pasta inteira
echo   2. Envie para o cliente
echo   3. Cliente extrai e clica em INICIAR.bat
echo   4. Acessa http://localhost:3000/admin
echo.
pause
