#!/usr/bin/env bash
set -euo pipefail

MODE="${1:-run}"
ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

cd "$ROOT_DIR"

source "$HOME/.cargo/env"

if [ ! -d node_modules ]; then
  npm install
fi

pkill -f "target/debug/openxterm" >/dev/null 2>&1 || true
pkill -x "OpenXTerm" >/dev/null 2>&1 || true
pkill -f "cargo tauri dev" >/dev/null 2>&1 || true
pkill -f "vite --host 127.0.0.1 --port 5173" >/dev/null 2>&1 || true

case "$MODE" in
  run)
    npm run tauri:dev
    ;;
  --debug|debug)
    RUST_LOG=openxterm=debug,tauri=info npm run tauri:dev
    ;;
  --verify|verify)
    npm run tauri:dev >/tmp/openxterm-tauri-dev.log 2>&1 &
    DEV_PID=$!
    for _ in {1..240}; do
      if pgrep -f "target/debug/openxterm|OpenXTerm.app" >/dev/null 2>&1; then
        echo "OpenXTerm Tauri dev process is running."
        kill "$DEV_PID" >/dev/null 2>&1 || true
        exit 0
      fi
      sleep 1
    done
    echo "OpenXTerm did not launch in time. See /tmp/openxterm-tauri-dev.log" >&2
    kill "$DEV_PID" >/dev/null 2>&1 || true
    exit 1
    ;;
  --logs|logs|--telemetry|telemetry)
    RUST_LOG=openxterm=info,tauri=info npm run tauri:dev
    ;;
  *)
    echo "usage: $0 [run|--debug|--logs|--telemetry|--verify]" >&2
    exit 2
    ;;
esac
