@echo off
chcp 65001 >nul
cd /d "%~dp0\.."
title LexisPredict Desktop
set "LEXIS_ROOT=%CD%\LexisPredict"
if not exist "%LEXIS_ROOT%\package.json" (
  echo Rode antes: scripts\1-SETUP-LEXIS-DESKTOP.bat
  pause
  exit /b 1
)
cd electron
if not exist node_modules\electron (
  call npm install
)
set LEXIS_ROOT=%LEXIS_ROOT%
npx electron .
