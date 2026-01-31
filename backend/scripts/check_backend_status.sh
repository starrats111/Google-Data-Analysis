#!/bin/bash
# 检查后端服务器状态

echo "=== 检查后端服务器进程 ==="
ps aux | grep uvicorn | grep -v grep

echo ""
echo "=== 检查后端服务器端口 ==="
netstat -tlnp | grep 8000 || ss -tlnp | grep 8000

echo ""
echo "=== 检查后端健康状态 ==="
curl -s http://127.0.0.1:8000/health || echo "后端服务器未运行"

echo ""
echo "=== 最近50行日志 ==="
tail -n 50 ~/Google-Data-Analysis/backend/run.log

