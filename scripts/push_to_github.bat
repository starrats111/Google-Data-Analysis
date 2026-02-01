@echo off
REM GitHub推送脚本 (批处理)
REM 使用方法: scripts\push_to_github.bat [提交信息]

setlocal

if "%1"=="" (
    set COMMIT_MSG=更新代码: %date% %time%
) else (
    set COMMIT_MSG=%*
)

echo === 推送到GitHub ===

REM 切换到项目根目录
cd /d "%~dp0\.."

echo.
echo === 检查Git状态 ===
git status

echo.
echo === 添加所有更改 ===
git add .

echo.
echo === 提交更改 ===
echo 提交信息: %COMMIT_MSG%
git commit -m "%COMMIT_MSG%"

if %errorlevel% neq 0 (
    echo.
    echo 警告: 没有需要提交的更改
    set /p CONTINUE=是否继续推送到远程仓库? (y/n)
    if /i not "%CONTINUE%"=="y" (
        echo 已取消
        exit /b
    )
)

echo.
echo === 推送到GitHub ===
git push origin main

if %errorlevel% equ 0 (
    echo.
    echo [成功] 成功推送到GitHub!
    echo.
    echo === 后端部署指令 ===
    echo 请在阿里云服务器上执行以下命令:
    echo.
    echo cd ~/Google-Data-Analysis ^&^& git pull origin main ^&^& cd backend ^&^& source venv/bin/activate ^&^& pkill -f 'uvicorn.*app.main' ^&^& sleep 2 ^&^& nohup uvicorn app.main:app --host 0.0.0.0 --port 8000 ^> run.log 2^>^&1 ^&
    echo.
) else (
    echo.
    echo [失败] 推送失败，请检查错误信息
    exit /b 1
)

