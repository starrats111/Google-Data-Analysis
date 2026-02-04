"""
数据分析API
"""
from typing import List, Optional
from fastapi import APIRouter, Depends, HTTPException, status, UploadFile, File, Form, Query
from sqlalchemy.orm import Session

from app.database import get_db
from app.middleware.auth import get_current_user
from app.models.user import User, UserRole
from app.models.analysis_result import AnalysisResult
import logging

logger = logging.getLogger(__name__)
from app.models.data_upload import DataUpload
from app.schemas.analysis import AnalysisRequest, AnalysisResultResponse, AnalysisSummary, DailyL7DRequest
from app.services.analysis_service import AnalysisService
from app.services.api_analysis_service import ApiAnalysisService

router = APIRouter(prefix="/api/analysis", tags=["analysis"])


@router.post("/process")
async def process_analysis(
    request: AnalysisRequest,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db)
):
    """触发数据分析"""
    # 获取上传记录
    google_upload = db.query(DataUpload).filter(
        DataUpload.id == request.google_ads_upload_id
    ).first()
    affiliate_upload = db.query(DataUpload).filter(
        DataUpload.id == request.affiliate_upload_id
    ).first()
    
    if not google_upload or not affiliate_upload:
        raise HTTPException(status_code=404, detail="上传记录不存在")
    
    # 权限控制
    if current_user.role == "employee":
        if google_upload.user_id != current_user.id or affiliate_upload.user_id != current_user.id:
            raise HTTPException(status_code=403, detail="无权访问此数据")
    
    # 验证平台匹配：谷歌广告数据和联盟数据必须属于同一平台
    from app.models.affiliate_account import AffiliateAccount
    affiliate_account_id = request.affiliate_account_id or affiliate_upload.affiliate_account_id
    if not affiliate_account_id:
        raise HTTPException(status_code=400, detail="必须指定联盟账号")
    
    affiliate_account = db.query(AffiliateAccount).filter(
        AffiliateAccount.id == affiliate_account_id
    ).first()
    if not affiliate_account:
        raise HTTPException(status_code=404, detail="联盟账号不存在")
    
    # 检查平台匹配
    if google_upload.platform_id and google_upload.platform_id != affiliate_account.platform_id:
        raise HTTPException(
            status_code=400,
            detail=f"平台不匹配：谷歌广告数据属于平台ID {google_upload.platform_id}，但联盟账号属于平台ID {affiliate_account.platform_id}"
        )
    
    # 如果谷歌广告数据没有指定平台，自动设置为联盟账号的平台
    if not google_upload.platform_id:
        google_upload.platform_id = affiliate_account.platform_id
        db.commit()
    
    # 执行分析
    import logging
    logger = logging.getLogger(__name__)
    
    try:
        logger.info(f"开始分析: Google Ads文件={google_upload.file_path}, Affiliate文件={affiliate_upload.file_path}")
        analysis_service = AnalysisService()
        result = analysis_service.process_analysis(
            google_ads_file=google_upload.file_path,
            affiliate_file=affiliate_upload.file_path,
            user_id=current_user.id,
            platform_id=affiliate_account.platform_id,
            analysis_date=affiliate_upload.upload_date,
            db=db,
            affiliate_account_id=affiliate_account_id,
            analysis_type=(request.analysis_type or "l7d"),
            # 传递操作指令相关参数
            past_seven_days_orders_global=request.past_seven_days_orders_global,
            max_cpc_global=request.max_cpc_global
        )
        
        if result["status"] == "failed":
            error_msg = result.get("error", "分析失败")
            logger.error(f"分析失败: {error_msg}")
            raise HTTPException(status_code=500, detail=f"分析失败: {error_msg}")
        
        total_rows = result.get('total_rows', 0)
        logger.info(f"分析完成: 处理了 {total_rows} 行数据")
        
        # 如果结果为0行，记录诊断信息
        if total_rows == 0 and "diagnosis" in result:
            logger.warning(f"分析结果为0行，诊断信息: {result.get('diagnosis', {})}")
            logger.warning(f"警告信息: {result.get('warning', '')}")
    except HTTPException:
        # 重新抛出HTTP异常，不记录
        raise
    except Exception as e:
        import traceback
        error_detail = str(e)
        error_traceback = traceback.format_exc()
        
        # 记录详细错误信息
        logger.error(f"分析过程出错: {error_detail}")
        logger.error(f"错误堆栈:\n{error_traceback}")
        
        # 打印到控制台（开发环境）
        print(f"\n{'='*60}")
        print(f"分析错误详情:")
        print(f"{'='*60}")
        print(f"错误信息: {error_detail}")
        print(f"\n完整堆栈跟踪:")
        print(error_traceback)
        print(f"{'='*60}\n")
        
        raise HTTPException(status_code=500, detail=f"分析过程出错: {error_detail}")
    
    # 保存分析结果
    analysis_result = AnalysisResult(
        user_id=current_user.id,
        affiliate_account_id=affiliate_account_id,
        upload_id_google=google_upload.id,
        upload_id_affiliate=affiliate_upload.id,
        analysis_date=affiliate_upload.upload_date,
        result_data=result
    )
    db.add(analysis_result)
    db.commit()
    db.refresh(analysis_result)
    
    response_data = {
        "id": analysis_result.id,
        "status": "completed",
        "summary": result.get("summary", {}),
        "total_rows": result.get("total_rows", 0)
    }
    
    # 如果结果为0行，包含诊断信息
    if result.get("total_rows", 0) == 0 and "diagnosis" in result:
        response_data["diagnosis"] = result.get("diagnosis", {})
        response_data["warning"] = result.get("warning", "")
    
    return response_data


