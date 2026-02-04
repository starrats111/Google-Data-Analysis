#!/bin/bash
# 服务器重启和验证CORS脚本

cd ~/Google-Data-Analysis && \
git pull origin main && \
cd backend && \
source venv/bin/activate && \
pip install -q -r requirements.txt && \
pkill -9 -f "uvicorn.*app.main" || true && \
nohup uvicorn app.main:app --host 0.0.0.0 --port 8000 > run.log 2>&1 & \
sleep 2 && \
echo "=== 测试OPTIONS预检请求 ===" && \
curl -i -X OPTIONS "http://127.0.0.1:8000/api/mcc/accounts/9/sync" \
  -H "Origin: https://google-data-analysis.top" \
  -H "Access-Control-Request-Method: POST" \
  -H "Access-Control-Request-Headers: authorization,content-type,access-control-allow-origin" && \
echo "" && \
echo "=== 查看启动日志 ===" && \
tail -n 30 run.log

