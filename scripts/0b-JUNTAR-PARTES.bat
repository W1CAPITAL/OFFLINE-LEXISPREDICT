@echo off
chcp 65001 >nul
cd /d "%~dp0\.."
title OFFLINE-LEXISPREDICT - juntar partes do EXE
echo.
echo Juntando partes (dist-parts) em Lexis-Offline-v5.1-COM-EXE.zip ...
if not exist "dist-parts\LexisOffline_parte_00.zip" (
  echo ERRO: faltam dist-parts\LexisOffline_parte_00.zip ... _05.zip
  pause
  exit /b 1
)
if exist "dist-parts\_rebuilt.zip" del /f /q "dist-parts\_rebuilt.zip"
copy /b "dist-parts\LexisOffline_parte_00.zip"+"dist-parts\LexisOffline_parte_01.zip"+"dist-parts\LexisOffline_parte_02.zip"+"dist-parts\LexisOffline_parte_03.zip"+"dist-parts\LexisOffline_parte_04.zip"+"dist-parts\LexisOffline_parte_05.zip" "dist-parts\_rebuilt.zip"
if errorlevel 1 (
  echo Falha no copy /b
  pause
  exit /b 1
)
echo OK: dist-parts\_rebuilt.zip
echo Extraia com 7-Zip ou Windows (botao direito - Extrair).
echo Depois rode scripts\1-APLICAR-RECURSOS-NO-EXE.bat apontando para a pasta do EXE.
pause
