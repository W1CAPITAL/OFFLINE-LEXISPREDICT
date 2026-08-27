@echo off
chcp 65001 >nul
cd /d "%~dp0"
title Lexis Offline v5.1.6 - port LexisPredict
echo FECHE o Lexis Gabinete.exe
pause
set "DEST=%~dp0"
if not exist "%DEST%Lexis Gabinete.exe" if exist "%DEST%Lexis-Offline-Edition-Windows\Lexis Gabinete.exe" set "DEST=%DEST%Lexis-Offline-Edition-Windows\"
if not exist "%DEST%Lexis Gabinete.exe" (
  echo Coloque este pacote na pasta do EXE
  pause
  exit /b 1
)
mkdir "%DEST%resources\app" 2>nul
copy /Y "%~dp0main.js" "%DEST%resources\app\main.js"
copy /Y "%~dp0offline.html" "%DEST%resources\app\offline.html"
copy /Y "%~dp0preload.js" "%DEST%resources\app\preload.js"
copy /Y "%~dp0package.json" "%DEST%resources\app\package.json"
if exist "%~dp0lexis-secrets.json" copy /Y "%~dp0lexis-secrets.json" "%DEST%lexis-secrets.json"
echo.
echo OK v5.1.6 LexisPredict port
echo Abra o EXE - titulo deve mostrar v5.1.6
echo Plano B - Carregar planilha de novo
pause
