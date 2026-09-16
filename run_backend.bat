@echo off
setlocal enabledelayedexpansion

echo =========================================
echo    Starting Cyclops Backend Server       
echo =========================================

cd /d "%~dp0server"

:: 1. Check Python
where python >nul 2>nul
if %errorlevel% neq 0 (
    where py >nul 2>nul
    if %errorlevel% neq 0 (
        echo Error: Python is not installed or not in PATH.
        echo Please install Python 3.10+ from python.org and ensure it is added to PATH.
        pause
        exit /b 1
    )
    set "PYTHON_CMD=py"
) else (
    set "PYTHON_CMD=python"
)

:: 2. Virtual Environment Setup
if not exist ".venv" (
    echo Creating virtual environment in server\.venv...
    %PYTHON_CMD% -m venv .venv
    if %errorlevel% neq 0 (
        echo Error creating virtual environment.
        pause
        exit /b 1
    )
    call .venv\Scripts\activate.bat
    echo Installing backend dependencies from requirements.txt...
    python -m pip install --upgrade pip
    pip install -r requirements.txt
) else (
    call .venv\Scripts\activate.bat
    where uvicorn >nul 2>nul
    if %errorlevel% neq 0 (
        echo Installing dependencies from requirements.txt...
        pip install -r requirements.txt
    )
)

:: 3. Environment Config Check
if not exist ".env" (
    if exist ".env.example" (
        echo Creating server\.env from .env.example...
        copy .env.example .env >nul
        echo NOTE: Default .env created. Add your API keys to server\.env if using LLM providers.
    )
)

echo.
echo Backend running on: http://localhost:8000
echo API Docs:           http://localhost:8000/docs
echo Health check:       http://localhost:8000/v1/health
echo Press Ctrl+C to stop.
echo.

uvicorn app.main:app --reload --port 8000
if %errorlevel% neq 0 (
    echo Server stopped with error.
    pause
)

