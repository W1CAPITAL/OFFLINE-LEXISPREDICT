@echo off
chcp 65001 >nul
title Lexis Gabinete v6.0 - aplicar pacote COMPLETO no EXE
echo FECHE o Lexis Gabinete.exe antes de continuar.
pause

set "SRC=%~dp0..\desktop"
set "DEST="
if exist "%~dp0..\Lexis Gabinete.exe" set "DEST=%~dp0.."
if exist "%CD%\Lexis Gabinete.exe" set "DEST=%CD%"
if exist "%CD%\Lexis-Offline-Edition-Windows\Lexis Gabinete.exe" set "DEST=%CD%\Lexis-Offline-Edition-Windows"
if exist "%CD%\_extraido\Lexis-Offline-Edition-Windows\Lexis Gabinete.exe" set "DEST=%CD%\_extraido\Lexis-Offline-Edition-Windows"
if "%DEST%"=="" (
  echo Cole o caminho da pasta que contem Lexis Gabinete.exe:
  set /p DEST=Pasta: 
)
if not exist "%DEST%\Lexis Gabinete.exe" (
  echo ERRO: nao achei Lexis Gabinete.exe em:
  echo %DEST%
  pause
  exit /b 1
)

mkdir "%DEST%\resources\app\assets" 2>nul
copy /Y "%SRC%\app.js"            "%DEST%\resources\app\app.js"
copy /Y "%SRC%\main.js"           "%DEST%\resources\app\main.js"
copy /Y "%SRC%\offline.html"      "%DEST%\resources\app\offline.html"
copy /Y "%SRC%\preload.js"        "%DEST%\resources\app\preload.js"
copy /Y "%SRC%\package.json"      "%DEST%\resources\app\package.json"
copy /Y "%SRC%\splash.html"       "%DEST%\resources\app\splash.html"    >nul 2>nul
copy /Y "%SRC%\about-keys.html"   "%DEST%\resources\app\about-keys.html" >nul 2>nul
if exist "%SRC%\assets\icon.ico" copy /Y "%SRC%\assets\icon.ico" "%DEST%\resources\app\assets\icon.ico" >nul
if exist "%SRC%\assets\icon.png" copy /Y "%SRC%\assets\icon.png" "%DEST%\resources\app\assets\icon.png" >nul

echo.
echo OK - v6.0 COMPLETO aplicado em:
echo %DEST%
echo.
echo Abra Lexis Gabinete.exe - Sobre deve mostrar v6.0 e o parser vai aceitar o GET INTEGRADO.
pause