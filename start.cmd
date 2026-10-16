@echo off
rem Double-click: start Production Giant and open it in the browser.
cd /d "%~dp0"
title Production Giant
start "" cmd /c "timeout /t 6 /nobreak >nul && start http://localhost:3000"
call npm run dev
pause
