@echo off
setlocal EnableExtensions
cls
title Busao DF - Link publico HTTPS
cd /d "%~dp0"

where node >nul 2>nul
if errorlevel 1 goto :sem_node
where npx >nul 2>nul
if errorlevel 1 goto :sem_npx

for /f %%V in ('node -p "Number(process.versions.node.split('.')[0])"') do set "NODE_MAJOR=%%V"
if not defined NODE_MAJOR goto :sem_node
if %NODE_MAJOR% LSS 18 goto :node_antigo

echo ============================================================
echo   Busao DF - compartilhamento HTTPS para celular
echo ============================================================
echo Verificando o servidor local...

powershell -NoProfile -Command "try { $r=Invoke-WebRequest -UseBasicParsing -TimeoutSec 2 http://localhost:3000/healthz; if($r.StatusCode -ne 200){exit 1} } catch { exit 1 }"
if errorlevel 1 (
  echo Iniciando o servidor em segundo plano...
  del /q "%~dp0servidor.log" "%~dp0servidor-erro.log" >nul 2>nul
  powershell -NoProfile -ExecutionPolicy Bypass -Command "$node=(Get-Command node -ErrorAction Stop).Source; Start-Process -FilePath $node -ArgumentList 'server.mjs' -WorkingDirectory '%~dp0' -WindowStyle Hidden -RedirectStandardOutput '%~dp0servidor.log' -RedirectStandardError '%~dp0servidor-erro.log'"
  if errorlevel 1 goto :erro_servidor
)

for /l %%I in (1,1,15) do (
  powershell -NoProfile -Command "try { $r=Invoke-WebRequest -UseBasicParsing -TimeoutSec 2 http://localhost:3000/healthz; if($r.StatusCode -eq 200){exit 0}; exit 1 } catch { exit 1 }" >nul 2>nul
  if not errorlevel 1 goto :servidor_pronto
  timeout /t 1 /nobreak >nul
)

echo [ERRO] O servidor nao respondeu em http://localhost:3000/healthz
if exist "%~dp0servidor-erro.log" (
  echo.
  echo Detalhes registrados pelo Node.js:
  type "%~dp0servidor-erro.log"
)
echo.
echo Execute iniciar.bat se precisar manter o erro visivel.
pause
exit /b 1

:erro_servidor
echo [ERRO] O Windows nao conseguiu iniciar o Node.js em segundo plano.
echo Execute iniciar.bat para ver o erro completo.
pause
exit /b 1

:servidor_pronto
echo.
echo O Cloudflare mostrara abaixo um endereco parecido com:
echo   https://palavras-aleatorias.trycloudflare.com
echo.
echo Copie o link HTTPS, abra no celular e permita a localizacao precisa.
echo Pressione Ctrl+C para encerrar o tunel.
echo ============================================================
echo.
call npx --yes cloudflared tunnel --url http://localhost:3000

if errorlevel 1 (
  echo.
  echo [ERRO] Nao foi possivel abrir o tunel Cloudflare.
  pause
  exit /b 1
)
exit /b 0

:sem_node
echo [ERRO] Node.js nao foi encontrado. Instale em https://nodejs.org/
pause
exit /b 1

:sem_npx
echo [ERRO] npx nao foi encontrado. Reinstale a versao LTS do Node.js.
pause
exit /b 1

:node_antigo
echo [ERRO] Node.js %NODE_MAJOR% detectado. Este projeto requer Node.js 18 ou superior.
pause
exit /b 1
