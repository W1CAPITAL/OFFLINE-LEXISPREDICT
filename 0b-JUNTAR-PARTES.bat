@echo off
chcp 65001 >nul
setlocal
cd /d "%~dp0"
title Juntar partes - Lexis Offline EXE
echo ========================================
echo  Junta partes -> Lexis-Offline-v5.1-COM-EXE.zip
echo ========================================
echo.

if not exist "Lexis-Offline-parte-00.bin" (
  echo [ERRO] Falta Lexis-Offline-parte-00.bin nesta pasta.
  pause
  exit /b 1
)

powershell -NoProfile -ExecutionPolicy Bypass -Command ^
  "$out='Lexis-Offline-v5.1-COM-EXE.zip'; if(Test-Path $out){ Remove-Item $out -Force }; $fs=[IO.File]::Create($out); $i=0; while($true){ $name=('Lexis-Offline-parte-{0:D2}.bin' -f $i); if(-not (Test-Path $name)){ break }; $b=[IO.File]::ReadAllBytes($name); $fs.Write($b,0,$b.Length); Write-Host \"+ $name\"; $i++ }; $fs.Close(); Write-Host \"OK $out\""

if not exist "Lexis-Offline-v5.1-COM-EXE.zip" (
  echo Falha ao juntar.
  pause
  exit /b 1
)

echo.
echo Extraindo...
powershell -NoProfile -Command "Expand-Archive -Path 'Lexis-Offline-v5.1-COM-EXE.zip' -DestinationPath '.' -Force"

echo.
echo Se tiver a pasta de recursos v5.1.2, rode 1-APLICAR-RECURSOS-NO-EXE.bat
echo Depois 2-INSTALAR-OLLAMA-IA.bat
pause
