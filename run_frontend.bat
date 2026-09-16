@echo off
setlocal enabledelayedexpansion

echo =========================================
echo    Cyclops Frontend ^& Demo Environment   
echo =========================================

set "REPO_ROOT=%~dp0"
set "EXTENSION_DIR=%REPO_ROOT%extension"

:: 1. Check Node.js and npm
echo.
echo [1/2] Preparing Chrome Extension...
where node >nul 2>nul
if %errorlevel% neq 0 (
    echo Error: Node.js is not installed or not in PATH.
    echo Please install Node.js (v18+) from https://nodejs.org/
    pause
    exit /b 1
)

cd /d "%EXTENSION_DIR%"
if not exist "node_modules" (
    echo Installing extension dependencies (npm install)...
    call npm install
    if %errorlevel% neq 0 (
        echo Error running npm install.
        pause
        exit /b 1
    )
)

echo Building extension bundles...
call npm run build
if %errorlevel% neq 0 (
    echo Error building extension.
    pause
    exit /b 1
)
echo [OK] Extension ready in: %EXTENSION_DIR%\dist

:: 2. Start Demo HTTP Server
cd /d "%REPO_ROOT%"
echo.
echo [2/2] Starting Demo Web Server on port 5500...

where python >nul 2>nul
if %errorlevel% equ 0 (
    set "SERVER_CMD=python -m http.server 5500"
    goto :START_SERVER
)

where py >nul 2>nul
if %errorlevel% equ 0 (
    set "SERVER_CMD=py -m http.server 5500"
    goto :START_SERVER
)

where npx >nul 2>nul
if %errorlevel% equ 0 (
    set "SERVER_CMD=npx --yes serve -l 5500 ."
    goto :START_SERVER
)

echo Error: Neither Python nor npx was found to serve demo pages.
echo Please ensure Python or Node.js is in your PATH.
pause
exit /b 1

:START_SERVER
echo.
echo -----------------------------------------
echo Demo Portal:    http://localhost:5500/demo/portal.html
echo Demo Form:      http://localhost:5500/demo/test-page.html
echo.
echo To load extension in Chrome:
echo   1. Open chrome://extensions
echo   2. Toggle 'Developer mode' ON (top-right)
echo   3. Click 'Load unpacked' -^> Select '%EXTENSION_DIR%'
echo -----------------------------------------
echo Press Ctrl+C to stop.
echo.

%SERVER_CMD%
if %errorlevel% neq 0 (
    pause
)

