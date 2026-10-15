@echo off
setlocal EnableExtensions
cls
title Busao DF - Servidor local
cd /d "%~dp0"

where node >nul 2>nul
if errorlevel 1 goto :sem_node

for /f %%V in ('node -p "Number(process.versions.node.split('.')[0])"') do set "NODE_MAJOR=%%V"
if not defined NODE_MAJOR goto :sem_node
if %NODE_MAJOR% LSS 18 goto :node_antigo

echo ============================================================
echo   Busao DF - servidor local
echo ============================================================
echo Node.js detectado: & node --version
echo.
node server.mjs
set "SAIDA=%ERRORLEVEL%"

if not "%SAIDA%"=="0" (
  echo.
  echo [ERRO] O servidor terminou com o codigo %SAIDA%.
  pause
)
exit /b %SAIDA%

:sem_node
echo [ERRO] Node.js nao foi encontrado.
echo Instale o Node.js 18 ou superior em https://nodejs.org/
pause
exit /b 1

:node_antigo
echo [ERRO] Node.js %NODE_MAJOR% detectado. Este projeto requer Node.js 18 ou superior.
echo Atualize em https://nodejs.org/
pause
exit /b 1
