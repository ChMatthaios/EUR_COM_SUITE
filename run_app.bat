@echo off
title EUR_COM_SUITE - Banking Reports App
echo =========================================
echo   EUR_COM_SUITE - Starting Application
echo =========================================
echo.

REM === BASE PATH ===
set BASEDIR=%~dp0

REM === BACKEND ===
echo [1/3] Starting Backend (FastAPI)...
cd /d "%BASEDIR%\backend"

REM Install dependencies if missing
py -m pip install fastapi uvicorn >nul 2>&1

start "EUR_COM_SUITE Backend" cmd /k ^
  py -m uvicorn api_server:app --reload --host 127.0.0.1 --port 8000

echo Backend starting on http://127.0.0.1:8000
echo.

REM === FRONTEND ===
echo [2/3] Starting Frontend (Static Server)...
cd /d "%BASEDIR%\frontend"

start "EUR_COM_SUITE Frontend" cmd /k ^
  py -m http.server 5500

echo Frontend starting on http://127.0.0.1:5500
echo.

REM === OPEN BROWSER ===
echo [3/3] Opening Browser...
timeout /t 3 >nul
start http://127.0.0.1:5500

echo.
echo =========================================
echo   Application is running
echo =========================================
echo.
echo - Backend:  http://127.0.0.1:8000
echo - Frontend: http://127.0.0.1:5500
echo.
echo Close the two command windows to stop.
echo.

pause
