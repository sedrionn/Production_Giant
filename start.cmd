@echo off
rem Double-click: start Production Giant and open it in the browser.
cd /d "%~dp0"
title Production Giant

rem Already running? Two servers on one folder break each other (shared .next cache).
netstat -ano | findstr /r /c:":3000 .*LISTENING" >nul
if not errorlevel 1 (
  echo Production Giant uzhe zapushen - otkryvayu brauzer.
  echo Esli nado perezapustit: zakroy staroe okno servera i zapusti snova.
  start http://localhost:3000
  timeout /t 5 >nul
  exit /b 0
)

start "" cmd /c "timeout /t 6 /nobreak >nul && start http://localhost:3000"
call npm run dev
pause
