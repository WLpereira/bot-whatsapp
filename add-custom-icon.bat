@echo off
chcp 65001 >nul
title Criando Atalho com Icone Customizado
color 0B
cls

echo.
echo ============================================================
echo        CRIANDO ATALHO COM ICONE CUSTOMIZADO
echo ============================================================
echo.

REM Executar VBScript
cscript.exe create-shortcut.vbs

if %ERRORLEVEL% equ 0 (
    color 0A
    echo.
    echo [OK] CONCLUIDO!
    echo.
    echo    Agora voce tem 2 opcoes para iniciar:
    echo    - INICIAR.lnk (com seu icone) - RECOMENDADO
    echo    - INICIAR.bat (padrao)
    echo.
    echo    Use INICIAR.lnk para distribuir!
    echo.
) else (
    color 0C
    echo.
    echo [ERRO] Falha ao criar atalho
    echo.
)

pause
