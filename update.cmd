@echo off
rem Double-click: update code, dependencies and database, then start the app.
cd /d "%~dp0"
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
call "%~dp0start.cmd"
goto :eof
:fail
echo.
echo !!! Update failed - copy the text above and send it to Claude.
pause
