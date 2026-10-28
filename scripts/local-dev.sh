#!/usr/bin/env bash
set -u

PROJECT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
SERVER_DIR="$PROJECT_DIR/server"
WEB_DIR="$PROJECT_DIR/web"
CHECK_ONLY=false

if [ "${1:-}" = "--check" ]; then
  CHECK_ONLY=true
fi

ok() { printf '✓ %s\n' "$1"; }
warn() { printf '⚠ %s\n' "$1"; }
fail() { printf '✗ %s\n' "$1" >&2; exit 1; }

printf '\n青柠 · 本地环境检查\n\n'

command -v python3 >/dev/null 2>&1 || fail "未找到 python3，请先安装 Python 3。"
command -v npm >/dev/null 2>&1 || fail "未找到 npm，请先安装 Node.js 和 npm。"
ok "Python: $(python3 --version 2>&1)"
ok "Node: $(node --version 2>&1)"
ok "npm: $(npm --version 2>&1)"

if ! (cd "$SERVER_DIR" && PYTHONDONTWRITEBYTECODE=1 python3 -c "import fastapi, uvicorn, pydantic, aiosqlite, httpx, bcrypt"); then
  fail "后端依赖不完整。请执行：python3 -m pip install -r server/requirements.txt --user"
fi
ok "后端核心依赖已安装"

if [ ! -d "$WEB_DIR/node_modules" ]; then
  fail "前端依赖未安装。请执行：cd web && npm install"
fi
ok "前端依赖已安装"

if [ -f "$SERVER_DIR/.env" ]; then
  ok "已找到 server/.env"
else
  warn "未找到 server/.env，将以演示模式启动（也可在页面的模型设置中配置）。"
fi

port_owner() {
  lsof -nP -iTCP:"$1" -sTCP:LISTEN 2>/dev/null | tail -n +2 | head -n 1
}

BACKEND_OWNER="$(port_owner 8000)"
FRONTEND_OWNER="$(port_owner 5173)"

if [ -n "$BACKEND_OWNER" ]; then warn "8000 端口已在使用：$BACKEND_OWNER"; else ok "8000 端口可用"; fi
if [ -n "$FRONTEND_OWNER" ]; then warn "5173 端口已在使用：$FRONTEND_OWNER"; else ok "5173 端口可用"; fi

if [ "$CHECK_ONLY" = true ]; then
  printf '\n检查完成。\n'
  exit 0
fi

if [ -n "$BACKEND_OWNER" ] || [ -n "$FRONTEND_OWNER" ]; then
  fail "启动已取消：请先关闭占用 8000/5173 的旧服务，避免误停其他程序。"
fi

BACKEND_PID=""
FRONTEND_PID=""

cleanup() {
  printf '\n正在停止青柠本地服务…\n'
  [ -n "$FRONTEND_PID" ] && kill "$FRONTEND_PID" 2>/dev/null || true
  [ -n "$BACKEND_PID" ] && kill "$BACKEND_PID" 2>/dev/null || true
  wait 2>/dev/null || true
}
trap cleanup INT TERM EXIT

printf '\n正在启动后端 http://127.0.0.1:8000 …\n'
(cd "$SERVER_DIR" && exec python3 -m uvicorn main:app --host 127.0.0.1 --port 8000) &
BACKEND_PID=$!

printf '正在启动前端 http://127.0.0.1:5173 …\n'
(cd "$WEB_DIR" && exec npm run dev -- --host 127.0.0.1 --port 5173 --strictPort) &
FRONTEND_PID=$!

printf '\n青柠已启动。浏览器打开：http://127.0.0.1:5173/\n按 Ctrl+C 同时停止前后端。\n\n'

while kill -0 "$BACKEND_PID" 2>/dev/null && kill -0 "$FRONTEND_PID" 2>/dev/null; do
  sleep 1
done
fail "其中一个服务已退出，请查看上方日志。"
