@echo off
rem Double-click: update code, dependencies and database, then start the app.

rem git pull may rewrite this very file while it runs, and cmd reads .cmd files line by line.
rem So run a temporary copy and pass the project folder to it.
if not "%~1"=="--run" (
  copy /y "%~f0" "%TEMP%\pg-update.cmd" >nul
  "%TEMP%\pg-update.cmd" --run "%~dp0"
  exit /b
)
cd /d "%~2"

rem npm install under a running server breaks it: make sure it is stopped.
netstat -ano | findstr /r /c:":3000 .*LISTENING" >nul
if not errorlevel 1 (
  echo Production Giant seychas zapushen. Zakroy okno servera ^(ili Ctrl+C v nem^), potom zapusti update.cmd snova.
  pause
  exit /b 1
)

echo === Updating code ===
git checkout main
if errorlevel 1 goto fail
git pull
if errorlevel 1 goto fail
echo === Installing dependencies ===
call npm install
if errorlevel 1 goto fail
echo === Updating database ===
call npm run db:migrate
if errorlevel 1 goto fail
echo.
echo Update done. Starting the app...
call "%~2start.cmd"
goto :eof
:fail
echo.
echo !!! Update failed - copy the text above and send it to Claude.
pause
