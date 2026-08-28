@echo off
chcp 65001 >nul
title Lexis Offline — aplicar app.js no EXE
echo.
echo FECHE o "Lexis Gabinete.exe" antes.
pause

REM Este BAT deve estar DENTRO da pasta Lexis-Offline-Edition-Windows
set "DEST=%~dp0"
if not exist "%DEST%Lexis Gabinete.exe" if exist "%DEST%resources\app" (
  echo Achei resources\app — continuando sem EXE na raiz.
) else (
  echo.
  echo ERRO: coloque este BAT na pasta onde esta:
  echo   Lexis Gabinete.exe
  echo   e a pasta resources\
  echo.
  echo Exemplo:
  echo   ...\_extraido\Lexis-Offline-Edition-Windows\
  pause
  exit /b 1
)

mkdir "%DEST%resources\app" 2>nul
copy /Y "%~dp0app.js" "%DEST%resources\app\app.js"
if errorlevel 1 (
  echo FALHOU ao copiar. Rode como administrador ou feche o EXE.
  pause
  exit /b 1
)

echo.
echo OK — app.js copiado para:
echo   %DEST%resources\app\app.js
echo.
echo Agora:
echo 1) Abra Lexis Gabinete.exe
echo 2) Configuracoes → cole URL planilha + webhook /exec + token
echo 3) SALVAR → Testar webhook
echo.
pause
