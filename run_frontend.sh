#!/usr/bin/env bash
set -e

# Resolve repo root directory
REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
EXTENSION_DIR="$REPO_ROOT/extension"

echo "========================================="
echo "   Cyclops Frontend & Demo Environment   "
echo "========================================="

MODE="all"
while [[ "$#" -gt 0 ]]; do
    case $1 in
        --watch|-w) MODE="watch" ;;
        --build-only|-b) MODE="build-only" ;;
        --demo-only|-d) MODE="demo-only" ;;
        --help|-h)
            echo "Usage: ./run_frontend.sh [OPTIONS]"
            echo "Options:"
            echo "  --watch, -w       Build extension, watch for changes, and serve demo pages"
            echo "  --build-only, -b  Build extension only, do not serve demo pages"
            echo "  --demo-only, -d   Serve demo pages only without building extension"
            echo "  --help, -h        Show this help message"
            exit 0
            ;;
        *) echo "Unknown option: $1"; exit 1 ;;
    esac
    shift
done

# 1. Extension Build / Setup
if [ "$MODE" != "demo-only" ]; then
    echo ""
    echo "[1/2] Preparing Chrome Extension..."
    if ! command -v node >/dev/null 2>&1; then
        echo "Error: Node.js is not installed or not in PATH."
        echo "Please install Node.js (v18+) to build the extension."
        exit 1
    fi

    cd "$EXTENSION_DIR"
    if [ ! -d "node_modules" ]; then
        echo "Installing extension dependencies (npm install)..."
        npm install
    fi

    echo "Building extension bundles..."
    npm run build
    echo "✓ Extension ready in: $EXTENSION_DIR/dist"

    if [ "$MODE" = "watch" ]; then
        echo "Starting extension build watcher in background..."
        npm run watch &
        WATCH_PID=$!
        trap "echo 'Stopping extension watcher...'; kill $WATCH_PID 2>/dev/null || true" EXIT INT TERM
    fi

    cd "$REPO_ROOT"
fi

if [ "$MODE" = "build-only" ]; then
    echo ""
    echo "Extension build complete. You can load unpacked in chrome://extensions"
    exit 0
fi

# 2. Start Demo Server
echo ""
echo "[2/2] Starting Demo Web Server on port 5500..."

# Detect HTTP server tool (Python preferred, fallback to npx serve)
HTTP_SERVER_CMD=""
if command -v python3 >/dev/null 2>&1; then
    HTTP_SERVER_CMD="python3 -m http.server 5500"
elif command -v python >/dev/null 2>&1; then
    HTTP_SERVER_CMD="python -m http.server 5500"
elif command -v npx >/dev/null 2>&1; then
    HTTP_SERVER_CMD="npx --yes serve -l 5500 ."
else
    echo "Error: Neither Python nor npx was found to serve demo pages."
    echo "Please install Python or Node.js."
    exit 1
fi

echo ""
echo "-----------------------------------------"
echo "Demo Portal:    http://localhost:5500/demo/portal.html"
echo "Demo Form:      http://localhost:5500/demo/test-page.html"
echo ""
echo "To load extension in Chrome:"
echo "  1. Open chrome://extensions"
echo "  2. Toggle 'Developer mode' ON (top-right)"
echo "  3. Click 'Load unpacked' -> Select '$EXTENSION_DIR'"
echo "-----------------------------------------"
echo "Press Ctrl+C to stop."
echo ""

exec $HTTP_SERVER_CMD

