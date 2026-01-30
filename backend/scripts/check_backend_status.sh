#!/bin/bash
# 检查后端状态脚本

echo "=========================================="
echo "后端状态检查"
echo "=========================================="
echo ""

# 1. 检查uvicorn进程
echo "1. 检查uvicorn进程："
ps aux | grep uvicorn | grep -v grep
if [ $? -eq 0 ]; then
    echo "   ✅ uvicorn进程正在运行"
else
    echo "   ❌ uvicorn进程未运行"
fi
echo ""

# 2. 检查端口8000
echo "2. 检查端口8000："
netstat -tuln | grep :8000 || ss -tuln | grep :8000
if [ $? -eq 0 ]; then
    echo "   ✅ 端口8000正在监听"
else
    echo "   ❌ 端口8000未监听"
fi
echo ""

# 3. 测试本地连接
echo "3. 测试本地API连接："
curl -s http://localhost:8000/health
if [ $? -eq 0 ]; then
    echo ""
    echo "   ✅ 本地API连接成功"
else
    echo ""
    echo "   ❌ 本地API连接失败"
fi
echo ""

# 4. 查看最近日志
echo "4. 最近20行日志："
if [ -f "backend.log" ]; then
    tail -20 backend.log
else
    echo "   ⚠️  日志文件不存在"
fi
echo ""

# 5. 检查代码版本
echo "5. 当前代码版本："
cd ~/Google-Data-Analysis 2>/dev/null || cd /home/admin/Google-Data-Analysis 2>/dev/null || echo "   无法确定项目目录"
git log --oneline -1 2>/dev/null || echo "   无法获取Git信息"
echo ""

echo "=========================================="

