@echo off
chcp 65001 >nul
cd /d "%~dp0\.."
title OFFLINE-LEXISPREDICT v5.1.8 - aplicar fonte no EXE
echo.
echo FECHE o Lexis Gabinete.exe antes de continuar.
pause

set "DEST="
if exist "%~dp0..\Lexis Gabinete.exe" set "DEST=%~dp0.."
if exist "%CD%\Lexis Gabinete.exe" set "DEST=%CD%"
if exist "%CD%\Lexis-Offline-Edition-Windows\Lexis Gabinete.exe" set "DEST=%CD%\Lexis-Offline-Edition-Windows"
if "%DEST%"=="" (
  echo.
  echo Cole o caminho da pasta que contem "Lexis Gabinete.exe":
  set /p DEST=Pasta: 
)

if not exist "%DEST%\Lexis Gabinete.exe" (
  echo ERRO: nao achei Lexis Gabinete.exe em:
  echo %DEST%
  pause
  exit /b 1
)

mkdir "%DEST%\resources\app" 2>nul
copy /Y "%CD%\desktop\main.js" "%DEST%\resources\app\main.js"
copy /Y "%CD%\desktop\offline.html" "%DEST%\resources\app\offline.html"
copy /Y "%CD%\desktop\preload.js" "%DEST%\resources\app\preload.js"
copy /Y "%CD%\desktop\package.json" "%DEST%\resources\app\package.json"

if exist "%CD%\secrets\lexis-secrets.json" (
  copy /Y "%CD%\secrets\lexis-secrets.json" "%DEST%\lexis-secrets.json"
) else (
  echo AVISO: secrets\lexis-secrets.json nao existe. Copie do example se for usar MiniMax.
)

echo.
echo OK — recursos v5.1.8 aplicados em:
echo %DEST%
echo.
echo 1) Abra Lexis Gabinete.exe
echo 2) Titulo deve mostrar v5.1.8
echo 3) Plano B - Carregar planilha Google
pause
