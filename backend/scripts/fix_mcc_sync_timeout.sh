#!/bin/bash
# 修复MCC同步超时问题：使用BackgroundTasks处理日期范围同步

cd ~/Google-Data-Analysis/backend
source venv/bin/activate

echo "=========================================="
echo "修复MCC同步超时问题"
echo "=========================================="
echo ""

# 备份
cp app/api/mcc.py "app/api/mcc.py.bak.$(date +%F_%H%M%S)" || true

# 修复：添加BackgroundTasks支持
python3 << 'EOF'
import re

file_path = 'app/api/mcc.py'

with open(file_path, 'r', encoding='utf-8') as f:
    content = f.read()

# 1. 添加 BackgroundTasks 导入
if 'BackgroundTasks' not in content:
    content = content.replace(
        'from fastapi import APIRouter, Depends, HTTPException',
        'from fastapi import APIRouter, Depends, HTTPException, BackgroundTasks'
    )

# 2. 添加 JSONResponse 导入（用于返回202）
if 'from fastapi.responses import JSONResponse' not in content:
    content = content.replace(
        'from fastapi import APIRouter, Depends, HTTPException, BackgroundTasks',
        'from fastapi import APIRouter, Depends, HTTPException, BackgroundTasks\nfrom fastapi.responses import JSONResponse'
    )

# 3. 修改 sync_mcc_data 函数签名，添加 background_tasks 参数
if 'async def sync_mcc_data(' in content and 'background_tasks: BackgroundTasks' not in content:
    # 找到函数定义
    pattern = r'async def sync_mcc_data\(\s*mcc_id: int,\s*request_data: Optional\[dict\] = None,\s*current_user: User = Depends\(get_current_user\),\s*db: Session = Depends\(get_db\)\s*\):'
    replacement = '''async def sync_mcc_data(
    mcc_id: int,
    request_data: Optional[dict] = None,
    request: Request = None,
    background_tasks: BackgroundTasks = None,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db)
):'''
    content = re.sub(pattern, replacement, content, flags=re.MULTILINE)

# 4. 添加 Request 导入（如果需要）
if 'from fastapi import' in content and 'Request' not in content:
    content = content.replace(
        'from fastapi import APIRouter, Depends, HTTPException, BackgroundTasks',
        'from fastapi import APIRouter, Depends, HTTPException, BackgroundTasks, Request'
    )

