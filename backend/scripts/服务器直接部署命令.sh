#!/bin/bash
# 直接在服务器上执行的部署命令

cd ~/Google-Data-Analysis/backend
source venv/bin/activate

# ==========================================
# 步骤1: 创建新服务文件
# ==========================================
echo "1. 创建新服务文件..."

mkdir -p app/services

cat > app/services/api_only_analysis_service.py << 'EOFPYTHON'
"""
纯API数据分析服务
完全基于API数据生成分析结果，输出格式符合表6要求
去除所有手动上传功能
"""
from datetime import date, timedelta
from typing import Dict, List, Optional
from sqlalchemy.orm import Session
from sqlalchemy import func, and_, or_
import logging

from app.models.platform_data import PlatformData
from app.models.google_ads_api_data import GoogleAdsApiData
from app.models.affiliate_account import AffiliateAccount, AffiliatePlatform
from app.models.analysis_result import AnalysisResult

logger = logging.getLogger(__name__)


class ApiOnlyAnalysisService:
    """纯API数据分析服务 - 只从API数据生成分析结果"""
    
    def __init__(self, db: Session):
        self.db = db
    
    def generate_analysis_from_api(
        self,
        begin_date: date,
        end_date: date,
        user_id: Optional[int] = None,
        account_id: Optional[int] = None,
        platform_id: Optional[int] = None,
        analysis_type: str = "l7d"
    ) -> Dict:
        """
        从API数据生成分析结果（符合表6格式）
        
        Args:
            begin_date: 开始日期
            end_date: 结束日期
            user_id: 用户ID（可选）
            account_id: 账号ID（可选）
            platform_id: 平台ID（可选）
            analysis_type: 分析类型 'daily' 或 'l7d'
        
        Returns:
            分析结果字典，包含符合表6格式的数据
        """
        try:
            # 1. 获取Google Ads数据
            google_ads_query = self.db.query(GoogleAdsApiData).filter(
                GoogleAdsApiData.date >= begin_date,
                GoogleAdsApiData.date <= end_date
            )
            
            if user_id:
                google_ads_query = google_ads_query.filter(
                    GoogleAdsApiData.user_id == user_id
                )
            
            # 如果指定了平台ID，需要先找到对应的平台代码
            platform_code_filter = None
            if platform_id:
                platform = self.db.query(AffiliatePlatform).filter(
                    AffiliatePlatform.id == platform_id
                ).first()
                if platform:
                    platform_code_filter = platform.platform_code
            
            if platform_code_filter:
                google_ads_query = google_ads_query.filter(
                    GoogleAdsApiData.extracted_platform_code == platform_code_filter
                )
            
            google_ads_data = google_ads_query.all()
            
            if not google_ads_data:
                return {
                    "success": False,
                    "message": "未找到Google Ads数据"
                }
            
            # 2. 按广告系列分组聚合Google Ads数据
            campaigns_data = {}
            for data in google_ads_data:
                campaign_id = data.campaign_id
                campaign_name = data.campaign_name
                
                if campaign_id not in campaigns_data:
                    campaigns_data[campaign_id] = {
                        "campaign_id": campaign_id,
                        "campaign_name": campaign_name,
                        "platform_code": data.extracted_platform_code,
                        "merchant_id": data.extracted_account_code,
                        "status": data.status or "未知",
                        "dates": set(),
                        "total_budget": 0,
                        "total_cost": 0,
                        "total_impressions": 0,
                        "total_clicks": 0,
                        "max_cpc": 0,
                        "is_budget_lost": 0,
                        "is_rank_lost": 0,
                        "user_id": data.user_id,
                    }
                
                campaigns_data[campaign_id]["dates"].add(data.date)
                campaigns_data[campaign_id]["total_budget"] += data.budget or 0
                campaigns_data[campaign_id]["total_cost"] += data.cost or 0
                campaigns_data[campaign_id]["total_impressions"] += data.impressions or 0
                campaigns_data[campaign_id]["total_clicks"] += data.clicks or 0
                campaigns_data[campaign_id]["max_cpc"] = max(
                    campaigns_data[campaign_id]["max_cpc"],
                    data.cpc or 0
                )
                campaigns_data[campaign_id]["is_budget_lost"] = max(
                    campaigns_data[campaign_id]["is_budget_lost"],
                    data.is_budget_lost or 0
                )
                campaigns_data[campaign_id]["is_rank_lost"] = max(
                    campaigns_data[campaign_id]["is_rank_lost"],
                    data.is_rank_lost or 0
                )
            
            # 3. 获取平台数据
            platform_data_query = self.db.query(PlatformData).filter(
                PlatformData.date >= begin_date,
                PlatformData.date <= end_date
            )
            
            if user_id:
                platform_data_query = platform_data_query.filter(
                    PlatformData.user_id == user_id
                )
            
            if account_id:
                platform_data_query = platform_data_query.filter(
                    PlatformData.affiliate_account_id == account_id
                )
            
            if platform_id:
                platform_data_query = platform_data_query.join(
                    AffiliateAccount
                ).filter(
                    AffiliateAccount.platform_id == platform_id
                )
            
            platform_data_list = platform_data_query.all()
            
            # 4. 按账号和日期聚合平台数据
            platform_by_account_date = {}
            for pd in platform_data_list:
                key = (pd.affiliate_account_id, pd.date)
                if key not in platform_by_account_date:
                    platform_by_account_date[key] = {
                        "commission": 0,
                        "orders": 0,
                    }
                platform_by_account_date[key]["commission"] += pd.commission or 0
                platform_by_account_date[key]["orders"] += pd.orders or 0
            
            # 5. 匹配Google Ads数据和平台数据，生成分析结果
            analysis_results = []
            
            for campaign_id, campaign_data in campaigns_data.items():
                # 查找对应的联盟账号
                affiliate_account = self._find_affiliate_account(
                    campaign_data["platform_code"],
                    campaign_data["merchant_id"],
                    campaign_data["user_id"],
                    account_id=account_id
                )
                
                if not affiliate_account:
                    continue
                
                # 如果指定了账号ID，确保匹配
                if account_id and affiliate_account.id != account_id:
                    continue
                
                # 如果指定了平台ID，确保匹配
                if platform_id and affiliate_account.platform_id != platform_id:
                    continue
                
                # 计算该广告系列对应账号在日期范围内的平台数据
                total_commission = 0
                total_orders = 0
                order_days = set()
                
                for pd in platform_data_list:
                    if pd.affiliate_account_id == affiliate_account.id:
                        if pd.date in campaign_data["dates"]:
                            total_commission += pd.commission or 0
                            total_orders += pd.orders or 0
                            if pd.orders and pd.orders > 0:
                                order_days.add(pd.date)
                
                # 计算指标
                cost = campaign_data["total_cost"]
                clicks = campaign_data["total_clicks"]
                impressions = campaign_data["total_impressions"]
                cpc = clicks > 0 and cost / clicks or 0
                commission = total_commission
                orders = total_orders
                order_days_count = len(order_days)
                
                # 计算保守指标
                conservative_commission = commission * 0.72
                conservative_epc = clicks > 0 and conservative_commission / clicks or 0
                conservative_roi = cost > 0 and ((conservative_commission - cost) / cost) or None
                
                # 生成操作指令
                operation_instruction = self._generate_operation_instruction(
                    cost, clicks, commission, orders,
                    campaign_data["is_budget_lost"], campaign_data["is_rank_lost"],
                    order_days_count
                )
                
                # 构建符合表6格式的分析结果
                result_row = {
                    # 基础信息
                    "日期": end_date.isoformat() if analysis_type == "daily" else f"{begin_date.isoformat()}~{end_date.isoformat()}",
                    "广告系列名": campaign_data["campaign_name"],
                    "MID": campaign_data["merchant_id"],
                    "平台": affiliate_account.platform.platform_name if affiliate_account.platform else None,
                    "账号": affiliate_account.account_name,
                    "账号ID": affiliate_account.id,
                    
                    # Google Ads指标
                    "预算": round(campaign_data["total_budget"], 2),
                    "费用": round(cost, 2),
                    "展示": int(impressions),
                    "点击": int(clicks),
                    "CPC": round(cpc, 4),
                    "最高CPC": round(campaign_data["max_cpc"], 4),
                    "IS Budget丢失": round(campaign_data["is_budget_lost"] * 100, 2) if campaign_data["is_budget_lost"] else None,
                    "IS Rank丢失": round(campaign_data["is_rank_lost"] * 100, 2) if campaign_data["is_rank_lost"] else None,
                    "谷歌状态": campaign_data["status"],
                    
                    # 平台数据指标
                    "订单数": int(orders),
                    "佣金": round(commission, 2),
                    "出单天数": order_days_count,
                    
                    # 计算指标
                    "保守佣金": round(conservative_commission, 2),
                    "保守EPC": round(conservative_epc, 4),
                    "保守ROI": round(conservative_roi * 100, 2) if conservative_roi is not None else None,
                    
                    # L7D指标（如果是L7D分析）
                    "L7D点击": int(clicks) if analysis_type == "l7d" else None,
                    "L7D佣金": round(commission, 2) if analysis_type == "l7d" else None,
                    "L7D花费": round(cost, 2) if analysis_type == "l7d" else None,
                    "L7D出单天数": order_days_count if analysis_type == "l7d" else None,
                    
                    # 其他
                    "当前Max CPC": round(campaign_data["max_cpc"], 4),
                    "操作指令": operation_instruction,
                    "异常类型": None,
                }
                
                analysis_results.append(result_row)
            
            return {
                "success": True,
                "begin_date": begin_date.isoformat(),
                "end_date": end_date.isoformat(),
                "analysis_type": analysis_type,
                "total_records": len(analysis_results),
                "data": analysis_results
            }
            
        except Exception as e:
            logger.error(f"生成分析失败: {e}", exc_info=True)
            self.db.rollback()
            return {
                "success": False,
                "message": f"生成分析失败: {str(e)}"
            }
    
    def _find_affiliate_account(
        self,
        platform_code: Optional[str],
        merchant_id: Optional[str],
        user_id: int,
        account_id: Optional[int] = None
    ) -> Optional[AffiliateAccount]:
        """查找对应的联盟账号"""
        if not platform_code:
            return None
        
        # 如果指定了账号ID，直接查找
        if account_id:
            account = self.db.query(AffiliateAccount).filter(
                AffiliateAccount.id == account_id,
                AffiliateAccount.user_id == user_id,
                AffiliateAccount.is_active == True
            ).first()
            if account:
                # 验证平台代码是否匹配
                if account.platform and account.platform.platform_code == platform_code.upper():
                    return account
            return None
        
        # 否则按平台代码和商家ID查找
        query = self.db.query(AffiliateAccount).join(
            AffiliatePlatform
        ).filter(
            AffiliateAccount.user_id == user_id,
            AffiliatePlatform.platform_code == platform_code.upper(),
            AffiliateAccount.is_active == True
        )
        
        if merchant_id:
            query = query.filter(AffiliateAccount.account_code == merchant_id)
        
        account = query.first()
        
        if account:
            return account
        
        # 如果没找到匹配的账号代码，返回该平台下的第一个账号
        if not merchant_id:
            account = query.first()
            if account:
                return account
        
        return None
    
    def _generate_operation_instruction(
        self,
        cost: float,
        clicks: float,
        commission: float,
        orders: int,
        is_budget_lost: float,
        is_rank_lost: float,
        order_days: int
    ) -> str:
        """生成操作指令"""
        instructions = []
        
        # 预算丢失判断
        if is_budget_lost and is_budget_lost > 0.1:
            instructions.append(f"预算丢失{is_budget_lost*100:.1f}%，建议增加预算")
        
        # Rank丢失判断
        if is_rank_lost and is_rank_lost > 0.1:
            instructions.append(f"排名丢失{is_rank_lost*100:.1f}%，建议提高出价")
        
        # ROI判断
        if clicks > 0:
            roi = cost > 0 and ((commission * 0.72 - cost) / cost) * 100 or 0
            if roi < 0:
                instructions.append("ROI为负，建议暂停或优化")
            elif roi < 20:
                instructions.append("ROI较低，建议优化")
        
        # 出单天数判断
        if order_days < 3:
            instructions.append("出单天数较少，建议优化")
        
        if not instructions:
            return "数据正常，保持现状"
        
        return "；".join(instructions)
