@echo off
REM FulgurMiner - control-panel launcher (Windows). Double-click it.
REM Starts the local control-panel server (if not already running) and opens it
REM in your browser. Mining runs as a child of the server and keeps going while
REM the server window stays open.
setlocal
cd /d "%~dp0"
set "URL=http://localhost:7311"
set "PORT=7311"

REM Already listening on the port? Then the panel is up - just open it.
netstat -ano | findstr /R /C:":%PORT% .*LISTENING" >nul 2>&1
if %errorlevel%==0 (
  echo Control panel already running.
  goto open
)

echo Starting FulgurMiner control panel...
start "FulgurMiner control panel" /min cmd /c "node gui\server.mjs > gui\server.log 2>&1"
REM Poll up to ~12s until the port is accepting connections.
for /l %%i in (1,1,12) do (
  timeout /t 1 /nobreak >nul
  netstat -ano | findstr /R /C:":%PORT% .*LISTENING" >nul 2>&1 && goto open
)

REM Never came up - surface the failure instead of opening a dead page.
echo.
echo ERROR: the control panel did not start within ~12s.
echo Check gui\server.log for details (is Node.js installed and on your PATH?).
echo.
pause
exit /b 1

:open
start "" "%URL%"
echo Opened %URL%
exit /b 0
