# 重启后端服务器 (PowerShell脚本)
# 使用方法: .\restart_backend.ps1

Write-Host "=== 重启后端服务器 ===" -ForegroundColor Cyan

# 切换到backend目录
$backendDir = Split-Path -Parent $PSScriptRoot
Set-Location $backendDir

Write-Host "`n=== 停止现有服务器 ===" -ForegroundColor Yellow
# 查找并停止uvicorn进程
$processes = Get-Process | Where-Object { $_.ProcessName -eq "python" -or $_.ProcessName -eq "pythonw" } | Where-Object { 
    $_.CommandLine -like "*uvicorn*app.main*" -or 
    $_.CommandLine -like "*uvicorn*main*"
}
if ($processes) {
    Write-Host "找到运行中的服务器进程，正在停止..." -ForegroundColor Yellow
    $processes | ForEach-Object { 
        Stop-Process -Id $_.Id -Force -ErrorAction SilentlyContinue
        Write-Host "  已停止进程: $($_.Id)" -ForegroundColor Gray
    }
    Start-Sleep -Seconds 2
} else {
    Write-Host "没有运行中的服务器" -ForegroundColor Gray
}

# 尝试通过端口8000查找进程
$portProcess = Get-NetTCPConnection -LocalPort 8000 -ErrorAction SilentlyContinue | Select-Object -ExpandProperty OwningProcess -Unique
if ($portProcess) {
    Write-Host "发现端口8000被占用，正在停止进程..." -ForegroundColor Yellow
    Stop-Process -Id $portProcess -Force -ErrorAction SilentlyContinue
    Start-Sleep -Seconds 2
}

Write-Host "`n=== 激活虚拟环境 ===" -ForegroundColor Yellow
# 检查虚拟环境
$venvPath = Join-Path $backendDir "venv"
if (-not (Test-Path $venvPath)) {
    Write-Host "错误: 虚拟环境不存在，请先创建虚拟环境" -ForegroundColor Red
    exit 1
}

# 激活虚拟环境
$activateScript = Join-Path $venvPath "Scripts\Activate.ps1"
if (Test-Path $activateScript) {
    & $activateScript
    Write-Host "虚拟环境已激活" -ForegroundColor Green
} else {
    Write-Host "警告: 无法找到激活脚本，尝试直接使用python" -ForegroundColor Yellow
}

Write-Host "`n=== 启动服务器 ===" -ForegroundColor Yellow
# 启动服务器
$pythonExe = Join-Path $venvPath "Scripts\python.exe"
if (-not (Test-Path $pythonExe)) {
    $pythonExe = "python"
}

$logFile = Join-Path $backendDir "run.log"
$startInfo = New-Object System.Diagnostics.ProcessStartInfo
$startInfo.FileName = $pythonExe
$startInfo.Arguments = "-m uvicorn app.main:app --host 0.0.0.0 --port 8000"
$startInfo.WorkingDirectory = $backendDir
$startInfo.UseShellExecute = $false
$startInfo.RedirectStandardOutput = $true
$startInfo.RedirectStandardError = $true
$startInfo.CreateNoWindow = $true

# 启动进程并重定向输出到日志文件
$process = New-Object System.Diagnostics.Process
$process.StartInfo = $startInfo
$process.Start() | Out-Null

# 将输出重定向到日志文件
$process.StandardOutput | Out-File -FilePath $logFile -Append
$process.StandardError | Out-File -FilePath $logFile -Append

Write-Host "服务器正在启动..." -ForegroundColor Green
Start-Sleep -Seconds 3

Write-Host "`n=== 检查服务器状态 ===" -ForegroundColor Yellow
try {
    $response = Invoke-WebRequest -Uri "http://127.0.0.1:8000/health" -TimeoutSec 5 -ErrorAction Stop
    if ($response.StatusCode -eq 200) {
        Write-Host "✓ 后端服务器启动成功" -ForegroundColor Green
        $processId = Get-NetTCPConnection -LocalPort 8000 -ErrorAction SilentlyContinue | Select-Object -ExpandProperty OwningProcess -Unique
        if ($processId) {
            Write-Host "进程ID: $processId" -ForegroundColor Gray
        }
        Write-Host "访问地址: http://127.0.0.1:8000" -ForegroundColor Gray
        Write-Host "API文档: http://127.0.0.1:8000/docs" -ForegroundColor Gray
    }
} catch {
    Write-Host "✗ 后端服务器启动失败或未响应" -ForegroundColor Red
    Write-Host "查看日志文件: $logFile" -ForegroundColor Yellow
    if (Test-Path $logFile) {
        Write-Host "`n最近20行日志:" -ForegroundColor Yellow
        Get-Content $logFile -Tail 20
    }
}

Write-Host "`n=== 重启完成 ===" -ForegroundColor Cyan