EOFPYTHON

echo "   ✓ 已创建 api_only_analysis_service.py"
echo ""

# ==========================================
# 步骤2: 修复 analysis.py
# ==========================================
echo "2. 修复 analysis.py..."

python3 << 'EOFPYTHON'
import re

file_path = 'app/api/analysis.py'

# 读取文件
with open(file_path, 'r', encoding='utf-8') as f:
    content = f.read()

# 1. 添加导入
if 'ApiOnlyAnalysisService' not in content:
    # 查找导入语句的位置
    if 'from app.services.api_analysis_service import ApiAnalysisService' in content:
        content = content.replace(
            'from app.services.api_analysis_service import ApiAnalysisService',
            'from app.services.api_analysis_service import ApiAnalysisService\nfrom app.services.api_only_analysis_service import ApiOnlyAnalysisService'
        )
    else:
        # 如果找不到，在文件开头添加
        lines = content.split('\n')
        import_line = -1
        for i, line in enumerate(lines):
            if 'from app.services' in line or 'from app.api' in line:
                import_line = i
                break
        if import_line >= 0:
            lines.insert(import_line + 1, 'from app.services.api_only_analysis_service import ApiOnlyAnalysisService')
            content = '\n'.join(lines)

# 2. 替换 /process 端点（如果存在）
if '@router.post("/process")' in content:
    old_process_pattern = r'@router\.post\("/process"\).*?(?=@router\.|def |$)'
    new_process_code = '''@router.post("/process")
async def process_analysis(
    request: AnalysisRequest,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db)
):
    """
    触发数据分析（已废弃 - 手动上传功能）
    
    此端点已废弃，请使用 /api/analysis/generate 从API数据生成分析结果
    """
    raise HTTPException(
        status_code=410,
        detail="此端点已废弃。请使用 /api/analysis/generate 从API数据生成分析结果"
    )'''
    
    content = re.sub(old_process_pattern, new_process_code, content, flags=re.DOTALL)