@router.get("/results", response_model=List[AnalysisResultResponse])
async def get_analysis_results(
    account_id: Optional[int] = None,
    platform_id: Optional[int] = None,
    start_date: Optional[str] = None,
    end_date: Optional[str] = None,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db)
):
    """获取分析结果列表"""
    from app.models.affiliate_account import AffiliateAccount
    from app.models.user import User as UserModel
    
    query = db.query(AnalysisResult).join(UserModel, AnalysisResult.user_id == UserModel.id)
    
    # 权限控制
    if current_user.role == "employee":
        query = query.filter(AnalysisResult.user_id == current_user.id)
    
    # 筛选条件
    if account_id:
        query = query.filter(AnalysisResult.affiliate_account_id == account_id)
    if platform_id:
        query = query.join(AffiliateAccount).filter(
            AffiliateAccount.platform_id == platform_id
        )
    if start_date:
        query = query.filter(AnalysisResult.analysis_date >= start_date)
    if end_date:
        query = query.filter(AnalysisResult.analysis_date <= end_date)
    
    results = query.order_by(AnalysisResult.analysis_date.desc()).all()
    
    # 调试日志：记录查询结果
    import logging
    logger = logging.getLogger(__name__)
    logger.info(f"查询分析结果: 用户={current_user.username}({current_user.id}), 角色={current_user.role}, "
                f"账号ID={account_id}, 日期范围={start_date}~{end_date}, 结果数={len(results)}")
    
    # 构建响应，包含用户名
    response_list = []
    for result in results:
        user = db.query(UserModel).filter(UserModel.id == result.user_id).first()
        data_rows = result.result_data.get('data', []) if isinstance(result.result_data, dict) else []
        logger.debug(f"分析结果 {result.id}: 用户={user.username if user else result.user_id}, "
                    f"日期={result.analysis_date}, 数据行数={len(data_rows)}")
        response_list.append(AnalysisResultResponse(
            id=result.id,
            user_id=result.user_id,
            username=user.username if user else None,
            affiliate_account_id=result.affiliate_account_id,
            analysis_date=result.analysis_date,
            result_data=result.result_data,
            created_at=result.created_at,
        ))
    
    return response_list


@router.get("/results/{result_id}", response_model=AnalysisResultResponse)
async def get_analysis_result(
    result_id: int,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db)
):
    """获取分析结果详情"""
    result = db.query(AnalysisResult).filter(AnalysisResult.id == result_id).first()
    if not result:
        raise HTTPException(status_code=404, detail="分析结果不存在")
    
    # 权限控制
    if current_user.role == "employee" and result.user_id != current_user.id:
        raise HTTPException(status_code=403, detail="无权访问此结果")
    
    return result


