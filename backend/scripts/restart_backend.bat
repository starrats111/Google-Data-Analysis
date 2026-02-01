@echo off
REM 重启后端服务器 (批处理脚本)
REM 使用方法: restart_backend.bat

echo === 重启后端服务器 ===

REM 切换到backend目录
cd /d "%~dp0\.."

echo.
echo === 停止现有服务器 ===
REM 查找并停止uvicorn进程
for /f "tokens=2" %%i in ('netstat -ano ^| findstr :8000 ^| findstr LISTENING') do (
    echo 发现端口8000被占用，正在停止进程 %%i
    taskkill /F /PID %%i >nul 2>&1
)

REM 停止所有python进程（谨慎使用，可能会停止其他python程序）
REM taskkill /F /IM python.exe /FI "WINDOWTITLE eq *uvicorn*" >nul 2>&1

timeout /t 2 /nobreak >nul

echo.
echo === 激活虚拟环境 ===
REM 检查虚拟环境
if not exist "venv\Scripts\activate.bat" (
    echo 错误: 虚拟环境不存在，请先创建虚拟环境
    pause
    exit /b 1
)

REM 激活虚拟环境并启动服务器
echo.
echo === 启动服务器 ===
call venv\Scripts\activate.bat

REM 启动服务器（后台运行）
start /B python -m uvicorn app.main:app --host 0.0.0.0 --port 8000 > run.log 2>&1

echo 服务器正在启动...
timeout /t 3 /nobreak >nul

echo.
echo === 检查服务器状态 ===
REM 检查健康状态
curl -s http://127.0.0.1:8000/health >nul 2>&1
if %errorlevel% equ 0 (
    echo [成功] 后端服务器启动成功
    echo 访问地址: http://127.0.0.1:8000
    echo API文档: http://127.0.0.1:8000/docs
) else (
    echo [失败] 后端服务器启动失败或未响应
    echo 查看日志文件: run.log
    if exist run.log (
        echo.
        echo 最近20行日志:
        powershell -Command "Get-Content run.log -Tail 20"
    )
)

echo.
echo === 重启完成 ===
pause

