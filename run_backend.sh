#!/usr/bin/env bash
set -e

# Resolve repo root directory
REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SERVER_DIR="$REPO_ROOT/server"

echo "========================================="
echo "   Starting Cyclops Backend Server       "
echo "========================================="

cd "$SERVER_DIR"

# 1. Detect Python
if command -v python3 >/dev/null 2>&1; then
    PYTHON_CMD="python3"
elif command -v python >/dev/null 2>&1; then
    PYTHON_CMD="python"
else
    echo "Error: Python is not installed or not in PATH."
    exit 1
fi

# 2. Virtual Environment setup
if [ ! -d ".venv" ]; then
    echo "Creating virtual environment in server/.venv..."
    "$PYTHON_CMD" -m venv .venv
    source .venv/bin/activate
    echo "Installing backend dependencies from requirements.txt..."
    pip install --upgrade pip
    pip install -r requirements.txt
else
    source .venv/bin/activate
    if ! command -v uvicorn >/dev/null 2>&1; then
        echo "Dependencies missing in .venv. Installing from requirements.txt..."
        pip install -r requirements.txt
    fi
fi

# 3. Environment configuration check
if [ ! -f ".env" ]; then
    if [ -f ".env.example" ]; then
        echo "Creating server/.env from .env.example..."
        cp .env.example .env
        echo "NOTE: Default .env created. Add your API keys to server/.env if using LLM providers."
    fi
fi

echo ""
echo "Backend running on: http://localhost:8000"
echo "API Docs:           http://localhost:8000/docs"
echo "Health check:       http://localhost:8000/v1/health"
echo "Press Ctrl+C to stop."
echo ""

exec uvicorn app.main:app --reload --port 8000

