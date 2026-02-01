@echo off
REM 简单版重启脚本 - 快速重启后端
REM 使用方法: restart_backend_simple.bat

cd /d "%~dp0\.."

echo 正在重启后端服务器...

REM 停止占用8000端口的进程
for /f "tokens=5" %%a in ('netstat -ano ^| findstr :8000') do (
    taskkill /F /PID %%a >nul 2>&1
)

timeout /t 2 /nobreak >nul

REM 启动服务器
call venv\Scripts\activate.bat
start /B python -m uvicorn app.main:app --host 0.0.0.0 --port 8000

echo 后端服务器已重启
echo 等待3秒后检查状态...
timeout /t 3 /nobreak >nul

curl -s http://127.0.0.1:8000/health >nul 2>&1
if %errorlevel% equ 0 (
    echo [成功] 服务器运行正常
) else (
    echo [警告] 服务器可能未完全启动，请稍后检查
)

