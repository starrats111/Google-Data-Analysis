@echo off
chcp 65001 >nul
echo ========================================
echo VitaHaven 推送到GitHub
echo ========================================
echo.

REM 检查Git是否安装
where git >nul 2>&1
if %errorlevel% neq 0 (
    echo [错误] 未检测到Git，请先安装Git
    echo.
    echo 下载地址: https://git-scm.com/download/win
    echo.
    pause
    exit /b 1
)

echo [1/6] 检查Git仓库状态...
if not exist .git (
    echo [2/6] 初始化Git仓库...
    git init
    if %errorlevel% neq 0 (
        echo [错误] Git初始化失败
        pause
        exit /b 1
    )
) else (
    echo [2/6] Git仓库已存在，跳过初始化
)

echo [3/6] 配置远程仓库...
git remote remove origin >nul 2>&1
git remote add origin https://github.com/starrats111/VitaHaven.git
if %errorlevel% neq 0 (
    echo [错误] 配置远程仓库失败
    pause
    exit /b 1
)

echo [4/6] 添加所有文件...
git add .
if %errorlevel% neq 0 (
    echo [错误] 添加文件失败
    pause
    exit /b 1
)

echo [5/6] 提交更改...
git commit -m "Initial commit: VitaHaven lifestyle blog website"
if %errorlevel% neq 0 (
    echo [警告] 提交失败，可能没有新更改
)

echo [6/6] 推送到GitHub...
git branch -M main
git push -u origin main

if %errorlevel% equ 0 (
    echo.
    echo ========================================
    echo [成功] 代码已推送到GitHub！
    echo ========================================
    echo.
    echo 查看仓库: https://github.com/starrats111/VitaHaven
    echo.
) else (
    echo.
    echo ========================================
    echo [错误] 推送失败
    echo ========================================
    echo.
    echo 可能的原因:
    echo 1. 需要GitHub认证（用户名和Personal Access Token）
    echo 2. 网络连接问题
    echo 3. 仓库权限问题
    echo.
    echo 请查看上面的错误信息
    echo.
)

pause


