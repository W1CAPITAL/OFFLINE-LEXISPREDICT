@echo off
chcp 65001 >nul
setlocal EnableExtensions
cd /d "%~dp0"

title OFFLINE-LEXISPREDICT — Juntador do EXE
echo ============================================================
echo  JUNTADOR DO EXE — Lexis Offline
echo  Junta Lexis-Offline-parte-00.bin ... 0N.bin
echo  Gera: Lexis-Offline-v5.1-COM-EXE.zip + pasta extraida
echo ============================================================
echo.

REM Aceita partes nesta pasta (scripts) OU em ..\dist-parts
set "PARTDIR=%~dp0"
if exist "%~dp0..\dist-parts\Lexis-Offline-parte-00.bin" set "PARTDIR=%~dp0..\dist-parts\"
if exist "%~dp0Lexis-Offline-parte-00.bin" set "PARTDIR=%~dp0"
if exist "%CD%\Lexis-Offline-parte-00.bin" set "PARTDIR=%CD%\"

if not exist "%PARTDIR%Lexis-Offline-parte-00.bin" (
  echo [ERRO] Nao achei Lexis-Offline-parte-00.bin
  echo Coloque este BAT na mesma pasta das partes .bin
  echo ou deixe as partes em dist-parts\
  pause
  exit /b 1
)

echo Partes em: %PARTDIR%
echo.

set "OUTZIP=%PARTDIR%Lexis-Offline-v5.1-COM-EXE.zip"
if exist "%OUTZIP%" del /f /q "%OUTZIP%"

echo Juntando bytes das partes (pode levar 1-2 min)...
powershell -NoProfile -ExecutionPolicy Bypass -Command ^
  "$ErrorActionPreference='Stop'; $dir='%PARTDIR%'; $out=Join-Path $dir 'Lexis-Offline-v5.1-COM-EXE.zip'; if(Test-Path $out){Remove-Item $out -Force}; $fs=[IO.File]::Create($out); $i=0; while($true){ $name=Join-Path $dir ('Lexis-Offline-parte-{0:D2}.bin' -f $i); if(-not (Test-Path $name)){ break }; $b=[IO.File]::ReadAllBytes($name); $fs.Write($b,0,$b.Length); Write-Host ('  + parte {0:D2}  ({1:N0} bytes)' -f $i,$b.Length); $i++ }; $fs.Close(); if($i -eq 0){ throw 'Nenhuma parte encontrada' }; Write-Host ('OK ZIP: ' + $out + '  (' + $i + ' partes)')"

if errorlevel 1 (
  echo [ERRO] Falha ao juntar.
  pause
  exit /b 1
)

if not exist "%OUTZIP%" (
  echo [ERRO] ZIP nao foi criado.
  pause
  exit /b 1
)

echo.
echo Extraindo para pasta Lexis-Offline-Edition-Windows ...
set "OUTDIR=%PARTDIR%_extraido"
if exist "%OUTDIR%" rd /s /q "%OUTDIR%"
mkdir "%OUTDIR%" 2>nul

powershell -NoProfile -ExecutionPolicy Bypass -Command ^
  "Expand-Archive -LiteralPath '%OUTZIP%' -DestinationPath '%OUTDIR%' -Force"

if errorlevel 1 (
  echo [AVISO] Expand-Archive falhou. Extraia manualmente:
  echo   %OUTZIP%
  echo Depois rode 1-APLICAR-RECURSOS-NO-EXE.bat
  pause
  exit /b 0
)

echo.
echo ============================================================
echo  PRONTO
echo  ZIP:  %OUTZIP%
echo  Pasta: %OUTDIR%
echo.
echo  Proximo passo:
echo  1) Rode scripts\1-APLICAR-RECURSOS-NO-EXE.bat
echo  2) Ou abra a pasta e procure "Lexis Gabinete.exe"
echo ============================================================
explorer "%OUTDIR%"
pause
