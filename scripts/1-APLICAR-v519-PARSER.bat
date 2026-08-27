@echo off
chcp 65001 >nul
cd /d "%~dp0"
title Lexis Offline v5.1.9 - parser M/N
echo FECHE o Lexis Gabinete.exe
pause
set "DEST="
if exist "%CD%\Lexis Gabinete.exe" set "DEST=%CD%"
if exist "%CD%\Lexis-Offline-Edition-Windows\Lexis Gabinete.exe" set "DEST=%CD%\Lexis-Offline-Edition-Windows"
if exist "%CD%\_extraido\Lexis-Offline-Edition-Windows\Lexis Gabinete.exe" set "DEST=%CD%\_extraido\Lexis-Offline-Edition-Windows"
if "%DEST%"=="" (
  echo Cole o caminho da pasta do Lexis Gabinete.exe:
  set /p DEST=
)
if not exist "%DEST%\Lexis Gabinete.exe" (
  echo ERRO: EXE nao encontrado
  pause
  exit /b 1
)
mkdir "%DEST%\resources\app" 2>nul
if exist "%CD%\desktop\offline.html" (
  copy /Y "%CD%\desktop\offline.html" "%DEST%\resources\app\offline.html"
  copy /Y "%CD%\desktop\main.js" "%DEST%\resources\app\main.js"
  copy /Y "%CD%\desktop\preload.js" "%DEST%\resources\app\preload.js"
  copy /Y "%CD%\desktop\package.json" "%DEST%\resources\app\package.json"
) else if exist "%CD%\OFFLINE-LEXISPREDICT\desktop\offline.html" (
  copy /Y "%CD%\OFFLINE-LEXISPREDICT\desktop\offline.html" "%DEST%\resources\app\offline.html"
  copy /Y "%CD%\OFFLINE-LEXISPREDICT\desktop\main.js" "%DEST%\resources\app\main.js"
  copy /Y "%CD%\OFFLINE-LEXISPREDICT\desktop\preload.js" "%DEST%\resources\app\preload.js"
  copy /Y "%CD%\OFFLINE-LEXISPREDICT\desktop\package.json" "%DEST%\resources\app\package.json"
) else (
  echo Extraia OFFLINE_v519_PARSER_MN.zip aqui e rode de novo
  pause
  exit /b 1
)
echo OK v5.1.9 aplicado. Abra o EXE e RECARREGUE a planilha no Plano B.
echo Deve aparecer: col RETORNO = 12 | col PRAZO = 13 | com prazo: ~840
pause