# 5. 修改日期范围同步逻辑：使用后台任务
# 找到日期范围同步的部分
if 'if begin_date and end_date:' in content:
    # 创建后台任务函数（在文件开头添加）
    background_func = '''
def _sync_mcc_range_in_background(mcc_id: int, begin: date, end: date, user_id: int):
    """后台任务：同步MCC日期范围数据"""
    import logging
    from app.database import SessionLocal
    from app.services.google_ads_api_sync import GoogleAdsApiSyncService
    
    logger = logging.getLogger(__name__)
    db = SessionLocal()
    
    try:
        sync_service = GoogleAdsApiSyncService(db)
        current_date = begin
        total_saved = 0
        errors = []
        
        while current_date <= end:
            try:
                result = sync_service.sync_mcc_data(mcc_id, current_date)
                if result.get("success"):
                    total_saved += result.get("saved_count", 0)
                else:
                    errors.append(f"{current_date.isoformat()}: {result.get('message', '同步失败')}")
            except Exception as e:
                errors.append(f"{current_date.isoformat()}: {str(e)}")
            current_date += timedelta(days=1)
        
        logger.info(f"MCC {mcc_id} 后台同步完成: 保存 {total_saved} 条，错误 {len(errors)} 个")
    except Exception as e:
        logger.error(f"MCC {mcc_id} 后台同步异常: {e}", exc_info=True)
    finally:
        db.close()

'''
    
    # 在 router 定义后添加后台函数
    if '_sync_mcc_range_in_background' not in content:
        content = content.replace(
            'router = APIRouter(prefix="/api/mcc", tags=["mcc"])',
            'router = APIRouter(prefix="/api/mcc", tags=["mcc"])' + background_func
        )
    
    # 修改日期范围同步逻辑：使用后台任务
    old_range_sync = r'if begin_date and end_date:.*?else:'
    new_range_sync = '''if begin_date and end_date:
            try:
                begin = datetime.strptime(begin_date, "%Y-%m-%d").date()
                end = datetime.strptime(end_date, "%Y-%m-%d").date()
            
                if begin > end:
                    raise HTTPException(status_code=400, detail="开始日期不能晚于结束日期")
            
                # 使用后台任务处理日期范围同步，避免超时
                if background_tasks:
                    background_tasks.add_task(
                        _sync_mcc_range_in_background,
                        mcc_id=mcc_id,
                        begin=begin,
                        end=end,
                        user_id=current_user.id
                    )
                    
                    # 获取CORS头
                    origin = request.headers.get("origin") if request else None
                    from app.main import get_cors_headers
                    cors_headers = get_cors_headers(origin)
                    
                    return JSONResponse(
                        status_code=202,
                        content={
                            "success": True,
                            "async": True,
                            "message": f"已开始后台同步：{begin.isoformat()} ~ {end.isoformat()}（请稍后刷新查看结果）",
                            "begin_date": begin.isoformat(),
                            "end_date": end.isoformat()
                        },
                        headers=cors_headers
                    )
            
                # 如果没有background_tasks（兼容旧代码），使用同步方式
                total_saved = 0
                current_date = begin
                errors = []
                warnings = []
            
                while current_date <= end:
                    result = sync_service.sync_mcc_data(mcc_id, current_date)
                    if result.get("success"):
                        saved_count = result.get("saved_count", 0)
                        total_saved += saved_count
                        if saved_count == 0:
                            warnings.append(f"{current_date.isoformat()}: 同步成功但该日期没有广告系列数据")
                    else:
                        errors.append(f"{current_date.isoformat()}: {result.get('message', '同步失败')}")
                    current_date += timedelta(days=1)
            
                if errors and total_saved > 0:
                    return {
                        "success": True,
                        "message": f"同步完成，成功保存 {total_saved} 条记录，部分日期同步失败",
                        "saved_count": total_saved,
                        "errors": errors,
                        "warnings": warnings if warnings else None
                    }
                elif errors and total_saved == 0:
                    error_summary = errors[0] if len(errors) == 1 else f"{len(errors)} 个日期同步失败"
                    return {
                        "success": False,
                        "message": f"同步失败：{error_summary}",
                        "saved_count": 0,
                        "errors": errors,
                        "warnings": warnings if warnings else None
                    }
                elif total_saved == 0 and warnings:
                    warning_summary = warnings[0] if len(warnings) == 1 else f"所有日期都没有广告系列数据"
                    return {
                        "success": True,
                        "message": f"同步完成，但没有保存任何数据。{warning_summary}",
                        "saved_count": 0,
                        "warnings": warnings
                    }
                else:
                    return {
                        "success": True,
                        "message": f"成功同步 {total_saved} 条广告系列数据",
                        "saved_count": total_saved
                    }
            except ValueError:
                raise HTTPException(status_code=400, detail="日期格式错误，应为 YYYY-MM-DD")
        
        # 如果提供了单个日期，同步该日期
        elif target_date:'''
    
    # 使用更精确的替换
    content = re.sub(
        r'if begin_date and end_date:.*?else:',
        new_range_sync,
        content,
        flags=re.DOTALL
    )

with open(file_path, 'w', encoding='utf-8') as f:
    f.write(content)

print("✓ 已修复MCC同步超时问题")
EOF

# 验证语法
echo ""
echo "验证语法..."
python3 -m py_compile app/api/mcc.py && echo "✓ 语法正确" || {
    echo "✗ 语法错误，恢复备份"
    cp "app/api/mcc.py.bak."* app/api/mcc.py 2>/dev/null || true
    exit 1
}

# 重启服务
echo ""
echo "重启服务..."
pkill -9 -f "uvicorn.*app.main" || true
sleep 2
nohup uvicorn app.main:app --host 0.0.0.0 --port 8000 > run.log 2>&1 &
sleep 3

# 测试
echo ""
echo "测试服务..."
curl -s http://127.0.0.1:8000/health && echo "" && echo "✓ 服务运行正常"

echo ""
echo "=========================================="
echo "修复完成"
echo "=========================================="
echo ""
echo "现在MCC同步会："
echo "1. 日期范围同步 → 后台任务（立即返回202）"
echo "2. 单个日期同步 → 同步执行（通常很快）"
echo ""
echo "前端需要处理 202 响应，显示'已开始后台同步'提示"



















