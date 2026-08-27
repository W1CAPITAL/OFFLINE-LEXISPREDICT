@echo off
chcp 65001 >nul
title Aplicar patch no EXE extraido
echo Pasta padrao do usuario:
echo   C:\Users\USER\Downloads\_extraido\Lexis-Offline-Edition-Windows
echo.
set "DEST=C:\Users\USER\Downloads\_extraido\Lexis-Offline-Edition-Windows"
if not exist "%DEST%\Lexis Gabinete.exe" (
  echo Nao achei o EXE no caminho padrao.
  set /p DEST=Cole o caminho completo da pasta do EXE: 
)
if not exist "%DEST%\Lexis Gabinete.exe" (
  echo ERRO: Lexis Gabinete.exe nao encontrado
  pause
  exit /b 1
)
cd /d "%~dp0\.."
mkdir "%DEST%\resources\app" 2>nul
copy /Y "%CD%\desktop\offline.html" "%DEST%\resources\app\offline.html"
copy /Y "%CD%\desktop\main.js" "%DEST%\resources\app\main.js"
copy /Y "%CD%\desktop\preload.js" "%DEST%\resources\app\preload.js"
copy /Y "%CD%\desktop\package.json" "%DEST%\resources\app\package.json"
echo.
echo Patch shell (parser M/N) aplicado em:
echo %DEST%
echo.
echo AVISO: isso NAO e o Lexis completo.
echo Para copia identica ao Vercel use: 1-SETUP-LEXIS-DESKTOP.bat
pause
