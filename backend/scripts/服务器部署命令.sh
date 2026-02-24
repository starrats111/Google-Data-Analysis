#!/bin/bash
# 服务器端部署命令 - 纯API分析功能

# ==========================================
# 一键部署命令（复制整个代码块执行）
# ==========================================

cd ~/Google-Data-Analysis/backend && \
source venv/bin/activate && \
chmod +x scripts/deploy_api_only_analysis.sh && \
./scripts/deploy_api_only_analysis.sh

# ==========================================
# 或者分步执行：
# ==========================================

# 步骤1: 进入目录并激活环境
cd ~/Google-Data-Analysis/backend
source venv/bin/activate

# 步骤2: 运行部署脚本
chmod +x scripts/deploy_api_only_analysis.sh
./scripts/deploy_api_only_analysis.sh

# 如果脚本不存在，手动执行以下命令：

# 步骤3: 创建新服务文件（需要手动创建，内容较长）
# 见下面的 Python 代码块

# 步骤4: 修复 analysis.py（使用 Python 脚本）
python3 << 'EOF'
import re

file_path = 'app/api/analysis.py'
with open(file_path, 'r', encoding='utf-8') as f:
    content = f.read()

# 添加导入
if 'ApiOnlyAnalysisService' not in content:
    content = content.replace(
        'from app.services.api_analysis_service import ApiAnalysisService',
        'from app.services.api_analysis_service import ApiAnalysisService\nfrom app.services.api_only_analysis_service import ApiOnlyAnalysisService'
    )

# 替换 /process 端点
content = re.sub(
    r'@router\.post\("/process"\).*?return response_data',
    '''@router.post("/process")
async def process_analysis(
    request: AnalysisRequest,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db)
):
    """触发数据分析（已废弃 - 手动上传功能）"""
    raise HTTPException(
        status_code=410,
        detail="此端点已废弃。请使用 /api/analysis/generate 从API数据生成分析结果"
    )''',
    content,
    flags=re.DOTALL
)

# 添加 /generate 端点（如果不存在）
if '@router.post("/generate")' not in content:
    generate_code = '''

@router.post("/generate")
async def generate_analysis_from_api(
    begin_date: str = Query(..., description="开始日期 YYYY-MM-DD"),
    end_date: str = Query(..., description="结束日期 YYYY-MM-DD"),
    account_id: Optional[int] = Query(None, description="账号ID（可选）"),
    platform_id: Optional[int] = Query(None, description="平台ID（可选）"),
    analysis_type: str = Query("l7d", description="分析类型：daily 或 l7d"),
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db)
):
    """从API数据生成分析结果（符合表6格式）"""
    from datetime import datetime
    
    try:
        begin = datetime.strptime(begin_date, "%Y-%m-%d").date()
        end = datetime.strptime(end_date, "%Y-%m-%d").date()
    except ValueError:
        raise HTTPException(status_code=400, detail="日期格式错误，应为 YYYY-MM-DD")
    
    if begin > end:
        raise HTTPException(status_code=400, detail="开始日期不能晚于结束日期")
    
    user_id = current_user.id if current_user.role == "employee" else None
    
    from app.services.api_only_analysis_service import ApiOnlyAnalysisService
    api_only_service = ApiOnlyAnalysisService(db)
    result = api_only_service.generate_analysis_from_api(
        begin_date=begin,
        end_date=end,
        user_id=user_id,
        account_id=account_id,
        platform_id=platform_id,
        analysis_type=analysis_type
    )
    
    if not result.get("success"):
        raise HTTPException(status_code=500, detail=result.get("message", "生成分析失败"))
    
    return result
'''
    content = content.replace(
        '    raise HTTPException(\n        status_code=410,',
        '    raise HTTPException(\n        status_code=410,' + generate_code
    )

with open(file_path, 'w', encoding='utf-8') as f:
    f.write(content)

print("✓ 已修复 analysis.py")
EOF

# 步骤5: 重启服务
pkill -9 -f "uvicorn.*app.main" || true
sleep 2
nohup uvicorn app.main:app --host 0.0.0.0 --port 8000 > run.log 2>&1 &
sleep 3
curl -s http://127.0.0.1:8000/health && echo "" && echo "✓ 服务运行正常"


