@router.delete("/results/{result_id}", status_code=status.HTTP_204_NO_CONTENT)
async def delete_analysis_result(
    result_id: int,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db)
):
    """删除分析结果"""
    result = db.query(AnalysisResult).filter(AnalysisResult.id == result_id).first()
    if not result:
        raise HTTPException(status_code=404, detail="分析结果不存在")

    # 权限控制：员工只能删自己的；经理可删全部
    if current_user.role == UserRole.EMPLOYEE and result.user_id != current_user.id:
        raise HTTPException(status_code=403, detail="无权删除此结果")

    db.delete(result)
    db.commit()
    return None


@router.post("/from-daily")
async def generate_l7d_from_daily(
    request: DailyL7DRequest,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    """
    从每日指标表(ad_campaign_daily_metrics)聚合最近7天，生成一份L7D分析结果，
    并保存到 analysis_results，便于在“分析结果”页面查看。
    """
    from datetime import date, datetime, timedelta
    from collections import defaultdict
    from app.models.ad_campaign import AdCampaign
    from app.models.ad_campaign_daily_metric import AdCampaignDailyMetric
    from app.models.data_upload import DataUpload, UploadType
    from app.services.analysis_service import AnalysisService

    # 1）确定日期范围：end = 请求里的日期，默认今天；start = end - 6 天
    if request.end_date:
        try:
            end = datetime.strptime(request.end_date, "%Y-%m-%d").date()
        except Exception:
            end = date.today()
    else:
        end = date.today()
    start = end - timedelta(days=6)

    # 2.5）尝试从过去7天表1（Google Ads 上传）中提取 IS Budget丢失 / IS Rank丢失
    # - 仅用于补齐 L7D 输出中的两列；其它字段继续来自 daily metrics 聚合
    is_map = {}  # campaign_name -> {"IS Budget丢失": value, "IS Rank丢失": value}
    try:
        # 推断平台：若指定了联盟账号，则用该账号的平台ID；否则不限定平台（取用户最近7天的所有谷歌上传）
        platform_id = None
        if request.affiliate_account_id:
            from app.models.affiliate_account import AffiliateAccount
            acc = db.query(AffiliateAccount).filter(AffiliateAccount.id == request.affiliate_account_id).first()
            platform_id = acc.platform_id if acc else None

        q_upload = db.query(DataUpload).filter(
            DataUpload.upload_type == UploadType.GOOGLE_ADS,
            DataUpload.upload_date >= start,
            DataUpload.upload_date <= end,
        )
        # 员工仅看自己的上传；经理按当前用户（按钮在前端通常为员工）也只用自己的上传更安全
        q_upload = q_upload.filter(DataUpload.user_id == current_user.id)
        if platform_id:
            q_upload = q_upload.filter(DataUpload.platform_id == platform_id)

        uploads = q_upload.order_by(DataUpload.upload_date.asc()).all()
        if uploads:
            svc = AnalysisService()
            # 用“最近一天优先”的策略：同广告系列取最后一个非空值覆盖
            for up in uploads:
                df = svc._read_file(up.file_path)
                df = svc._clean_google_data(df)
                if df is None or df.empty:
                    continue
                # 需要列：广告系列 + 预算错失份额 + 排名错失份额
                if '广告系列' not in df.columns:
                    continue
                for _, r in df.iterrows():
                    name = r.get('广告系列')
                    if name is None:
                        continue
                    name = str(name).strip()
                    if not name:
                        continue
                    b = r.get('预算错失份额', None)
                    rk = r.get('排名错失份额', None)
                    # 兼容：清洗里会把份额格式化成字符串百分比
                    if name not in is_map:
                        is_map[name] = {"IS Budget丢失": None, "IS Rank丢失": None}
                    if b not in [None, '', '-']:
                        is_map[name]["IS Budget丢失"] = b
                    if rk not in [None, '', '-']:
                        is_map[name]["IS Rank丢失"] = rk
    except Exception:
        # 不影响L7D生成；缺失时前端可为空
        pass

    # 2）查出这 7 天内、当前用户相关的 daily metrics
    q = db.query(AdCampaignDailyMetric).join(AdCampaign)

    if current_user.role == UserRole.EMPLOYEE:
        q = q.filter(AdCampaignDailyMetric.user_id == current_user.id)

    if request.affiliate_account_id:
        q = q.filter(AdCampaign.affiliate_account_id == request.affiliate_account_id)

    metrics = q.filter(
        AdCampaignDailyMetric.date >= start,
        AdCampaignDailyMetric.date <= end,
    ).all()

    if not metrics:
        return {"status": "completed", "total_rows": 0, "data": [], "summary": {}}

    # 3）按 campaign_id 聚合成 L7D
    grouped = defaultdict(list)
    for m in metrics:
        grouped[m.campaign_id].append(m)

    rows = []
    # 导入分析服务用于生成操作指令
    from app.services.analysis_service import AnalysisService
    import pandas as pd
    analysis_service = AnalysisService()
    
    for campaign_id, items in grouped.items():
        clicks = sum(m.clicks or 0 for m in items)
        cost = sum(m.cost or 0 for m in items)
        comm = sum(m.commission or 0 for m in items)
        orders = sum(m.orders or 0 for m in items)
        order_days = sum(1 for m in items if (m.orders or 0) > 0)
        # 修复：MAX CPC应该是过去7天中CPC的最大值，而不是最高CPC的最大值
        max_cpc_7d = max((m.cpc or 0) for m in items) if items else 0

        roi = ((comm - cost) / cost) if cost > 0 else None
        
        # 计算保守EPC和保守ROI
        # 保守EPC = L7D佣金*0.72/L7D点击
        conservative_epc = (comm * 0.72 / clicks) if clicks > 0 else 0
        # 保守ROI = (L7D佣金*0.72-L7D花费)/L7D花费
        conservative_roi = ((comm * 0.72 - cost) / cost) if cost > 0 else None

        campaign = items[0].campaign  # 关联的 AdCampaign 记录
        is_vals = is_map.get(campaign.campaign_name, {}) if is_map else {}
        
        # 构建用于生成操作指令的行数据
        # 注意：is_vals中的"IS Budget丢失"和"IS Rank丢失"需要转换为"预算错失份额"和"排名错失份额"
        is_budget_lost = is_vals.get("IS Budget丢失")
        is_rank_lost = is_vals.get("IS Rank丢失")
        instruction_row = {
            "保守ROI": conservative_roi,
            "预算错失份额": is_budget_lost,  # IS Budget丢失 -> 预算错失份额
            "排名错失份额": is_rank_lost,  # IS Rank丢失 -> 排名错失份额
            "过去七天出单天数": order_days,
            "最高CPC": max_cpc_7d,
            "CPC": max_cpc_7d,  # 使用MAX CPC作为CPC值
            "订单": orders,
        }
        # 生成操作指令
        operation_instruction = analysis_service._generate_operation_instruction(
            pd.Series(instruction_row),
            past_seven_days_orders_global=order_days,
            max_cpc_global=max_cpc_7d
        )

        rows.append({
            "广告系列名": campaign.campaign_name,
            "账号=CID": campaign.cid_account,
            "MID": campaign.merchant_id,
            "投放国家": campaign.country,
            "L7D点击": clicks,
            "L7D佣金": comm,
            "L7D花费": cost,
            "L7D出单天数": order_days,
            "当前Max CPC": max_cpc_7d,
            "IS Budget丢失": is_budget_lost,
            "IS Rank丢失": is_rank_lost,
            "保守EPC": conservative_epc,
            "保守ROI": conservative_roi,
            "操作指令": operation_instruction,
            "ROI": roi,
            "点击": clicks,
            "订单": orders,
        })

    result = {
        "status": "completed",
        "total_rows": len(rows),
        "data": rows,
        "summary": {},
    }

    # 4）存到 analysis_results，方便前端复用“分析结果”页面
    analysis_result = AnalysisResult(
        user_id=current_user.id,
        affiliate_account_id=request.affiliate_account_id,
        upload_id_google=None,
        upload_id_affiliate=None,
        analysis_date=end,
        result_data=result,
    )
    db.add(analysis_result)
    db.commit()
    db.refresh(analysis_result)

    return {
        "id": analysis_result.id,
        "status": "completed",
        "total_rows": len(rows),
    }


@router.post("/from-daily-with-google")
async def generate_l7d_from_daily_with_google(
    affiliate_account_id: Optional[int] = Form(default=None),
    end_date: Optional[str] = Form(default=None),
    google_file: UploadFile = File(...),
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    """
    从每日指标表生成 L7D 主数据，同时额外上传“过去7天谷歌表1”，
    仅用于提取 IS Budget丢失 / IS Rank丢失（其余字段仍来自每日数据）。
    """
    from datetime import date, datetime, timedelta
    from collections import defaultdict
    from tempfile import NamedTemporaryFile
    from app.models.ad_campaign import AdCampaign
    from app.models.ad_campaign_daily_metric import AdCampaignDailyMetric
    from app.services.analysis_service import AnalysisService

    # 1）日期范围
    if end_date:
        try:
            end = datetime.strptime(end_date, "%Y-%m-%d").date()
        except Exception:
            end = date.today()
    else:
        end = date.today()
    start = end - timedelta(days=6)

    # 2）读取上传的谷歌表，提取 IS 两列（按广告系列名；若有日期列则按区间过滤，并取最近一天）
    is_map = {}
    try:
        suffix = ".xlsx"
        if google_file.filename and google_file.filename.lower().endswith(".csv"):
            suffix = ".csv"
        with NamedTemporaryFile(delete=True, suffix=suffix) as tmp:
            tmp.write(await google_file.read())
            tmp.flush()
            svc = AnalysisService()
            df = svc._read_file(tmp.name)
            df = svc._clean_google_data(df)
            if df is not None and not df.empty and '广告系列' in df.columns:
                # 可选日期列：如果存在，优先筛选最近7天
                date_col = None
                for c in df.columns:
                    cs = str(c)
                    if cs in ['日期', 'Date', 'date', 'Day', 'day']:
                        date_col = c
                        break
                if date_col:
                    try:
                        import pandas as _pd
                        dser = _pd.to_datetime(df[date_col], errors='coerce').dt.date
                        df = df.assign(__d=dser)
                        df = df[(df['__d'] >= start) & (df['__d'] <= end)].copy()
                        df = df.sort_values('__d')
                    except Exception:
                        pass

                for _, r in df.iterrows():
                    name = r.get('广告系列')
                    if name is None:
                        continue
                    name = str(name).strip()
                    if not name:
                        continue
                    b = r.get('预算错失份额', None)
                    rk = r.get('排名错失份额', None)
                    if name not in is_map:
                        is_map[name] = {"IS Budget丢失": None, "IS Rank丢失": None}
                    if b not in [None, '', '-']:
                        is_map[name]["IS Budget丢失"] = b
                    if rk not in [None, '', '-']:
                        is_map[name]["IS Rank丢失"] = rk
    except Exception as e:
        raise HTTPException(status_code=400, detail=f"读取谷歌表失败: {str(e)}")

    # 3）查 7 天 daily metrics
    q = db.query(AdCampaignDailyMetric).join(AdCampaign)
    if current_user.role == UserRole.EMPLOYEE:
        q = q.filter(AdCampaignDailyMetric.user_id == current_user.id)
    if affiliate_account_id:
        q = q.filter(AdCampaign.affiliate_account_id == affiliate_account_id)
    metrics = q.filter(
        AdCampaignDailyMetric.date >= start,
        AdCampaignDailyMetric.date <= end,
    ).all()
    if not metrics:
        return {"status": "completed", "total_rows": 0, "data": [], "summary": {}}

    # 4）按 campaign_id 聚合 + 合并 IS 两列
    grouped = defaultdict(list)
    for m in metrics:
        grouped[m.campaign_id].append(m)

    rows = []
    # 导入分析服务用于生成操作指令
    from app.services.analysis_service import AnalysisService
    import pandas as pd
    analysis_service = AnalysisService()
    
    for campaign_id, items in grouped.items():
        clicks = sum(m.clicks or 0 for m in items)
        cost = sum(m.cost or 0 for m in items)
        comm = sum(m.commission or 0 for m in items)
        orders = sum(m.orders or 0 for m in items)
        order_days = sum(1 for m in items if (m.orders or 0) > 0)
        # 修复：MAX CPC应该是过去7天中CPC的最大值，而不是最高CPC的最大值
        max_cpc_7d = max((m.cpc or 0) for m in items) if items else 0
        roi = ((comm - cost) / cost) if cost > 0 else None
        
        # 计算保守EPC和保守ROI
        # 保守EPC = L7D佣金*0.72/L7D点击
        conservative_epc = (comm * 0.72 / clicks) if clicks > 0 else 0
        # 保守ROI = (L7D佣金*0.72-L7D花费)/L7D花费
        conservative_roi = ((comm * 0.72 - cost) / cost) if cost > 0 else None

        campaign = items[0].campaign
        is_vals = is_map.get(campaign.campaign_name, {}) if is_map else {}
        
        # 构建用于生成操作指令的行数据
        # 注意：is_vals中的"IS Budget丢失"和"IS Rank丢失"需要转换为"预算错失份额"和"排名错失份额"
        is_budget_lost = is_vals.get("IS Budget丢失")
        is_rank_lost = is_vals.get("IS Rank丢失")
        instruction_row = {
            "保守ROI": conservative_roi,
            "预算错失份额": is_budget_lost,  # IS Budget丢失 -> 预算错失份额
            "排名错失份额": is_rank_lost,  # IS Rank丢失 -> 排名错失份额
            "过去七天出单天数": order_days,
            "最高CPC": max_cpc_7d,
            "CPC": max_cpc_7d,  # 使用MAX CPC作为CPC值
            "订单": orders,
        }
        # 生成操作指令
        operation_instruction = analysis_service._generate_operation_instruction(
            pd.Series(instruction_row),
            past_seven_days_orders_global=order_days,
            max_cpc_global=max_cpc_7d
        )

        rows.append({
            "广告系列名": campaign.campaign_name,
            "账号=CID": campaign.cid_account,
            "MID": campaign.merchant_id,
            "投放国家": campaign.country,
            "L7D点击": clicks,
            "L7D佣金": comm,
            "L7D花费": cost,
            "L7D出单天数": order_days,
            "当前Max CPC": max_cpc_7d,
            "IS Budget丢失": is_budget_lost,
            "IS Rank丢失": is_rank_lost,
            "保守EPC": conservative_epc,
            "保守ROI": conservative_roi,
            "操作指令": operation_instruction,
            "ROI": roi,
            "点击": clicks,
            "订单": orders,
        })

    result = {
        "status": "completed",
        "total_rows": len(rows),
        "data": rows,
        "summary": {},
    }

    analysis_result = AnalysisResult(
        user_id=current_user.id,
        affiliate_account_id=affiliate_account_id,
        upload_id_google=None,
        upload_id_affiliate=None,
        analysis_date=end,
        result_data=result,
    )
    db.add(analysis_result)
    db.commit()
    db.refresh(analysis_result)

    return {"id": analysis_result.id, "status": "completed", "total_rows": len(rows)}


@router.post("/daily")
async def generate_daily_analysis_from_api(
    target_date: str = Query(..., description="目标日期 YYYY-MM-DD"),
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db)
):
    """
    从API数据生成每日分析
    
    Args:
        target_date: 目标日期 YYYY-MM-DD
    """
    from datetime import datetime
    
    try:
        target = datetime.strptime(target_date, "%Y-%m-%d").date()
    except ValueError:
        raise HTTPException(status_code=400, detail="日期格式错误，应为 YYYY-MM-DD")
    
    # 权限检查：员工只能分析自己的数据
    user_id = current_user.id if current_user.role == "employee" else None
    
    api_analysis_service = ApiAnalysisService(db)
    result = api_analysis_service.generate_daily_analysis(target, user_id)
    
    if not result.get("success"):
        raise HTTPException(status_code=500, detail=result.get("message", "生成分析失败"))
    
    return result


@router.post("/l7d")
async def generate_l7d_analysis_from_api(
    end_date: Optional[str] = Query(None, description="结束日期 YYYY-MM-DD（默认为昨天）"),
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db)
):
    """
    从API数据生成L7D分析
    
    Args:
        end_date: 结束日期 YYYY-MM-DD（默认为昨天）
    """
    from datetime import datetime, date, timedelta
    
    if end_date:
        try:
            end = datetime.strptime(end_date, "%Y-%m-%d").date()
        except ValueError:
            raise HTTPException(status_code=400, detail="日期格式错误，应为 YYYY-MM-DD")
    else:
        end = date.today() - timedelta(days=1)  # 默认昨天
    
    # 权限检查：员工只能分析自己的数据
    user_id = current_user.id if current_user.role == "employee" else None
    
    api_analysis_service = ApiAnalysisService(db)
    result = api_analysis_service.generate_l7d_analysis(end, user_id)
    
    if not result.get("success"):
        raise HTTPException(status_code=500, detail=result.get("message", "生成分析失败"))
    
    return result




