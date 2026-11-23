#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"

echo "[1/5] 后端单元与安全边界测试"
(cd "$ROOT_DIR/server" && python3 -m unittest test_agent_core.py)

echo "[2/5] Agent / RAG 开发回归"
(cd "$ROOT_DIR/server" && python3 eval_agent.py)

echo "[3/5] 冻结集与 RAG 消融对比"
(cd "$ROOT_DIR/server" && python3 eval_quality.py > /tmp/qingning-eval-quality.json)

echo "[4/5] 前端静态检查"
(cd "$ROOT_DIR/web" && npm run lint)

echo "[5/5] 前端生产构建"
(cd "$ROOT_DIR/web" && npm run build)

echo "青柠核心验证全部通过。浏览器回归可另运行：cd web && npm run test:e2e"