# 3. 添加新的 /generate 端点（如果不存在）
if '@router.post("/generate")' not in content:
    generate_endpoint = '''

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
    """
    从API数据生成分析结果（符合表6格式）
    
    完全基于API数据，无需手动上传文件
    输出格式符合表6模板要求
    
    Args:
        begin_date: 开始日期 YYYY-MM-DD
        end_date: 结束日期 YYYY-MM-DD
        account_id: 账号ID（可选）
        platform_id: 平台ID（可选）
        analysis_type: 分析类型 'daily' 或 'l7d'
    """
    from datetime import datetime
    
    try:
        begin = datetime.strptime(begin_date, "%Y-%m-%d").date()
        end = datetime.strptime(end_date, "%Y-%m-%d").date()
    except ValueError:
        raise HTTPException(status_code=400, detail="日期格式错误，应为 YYYY-MM-DD")
    
    if begin > end:
        raise HTTPException(status_code=400, detail="开始日期不能晚于结束日期")
    
    # 权限检查：员工只能分析自己的数据
    user_id = current_user.id if current_user.role == "employee" else None
    
    # 使用新的纯API分析服务
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
    
    # 在文件末尾添加
    content = content.rstrip() + '\n' + generate_endpoint

# 保存文件
with open(file_path, 'w', encoding='utf-8') as f:
    f.write(content)

print("   ✓ 已修复 analysis.py")
EOFPYTHON

echo ""

# ==========================================
# 步骤3: 验证代码
# ==========================================
echo "3. 验证代码..."
python3 -c "
try:
    from app.services.api_only_analysis_service import ApiOnlyAnalysisService
    print('   ✓ 新服务导入成功')
except Exception as e:
    print(f'   ✗ 新服务导入失败: {e}')
    exit(1)

try:
    from app.api.analysis import router
    print('   ✓ API路由导入成功')
except Exception as e:
    print(f'   ✗ API路由导入失败: {e}')
    exit(1)
" || exit 1
echo ""

# ==========================================
# 步骤4: 重启服务
# ==========================================
echo "4. 重启服务..."
pkill -9 -f "uvicorn.*app.main" || true
sleep 2
nohup uvicorn app.main:app --host 0.0.0.0 --port 8000 > run.log 2>&1 &
UVICORN_PID=$!
echo "   服务进程 ID: $UVICORN_PID"
echo ""

# ==========================================
# 步骤5: 等待服务启动
# ==========================================
echo "5. 等待服务启动（最多10秒）..."
for i in {1..10}; do
    sleep 1
    HTTP_CODE=$(curl -s -o /dev/null -w "%{http_code}" http://127.0.0.1:8000/health 2>/dev/null || echo "000")
    if [ "$HTTP_CODE" = "200" ]; then
        echo "   ✓ 服务启动成功 (HTTP $HTTP_CODE)"
        break
    else
        if [ $i -le 5 ]; then
            echo "   等待中... ($i/10)"
        fi
    fi
done
echo ""

# ==========================================
# 步骤6: 最终检查
# ==========================================
echo "6. 最终健康检查..."
FINAL_HTTP_CODE=$(curl -s -o /dev/null -w "%{http_code}" http://127.0.0.1:8000/health 2>/dev/null || echo "000")
FINAL_RESPONSE=$(curl -s http://127.0.0.1:8000/health 2>/dev/null || echo "ERROR")

if [ "$FINAL_HTTP_CODE" = "200" ]; then
    echo "   ✓ 后端服务运行正常"
    echo "   响应: $FINAL_RESPONSE"
    echo ""
    echo "=========================================="
    echo "✓ 部署完成！"
    echo "=========================================="
    echo ""
    echo "新的API端点："
    echo "  POST /api/analysis/generate?begin_date=YYYY-MM-DD&end_date=YYYY-MM-DD&analysis_type=l7d"
    echo ""
    echo "测试命令："
    echo "  TOKEN=\$(curl -s -X POST \"http://127.0.0.1:8000/api/auth/login\" \\"
    echo "    -H \"Content-Type: application/x-www-form-urlencoded\" \\"
    echo "    -d \"username=wj07&password=wj123456\" | \\"
    echo "    python3 -c \"import sys, json; print(json.load(sys.stdin)['access_token'])\")"
    echo ""
    echo "  curl -X POST \"http://127.0.0.1:8000/api/analysis/generate?begin_date=2026-01-28&end_date=2026-02-04&analysis_type=l7d\" \\"
    echo "    -H \"Authorization: Bearer \$TOKEN\" | python3 -m json.tool"
    exit 0
else
    echo "   ✗ 后端服务启动失败 (HTTP $FINAL_HTTP_CODE)"
    echo "   响应: $FINAL_RESPONSE"
    echo ""
    echo "   查看错误日志:"
    tail -n 30 run.log
    echo ""
    echo "=========================================="
    echo "✗ 部署失败，请检查日志"
    echo "=========================================="
    exit 1
fi

















