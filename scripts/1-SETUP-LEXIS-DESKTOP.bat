@echo off
chcp 65001 >nul
cd /d "%~dp0\.."
title Lexis Desktop — setup copia do LexisPredict
echo ============================================================
echo  META: Desktop IDENTICO ao Lexis do Vercel (mesmo codigo)
echo  NAO e o offline.html paralelo.
echo ============================================================
echo.

set "LEXIS=%CD%\LexisPredict"
if not exist "%LEXIS%\package.json" (
  echo Clonando W1CAPITAL/LexisPredict ...
  git clone --depth 1 https://github.com/W1CAPITAL/LexisPredict.git "%LEXIS%"
  if errorlevel 1 (
    echo ERRO git clone. Instale Git e tente de novo.
    pause
    exit /b 1
  )
) else (
  echo LexisPredict ja existe. Atualizando...
  pushd "%LEXIS%"
  git pull
  popd
)

echo.
echo npm install + build (pode demorar)...
pushd "%LEXIS%"
call npm install
if errorlevel 1 (
  echo ERRO npm install
  popd
  pause
  exit /b 1
)
call npm run build
if errorlevel 1 (
  echo ERRO npm run build — verifique .env.local com Supabase se necessario
  popd
  pause
  exit /b 1
)
popd

echo.
echo Electron shell...
pushd "%CD%\electron"
call npm install
popd

echo.
echo OK. Para abrir o Lexis Desktop:
echo   scripts\2-ABRIR-LEXIS-DESKTOP.bat
echo.
echo Requer rede para Supabase/DataJud no primeiro uso.
echo Planilha CRM: configure SHEETS webhook no app web (mesma base).
pause
