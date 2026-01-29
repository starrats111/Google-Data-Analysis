"""
数据分析服务
实现表1（谷歌广告）+ 表2（联盟数据）-> 表3（分析结果）的数据分析逻辑

核心计算公式：
1. 保守EPC = 保守佣金 / 点击
2. 保守ROI = (保守EPC - CPC) / CPC × 100%
"""
try:
    import pandas as pd
    import numpy as np
    PANDAS_AVAILABLE = True
except ImportError:
    PANDAS_AVAILABLE = False
    pd = None
    np = None

from typing import Dict, Optional
from pathlib import Path
from datetime import datetime, timedelta
from app.services.analysis_template_service import AnalysisTemplateService
from app.services.stage_label_service import StageLabelService
from app.services.anomaly_service import AnomalyService
from app.config import settings
import re


class AnalysisService:
    """数据分析服务类"""
    
    def __init__(self, upload_folder: str = "uploads"):
        self.upload_folder = upload_folder
    
    def process_analysis(
        self, 
        google_ads_file: str, 
        affiliate_file: str, 
        user_id: int,
        match_keys: Optional[list] = None,
        platform_id: Optional[int] = None,
        analysis_date: Optional[str] = None,
        db: Optional[object] = None,
        # 操作指令相关参数（员工手动输入）
        past_seven_days_orders_global: Optional[float] = None,
        max_cpc_global: Optional[float] = None
    ) -> Dict:
        """
        处理数据分析：表1 + 表2 -> 表3
        
        参数:
            google_ads_file: 表1文件路径（谷歌广告数据）
            affiliate_file: 表2文件路径（联盟数据）
            user_id: 用户ID
            match_keys: 数据匹配的键列表，如['日期', '广告ID']，如果为None则自动检测
        
        返回:
            包含分析结果的字典
        """
        if not PANDAS_AVAILABLE:
            return {
                "status": "failed",
                "error": "pandas 未安装，数据分析功能暂时不可用。请先安装 pandas 和 numpy。",
                "data": [],
                "summary": {}
            }
        
        try:
            # 1. 读取表1（谷歌广告数据）
            df_google = self._read_file(google_ads_file)
            if df_google.empty:
                raise ValueError("表1（谷歌广告数据）为空，请检查文件内容")
            
            # 2. 读取表2（联盟数据）
            df_affiliate = self._read_file(affiliate_file)
            if df_affiliate.empty:
                raise ValueError("表2（联盟数据）为空，请检查文件内容")
            
            # 3. 数据清洗
            df_google_clean = self._clean_google_data(df_google)
            df_affiliate_clean = self._clean_affiliate_data(df_affiliate)
            
            # 4. 数据匹配和分析
            result_df = self._merge_and_analyze(
                df_google_clean, 
                df_affiliate_clean,
                match_keys=match_keys
            )
            
            # 5. 应用分析表模板规则和公式
            result_df_with_actions = self._apply_template_rules(result_df)
            
            # 6. 检测异常类型（需要对比前一天数据）
            if platform_id and analysis_date and db:
                result_df_with_actions = self._detect_anomaly_types(
                    result_df_with_actions,
                    platform_id,
                    analysis_date,
                    db
                )
            
            # 7. 生成操作指令（使用员工手动输入的值）
            result_df_with_actions['操作指令'] = result_df_with_actions.apply(
                lambda row: self._generate_operation_instruction(
                    row,
                    past_seven_days_orders_global=past_seven_days_orders_global,
                    max_cpc_global=max_cpc_global
                ),
                axis=1
            )
            
            # 8. 生成分析结果
            # 如果结果为0行，添加诊断信息
            if len(result_df_with_actions) == 0:
                import logging
                logger = logging.getLogger(__name__)
                logger.warning("分析结果为0行，可能的原因：商家ID不匹配或数据为空")
                
                # 收集诊断信息
                diagnosis = {
                    "google_rows": len(df_google_clean),
                    "affiliate_rows": len(df_affiliate_clean),
                    "google_has_merchant_id": '商家ID' in df_google_clean.columns,
                    "affiliate_has_merchant_id": '商家ID' in df_affiliate_clean.columns,
                }
                
                if '商家ID' in df_google_clean.columns:
                    google_valid_ids = df_google_clean['商家ID'].notna().sum()
                    google_unique_ids = df_google_clean['商家ID'].dropna().nunique()
                    diagnosis["google_valid_merchant_ids"] = google_valid_ids
                    diagnosis["google_unique_merchant_ids"] = google_unique_ids
                    if google_unique_ids > 0:
                        try:
                            diagnosis["google_sample_ids"] = df_google_clean['商家ID'].dropna().head(5).astype(str).tolist()
                        except:
                            diagnosis["google_sample_ids"] = []
                
                if '商家ID' in df_affiliate_clean.columns:
                    affiliate_valid_ids = df_affiliate_clean['商家ID'].notna().sum()
                    affiliate_unique_ids = df_affiliate_clean['商家ID'].dropna().nunique()
                    diagnosis["affiliate_valid_merchant_ids"] = affiliate_valid_ids
                    diagnosis["affiliate_unique_merchant_ids"] = affiliate_unique_ids
                    if affiliate_unique_ids > 0:
                        try:
                            diagnosis["affiliate_sample_ids"] = df_affiliate_clean['商家ID'].dropna().head(5).astype(str).tolist()
                        except:
                            diagnosis["affiliate_sample_ids"] = []
                
                logger.warning(f"诊断信息: {diagnosis}")
                
                # 返回诊断信息
                return {
                    "status": "completed",
                    "data": [],
                    "summary": {},
                    "total_rows": 0,
                    "diagnosis": diagnosis,
                    "warning": "分析结果为0行，请检查商家ID是否匹配。诊断信息已记录到日志。"
                }
            
            # 记录生成的字段列表（用于调试）
            import logging
            logger = logging.getLogger(__name__)
            columns_list = list(result_df_with_actions.columns)
            logger.info(f"分析结果包含的字段: {columns_list}")
            
            # ====== 输出通用模板：仅保留指定列，并搬运字段 ======
            # 注意：操作指令计算依赖预算错失份额/排名错失份额等字段，所以先算完指令再做裁剪。
            output_df = result_df_with_actions.copy()
            
            # 1) 搬运：预算错失份额/排名错失份额 -> IS Budget丢失/IS Rank丢失
            if 'IS Budget丢失' not in output_df.columns:
                output_df['IS Budget丢失'] = None
            if 'IS Rank丢失' not in output_df.columns:
                output_df['IS Rank丢失'] = None
            if '预算错失份额' in output_df.columns:
                output_df['IS Budget丢失'] = output_df['预算错失份额']
            if '排名错失份额' in output_df.columns:
                output_df['IS Rank丢失'] = output_df['排名错失份额']
            
            # 2) 补齐：广告系列名/MID（兼容历史字段）
            if '广告系列名' not in output_df.columns and '广告系列' in output_df.columns:
                output_df['广告系列名'] = output_df['广告系列']
            if 'MID' not in output_df.columns and '商家ID' in output_df.columns:
                output_df['MID'] = output_df['商家ID']
            
            # 3) 仅保留通用模板列（按截图顺序）
            output_columns = [
                '广告系列名',
                '预算',
                'L7D点击',
                'L7D佣金',
                'L7D花费',
                'L7D出单天数',
                '当前Max CPC',
                'IS Budget丢失',
                'IS Rank丢失',
                '保守EPC',
                '保守ROI',
                '操作指令',
                'MID',
            ]
            for col in output_columns:
                if col not in output_df.columns:
                    output_df[col] = None
            
            # 4) 仅返回这些列（删除其他无用列）
            output_df = output_df[output_columns]
            
            # 5) 日志：检查缺失列（理论上不应缺失）
            missing_fields = [c for c in output_columns if c not in columns_list and c not in ['广告系列名', 'MID', 'IS Budget丢失', 'IS Rank丢失']]
            if missing_fields:
                logger.warning(f"通用模板输出列缺失（已自动补None）: {missing_fields}")
            
            analysis_result = {
                "data": output_df.to_dict('records'),
                # summary 保持使用完整数据（不影响页面表格列裁剪）
                "summary": self._calculate_summary(result_df_with_actions),
                "status": "completed",
                "total_rows": len(output_df)
            }
            
            return analysis_result
            
        except Exception as e:
            return {
                "status": "failed", 
                "error": str(e),
                "data": [],
                "summary": {}
            }
    
    def _read_file(self, file_path: str) -> pd.DataFrame:
        """
        读取Excel或CSV文件
        
        参数:
            file_path: 文件路径
        
        返回:
            DataFrame对象
        """
        file_path_obj = Path(file_path)
        
        if not file_path_obj.exists():
            raise FileNotFoundError(f"文件不存在: {file_path}")
        
        try:
            if file_path.endswith('.csv'):
                # 使用类似Excel的标题行检测方法
                df = self._read_csv_with_header_detection(file_path)
                return df
            else:
                # Excel文件 - 尝试自动检测标题行
                df = self._read_excel_with_header_detection(file_path)
                return df
        except Exception as e:
            raise Exception(f"读取文件失败: {str(e)}")
    
    def _read_csv_with_header_detection(self, file_path: str) -> pd.DataFrame:
        """
        读取CSV文件并自动检测标题行位置
        类似Excel文件的标题行检测，尝试跳过前几行找到真正的列名
        """
        encodings = ['utf-8-sig', 'utf-8', 'gbk', 'gb2312']
        separators = [',', ';', '\t', '|']
        
        # 先尝试不同的编码和分隔符，找到能读取的配置
        best_df = None
        best_encoding = None
        best_sep = None
        
        for encoding in encodings:
            for sep in separators:
                try:
                    # 先读取前10行来检测
                    df_test = pd.read_csv(
                        file_path,
                        encoding=encoding,
                        sep=sep,
                        nrows=10,
                        engine='python',
                        on_bad_lines='skip' if hasattr(pd, 'errors') else None,
                        error_bad_lines=False if not hasattr(pd, 'errors') else None,
                        warn_bad_lines=False if not hasattr(pd, 'errors') else None,
                        skipinitialspace=True
                    )
                    if len(df_test.columns) > 1:
                        best_df = df_test
                        best_encoding = encoding
                        best_sep = sep
                        break
                except (UnicodeDecodeError, pd.errors.ParserError, TypeError):
                    try:
                        df_test = pd.read_csv(
                            file_path,
                            encoding=encoding,
                            sep=sep,
                            nrows=10,
                            engine='python',
                            error_bad_lines=False,
                            warn_bad_lines=False,
                            skipinitialspace=True
                        )
                        if len(df_test.columns) > 1:
                            best_df = df_test
                            best_encoding = encoding
                            best_sep = sep
                            break
                    except Exception:
                        continue
                except Exception:
                    continue
            if best_df is not None:
                break
        
        # 如果所有编码和分隔符都失败，尝试自动检测
        if best_df is None:
            for encoding in encodings:
                try:
                    df_test = pd.read_csv(
                        file_path,
                        encoding=encoding,
                        sep=None,
                        nrows=10,
                        engine='python',
                        on_bad_lines='skip' if hasattr(pd, 'errors') else None,
                        error_bad_lines=False if not hasattr(pd, 'errors') else None,
                        warn_bad_lines=False if not hasattr(pd, 'errors') else None
                    )
                    if len(df_test.columns) > 1:
                        best_df = df_test
                        best_encoding = encoding
                        best_sep = None
                        break
                except Exception:
                    continue
        
        # 如果还是失败，使用latin1作为最后尝试
        if best_df is None:
            try:
                best_df = pd.read_csv(file_path, encoding='latin1', sep=None, nrows=10, engine='python', error_bad_lines=False, warn_bad_lines=False)
                best_encoding = 'latin1'
                best_sep = None
            except Exception as e:
                # 尝试最基本的读取方式
                try:
                    best_df = pd.read_csv(file_path, encoding='latin1', sep=',', nrows=10, engine='python', error_bad_lines=False, warn_bad_lines=False)
                    best_encoding = 'latin1'
                    best_sep = ','
                except Exception as e2:
                    raise Exception(f"无法读取CSV文件，请检查文件格式。错误详情: {str(e2)}")
        
        # 检测最佳标题行位置（从第0行到第5行）
        best_header = 0
        best_score = 0
        
        read_params = {
            'encoding': best_encoding,
            'sep': best_sep,
            'engine': 'python',
            'skipinitialspace': True
        }
        if hasattr(pd, 'errors'):
            read_params['on_bad_lines'] = 'skip'
        else:
            read_params['error_bad_lines'] = False
            read_params['warn_bad_lines'] = False
        
        for header_row in range(6):  # 尝试前6行
            try:
                df_test = pd.read_csv(file_path, header=header_row, nrows=20, **read_params)
                # 计算有效列名数量（包含中文字符或常见关键词）
                valid_cols = 0
                for col in df_test.columns:
                    col_str = str(col).strip()
                    if any('\u4e00' <= c <= '\u9fff' for c in col_str) or \
                       any(keyword in col_str.lower() for keyword in [
                           'click', 'cost', 'campaign', 'date', 'order', 'commission',
                           'merchant', 'id', 'cpc', 'epc', 'roi', 'impression',
                           '点击', '费用', '广告', '日期', '订单', '佣金', '商家'
                       ]) or \
                       (not col_str.startswith('Unnamed') and not col_str.startswith('列') and len(col_str) > 0):
                        valid_cols += 1
                
                if valid_cols > best_score:
                    best_score = valid_cols
                    best_header = header_row
            except Exception:
                continue
        
        # 使用最佳标题行读取完整数据
        try:
            df = pd.read_csv(file_path, header=best_header, **read_params)
        except Exception as e:
            # 如果失败，尝试不使用header参数
            try:
                df = pd.read_csv(file_path, **read_params)
                df = self._clean_csv_column_names(df)
            except Exception as e2:
                # 最后的兜底：尝试最基本的读取方式
                try:
                    df = pd.read_csv(file_path, encoding=best_encoding, sep=best_sep if best_sep else ',', engine='python', error_bad_lines=False, warn_bad_lines=False)
                    df = self._clean_csv_column_names(df)
                except Exception as e3:
                    raise Exception(f"无法读取CSV文件，请检查文件格式。错误详情: {str(e3)}")
        
        # 清理列名
        df = self._clean_csv_column_names(df)
        df = df.dropna(how='all').dropna(axis=1, how='all')
        return df
    
    def _clean_csv_column_names(self, df: pd.DataFrame) -> pd.DataFrame:
        """
        清理和修复CSV文件的列名
        处理BOM、乱码、以及将第一行数据作为列名的情况
        """
        if df.empty:
            return df
        
        # 检查列名是否包含乱码字符（BOM、控制字符等）
        has_garbled_names = False
        garbled_count = 0
        for col in df.columns:
            col_str = str(col)
            # 检查是否包含BOM字符或明显的乱码
            is_garbled = (
                any(ord(c) < 32 and c not in ['\t', '\n', '\r'] for c in col_str) or
                '\ufeff' in col_str or '\x00' in col_str or
                col_str.startswith('ÿ') or col_str.startswith('û') or
                col_str.startswith('^J') or 'R¥bJ' in col_str or
                (len(col_str) > 0 and ord(col_str[0]) > 127 and not any('\u4e00' <= c <= '\u9fff' for c in col_str))
            )
            if is_garbled:
                garbled_count += 1
        
        # 如果超过一半的列名是乱码，认为列名有问题
        has_garbled_names = garbled_count > len(df.columns) * 0.3
        
        # 如果列名是乱码，尝试使用第一行数据作为列名
        if has_garbled_names and len(df) > 0:
            first_row = df.iloc[0]
            potential_headers = []
            valid_header_count = 0
            
            for val in first_row:
                val_str = str(val) if pd.notna(val) else ''
                val_str = val_str.strip()
                
                # 检查是否看起来像列名
                is_valid_header = False
                if val_str:
                    # 包含中文字符
                    if any('\u4e00' <= c <= '\u9fff' for c in val_str):
                        is_valid_header = True
                    # 包含常见字段关键词
                    elif any(keyword in val_str.lower() for keyword in [
                        'click', 'cost', 'campaign', 'date', 'order', 'commission', 
                        'merchant', 'id', 'cpc', 'epc', 'roi', 'impression', 'conversion',
                        '点击', '费用', '广告', '日期', '订单', '佣金', '商家'
                    ]):
                        is_valid_header = True
                    # 长度合理（2-50个字符）
                    elif 2 <= len(val_str) <= 50:
                        is_valid_header = True
                
                if is_valid_header:
                    potential_headers.append(val_str)
                    valid_header_count += 1
                else:
                    potential_headers.append(f'列{len(potential_headers)+1}')
            
            # 如果找到至少2个有效的列名，使用第一行作为列名
            if valid_header_count >= 2:
                df.columns = potential_headers
                df = df.drop(df.index[0]).reset_index(drop=True)
                return df
        
        # 清理现有列名：移除BOM、控制字符等
        new_columns = []
        for col in df.columns:
            col_str = str(col).strip()
            # 移除BOM
            if col_str.startswith('\ufeff'):
                col_str = col_str[1:]
            # 移除其他控制字符（保留制表符、换行符等）
            col_str = ''.join(c for c in col_str if ord(c) >= 32 or c in ['\t', '\n', '\r'])
            # 如果清理后为空或是Unnamed，使用默认名称
            if not col_str or col_str.startswith('Unnamed') or col_str.startswith('ÿ') or col_str.startswith('û'):
                new_columns.append(f'列{len(new_columns)+1}')
            else:
                new_columns.append(col_str)
        
        df.columns = new_columns
        return df
    
    def _read_excel_with_header_detection(self, file_path: str) -> pd.DataFrame:
        """
        读取Excel文件并自动检测标题行
        
        尝试跳过可能的标题行，找到真正的列名行
        """
        # 先读取前几行来检测标题行位置
        df_preview = pd.read_excel(file_path, engine='openpyxl', nrows=5)
        
        # 检测最佳标题行位置（从第0行到第3行）
        best_header = 0
        best_score = 0
        
        for header_row in range(min(4, len(df_preview))):
            df_test = pd.read_excel(file_path, engine='openpyxl', header=header_row, nrows=10)
            # 计算有效列名数量（非Unnamed且非空）
            valid_cols = sum(1 for col in df_test.columns 
                           if not str(col).startswith('Unnamed') 
                           and str(col).strip() 
                           and not pd.isna(col))
            # 如果这一行有更多有效列名，选择它
            if valid_cols > best_score:
                best_score = valid_cols
                best_header = header_row
        
        # 使用最佳标题行读取完整数据
        df = pd.read_excel(file_path, engine='openpyxl', header=best_header)
        
        # 清理数据：去除完全空白的行和列
        df = df.dropna(how='all').dropna(axis=1, how='all')
        
        # 处理Unnamed列：尝试用第一行的值填充
        new_columns = []
        use_first_row_as_header = False
        
        for i, col in enumerate(df.columns):
            if str(col).startswith('Unnamed'):
                # 检查第一行是否有值
                if len(df) > 0:
                    first_value = df.iloc[0, i]
                    if pd.notna(first_value) and str(first_value).strip():
                        new_columns.append(str(first_value).strip())
                        use_first_row_as_header = True
                    else:
                        new_columns.append(f'列{i+1}')
                else:
                    new_columns.append(f'列{i+1}')
            else:
                new_columns.append(str(col).strip())
        
        # 如果使用了第一行作为列名，删除第一行数据
        if use_first_row_as_header:
            df.columns = new_columns
            df = df.drop(df.index[0]).reset_index(drop=True)
        else:
            df.columns = new_columns
        
        return df
    
    def _clean_google_data(self, df: pd.DataFrame) -> pd.DataFrame:
        """
        清洗谷歌广告数据（表1）
        
        需要包含的字段：
        - 日期
        - 广告ID（或其他标识符）
        - 点击（Clicks）⭐ 从表1提取
        - CPC（每次点击成本）
        
        根据实际表1结构进行调整
        """
        df_clean = df.copy()

        # 去除完全空白的行/列
        df_clean = df_clean.dropna(how='all').dropna(axis=1, how='all')

        # 统一关键字段列名（优先匹配中文原始列名，其次英文）
        campaign_col = self._find_column(df_clean, ['广告系列', 'Campaign', 'campaign', 'Campaign name', '广告系列名称'])
        clicks_col = self._find_column(df_clean, ['点击次数', '点击', 'Clicks', 'clicks', '点击数', 'Click Count', 'click count'])
        cost_col = self._find_column(df_clean, ['费用', 'Cost', 'cost', '花费', '总费用', '费用 ($)', 'Cost ($)'])
        cpc_col = self._find_column(df_clean, ['平均每次点击费用', 'CPC', 'cpc', '每次点击成本', '点击成本', 'Avg CPC', 'Cost Per Click'])
        max_cpc_col = self._find_column(df_clean, ['最高CPC', '最高每次点击费用', 'Max CPC', 'max cpc', '最高点击成本'])
        currency_col = self._find_column(df_clean, ['货币代码', '货币', 'Currency code', 'Currency Code', 'Currency', 'currency'])
        budget_col = self._find_column(df_clean, [
            '预算', '每日预算', '日预算', '平均每日预算',
            'Daily budget', 'Budget', 'daily budget'
        ])
        
        # 过去七天出单天数（从表1读取）
        past_seven_days_orders_col = self._find_column(df_clean, [
            '过去七天出单天数', '过去7天出单天数', '过去七天出单数',
            'Past 7 days orders', 'Past seven days orders', '7 days orders',
            '过去七天订单数', '7天出单天数', '七天出单天数'
        ])

        budget_lost_col = self._find_column(df_clean, [
            '在搜索网络中因预算而错失的展示次数份额',
            'Search lost IS (budget)', 'Search Lost IS (budget)',
            'Search lost impression share (budget)',
        ])
        rank_lost_col = self._find_column(df_clean, [
            '在搜索网络中因评级而错失的展示次数份额',
            'Search lost IS (rank)', 'Search Lost IS (rank)',
            'Search lost impression share (rank)',
            'Search lost IS (ad rank)',
        ])

        # 谷歌状态（原"表1状态"）
        status_col = self._find_column(df_clean, [
            '状态', 'Status',
            '广告系列状态', 'Campaign status', 'Campaign Status',
            '广告组状态', 'Ad group status', 'Ad Group Status',
            '关键词状态', 'Keyword status', 'Keyword Status'
        ])

        rename_map = {}
        if campaign_col and campaign_col != '广告系列':
            rename_map[campaign_col] = '广告系列'
        if clicks_col and clicks_col != '点击':
            rename_map[clicks_col] = '点击'
        if cost_col and cost_col != '费用':
            rename_map[cost_col] = '费用'
        if cpc_col and cpc_col != 'CPC':
            rename_map[cpc_col] = 'CPC'
        if max_cpc_col and max_cpc_col != '最高CPC':
            rename_map[max_cpc_col] = '最高CPC'
        if currency_col and currency_col != '货币代码':
            rename_map[currency_col] = '货币代码'
        if budget_col and budget_col != '预算':
            rename_map[budget_col] = '预算'
        if past_seven_days_orders_col and past_seven_days_orders_col != '过去七天出单天数':
            rename_map[past_seven_days_orders_col] = '过去七天出单天数'
        if budget_lost_col and budget_lost_col != '预算错失份额':
            rename_map[budget_lost_col] = '预算错失份额'
        if rank_lost_col and rank_lost_col != '排名错失份额':
            rename_map[rank_lost_col] = '排名错失份额'
        if status_col and status_col != '谷歌状态':
            rename_map[status_col] = '谷歌状态'
        if rename_map:
            df_clean = df_clean.rename(columns=rename_map)

        # 数值列转换（兼容逗号小数/千分位/货币符号）
        if '点击' in df_clean.columns:
            df_clean['点击'] = df_clean['点击'].apply(self._to_number)
        if '费用' in df_clean.columns:
            df_clean['费用'] = df_clean['费用'].apply(self._to_number)
        if 'CPC' in df_clean.columns:
            df_clean['CPC'] = df_clean['CPC'].apply(self._to_number)
        if '最高CPC' in df_clean.columns:
            df_clean['最高CPC'] = df_clean['最高CPC'].apply(self._to_number)
        if '过去七天出单天数' in df_clean.columns:
            df_clean['过去七天出单天数'] = df_clean['过去七天出单天数'].apply(self._to_number)
        if '预算' in df_clean.columns:
            df_clean['预算'] = df_clean['预算'].apply(self._to_number)

        # 货币换算：若表1为人民币(CNY/RMB)，将费用/CPC/最高CPC换算为美元再进入计算
        if '货币代码' in df_clean.columns:
            try:
                rate = float(getattr(settings, "CNY_TO_USD_RATE", 7.2) or 7.2)
            except Exception:
                rate = 7.2

            # 统一货币代码
            cur = df_clean['货币代码'].fillna('').astype(str).str.strip().str.upper()
            is_cny = cur.isin(['CNY', 'RMB', 'CN¥', 'CNY (CHINA)'])

            if is_cny.any() and rate > 0:
                # CNY -> USD = value / rate
                for col in ['费用', 'CPC', '最高CPC']:
                    if col in df_clean.columns:
                        df_clean.loc[is_cny, col] = df_clean.loc[is_cny, col] / rate
   
                import logging
                logging.getLogger(__name__).info(
                    f"检测到表1人民币货币代码，已按汇率 1USD={rate}CNY 将费用/CPC换算为USD"
                )

        # 错失份额通常是百分比（可能是 0.4326、43.26% 或字符串）
        if '预算错失份额' in df_clean.columns:
            df_clean['预算错失份额'] = df_clean['预算错失份额'].apply(self._format_percent_value)
        if '排名错失份额' in df_clean.columns:
            df_clean['排名错失份额'] = df_clean['排名错失份额'].apply(self._format_percent_value)

        # 从广告系列解析商家ID：序号-平台-商家名-投放国家-投放时间-商家ID（取最后一段）
        if '广告系列' in df_clean.columns:
            df_clean['商家ID'] = df_clean['广告系列'].apply(self._extract_merchant_id_from_campaign)
            # 确保商家ID是字符串格式
            if '商家ID' in df_clean.columns:
                df_clean['商家ID'] = df_clean['商家ID'].astype(str).str.strip()
                df_clean['商家ID'] = df_clean['商家ID'].replace(['None', 'nan', 'NaN', 'null', 'NULL', ''], pd.NA)

        return df_clean
    
    def _clean_affiliate_data(self, df: pd.DataFrame) -> pd.DataFrame:
        """
        清洗联盟数据（表2）
        
        需要包含的字段：
        - 日期
        - 广告ID（或其他标识符）
        - 订单数 ⭐ 从表2提取
        - 保守佣金
        
        根据实际表2结构进行调整
        """
        df_clean = df.copy()

        # 去除完全空白的行/列
        df_clean = df_clean.dropna(how='all').dropna(axis=1, how='all')

        merchant_id_col = self._find_column(
            df_clean,
            ['Merchant ID', 'merchant id', 'MerchantID', '商家ID', '商户ID', 'Merchant Id', 'MID', 'mid', 'Mid']
        )
        orders_col = self._find_column(df_clean, ['Orders', 'orders', '订单', '订单数', 'Order Count', 'order count'])
        comm_col = self._find_column(df_clean, ['Comm', 'comm', 'Commission', 'commission', '回传佣金', '佣金', 'Approved Comm', 'Gross Comm'])

        rename_map = {}
        if merchant_id_col and merchant_id_col != '商家ID':
            rename_map[merchant_id_col] = '商家ID'
        if orders_col and orders_col != '订单':
            rename_map[orders_col] = '订单'
        if comm_col and comm_col != '回传佣金':
            rename_map[comm_col] = '回传佣金'
        if rename_map:
            df_clean = df_clean.rename(columns=rename_map)

        if '商家ID' in df_clean.columns:
            # 统一商家ID格式：转换为字符串，去除空格，处理空值
            # 先转换为字符串
            df_clean['商家ID'] = df_clean['商家ID'].fillna('').astype(str)
            # 去除空格
            df_clean['商家ID'] = df_clean['商家ID'].str.strip()
            # 去除浮点数格式的.0后缀（如 '116022.0' -> '116022'）
            df_clean['商家ID'] = df_clean['商家ID'].str.replace(r'\.0$', '', regex=True)
            # 将 'None', 'nan', 'NaN', '' 等转换为真正的空值
            df_clean['商家ID'] = df_clean['商家ID'].replace(['None', 'nan', 'NaN', 'null', 'NULL', ''], pd.NA)

        if '订单' in df_clean.columns:
            df_clean['订单'] = df_clean['订单'].apply(self._to_number)
        if '回传佣金' in df_clean.columns:
            df_clean['回传佣金'] = df_clean['回传佣金'].apply(self._to_number)

        return df_clean

    def _extract_merchant_id_from_campaign(self, campaign: object) -> Optional[str]:
        """
        从广告系列中解析商家ID
        格式：序号-平台-商家名-投放国家-投放时间-商家ID（取最后一段）
        """
        if campaign is None or (pd is not None and pd.isna(campaign)):
            return None
        s = str(campaign).strip()
        if not s:
            return None
        # 如果整个字符串就是数字，直接返回
        if re.match(r'^\d+$', s):
            return s
        
        # 取最后一个 '-' 分隔段
        last = s.split('-')[-1].strip()
        # 商家ID通常是数字
        m = re.search(r'(\d+)$', last)
        if m:
            return m.group(1)
        
        # 如果最后一段不是纯数字，尝试提取其中的数字
        # 例如："商家ID123" -> "123"
        m = re.search(r'(\d+)', last)
        return m.group(1) if m else None

    def _format_percent_value(self, value: object) -> Optional[str]:
        """
        将错失份额统一格式化为百分比字符串（保留2位小数）
        输入可能为 0.4326 / 43.26 / '43.26%' / None
        """
        if value is None or (pd is not None and pd.isna(value)):
            return None
        s = str(value).strip()
        if not s:
            return None
        try:
            if s.endswith('%'):
                num = float(s.replace('%', '').strip())
                return f"{num:.2f}%"
            num = float(s)
            # 0-1 视为比例
            if 0 <= num <= 1:
                num = num * 100
            return f"{num:.2f}%"
        except Exception:
            return s

    def _to_number(self, value: object) -> float:
        """
        更稳健的数值解析：
        - 兼容 '16,41'（逗号小数）、'1,234.56'（千分位）、'$123.45'、'123.45%' 等
        - 解析失败返回 0
        """
        if value is None or (pd is not None and pd.isna(value)):
            return 0.0
        if isinstance(value, (int, float)):
            try:
                return float(value)
            except Exception:
                return 0.0
        s = str(value).strip()
        if not s:
            return 0.0
        # 去掉常见货币符号/空格
        s = s.replace('$', '').replace('￥', '').replace('¥', '').replace('€', '').replace('£', '').strip()
        # 去掉百分号（按数值处理）
        s = s.replace('%', '').strip()
        # 处理千分位/逗号小数
        if ',' in s and '.' in s:
            s = s.replace(',', '')
        elif ',' in s and '.' not in s:
            s = s.replace(',', '.')
        # 去掉其他非数字字符（保留负号和小数点）
        s = re.sub(r'[^0-9\.\-]', '', s)
        try:
            return float(s)
        except Exception:
            return 0.0
    
    def _merge_and_analyze(
        self, 
        df_google: pd.DataFrame, 
        df_affiliate: pd.DataFrame,
        match_keys: Optional[list] = None
    ) -> pd.DataFrame:
        """
        合并数据并进行分析
        
        数据来源：
        - 点击：从表1（谷歌广告数据）提取 ⭐
        - 订单数：从表2（联盟数据）提取 ⭐
        - CPC：来自表1
        - 保守佣金：来自表2
        
        核心计算公式：
        1. 保守EPC = 保守佣金 / 点击（点击来自表1，保守佣金来自表2）
        2. 保守ROI = (保守EPC - CPC) / CPC × 100%
        
        参数:
            df_google: 表1数据（谷歌广告）
            df_affiliate: 表2数据（联盟）
            match_keys: 匹配键列表，如果为None则自动检测
        
        返回:
            分析结果DataFrame（包含：点击、订单数、保守佣金、保守EPC、保守ROI等）
        """
        # 1) 优先使用"商家ID"匹配（你要求的逻辑）
        if match_keys is None:
            if '商家ID' in df_google.columns and '商家ID' in df_affiliate.columns:
                match_keys = ['商家ID']
            else:
                match_keys = self._detect_match_keys(df_google, df_affiliate)
        
        # 确保匹配键不为空
        if not match_keys or len(match_keys) == 0:
            # 如果没有找到匹配键，尝试按行号匹配（假设两个表的数据行数相同或相近）
            # 这适用于按日期顺序排列的数据，即使没有日期列
            if len(df_google) > 0 and len(df_affiliate) > 0:
                # 创建临时索引列用于匹配
                df_google = df_google.copy()
                df_affiliate = df_affiliate.copy()
                df_google['_temp_index'] = range(len(df_google))
                df_affiliate['_temp_index'] = range(len(df_affiliate))
                match_keys = ['_temp_index']
            else:
                raise ValueError("无法找到匹配键，且数据为空")
        
        # 在合并前，确保商家ID的数据类型一致并清理空值
        if '商家ID' in match_keys:
            # 统一商家ID的数据类型为字符串，并清理空值
            def normalize_merchant_id(series):
                """标准化商家ID：转换为字符串，去除.0后缀，统一格式"""
                # 先转换为字符串
                result = series.fillna('').astype(str)
                # 去除空格
                result = result.str.strip()
                # 去除浮点数格式的.0后缀（如 '116022.0' -> '116022'）
                result = result.str.replace(r'\.0$', '', regex=True)
                # 处理空值表示
                result = result.replace(['None', 'nan', 'NaN', 'null', 'NULL', '<NA>', 'NaT', ''], pd.NA)
                return result
            
            if '商家ID' in df_google.columns:
                df_google = df_google.copy()
                df_google['商家ID'] = normalize_merchant_id(df_google['商家ID'])
            if '商家ID' in df_affiliate.columns:
                df_affiliate = df_affiliate.copy()
                df_affiliate['商家ID'] = normalize_merchant_id(df_affiliate['商家ID'])
            
            # 添加调试信息
            import logging
            logger = logging.getLogger(__name__)
            google_valid_count = df_google['商家ID'].notna().sum() if '商家ID' in df_google.columns else 0
            affiliate_valid_count = df_affiliate['商家ID'].notna().sum() if '商家ID' in df_affiliate.columns else 0
            logger.info(f"商家ID匹配统计: 表1有效商家ID数量={google_valid_count}/{len(df_google)}, 表2有效商家ID数量={affiliate_valid_count}/{len(df_affiliate)}")
            
            # 显示一些商家ID样本用于调试
            if google_valid_count > 0:
                sample_ids_google = df_google[df_google['商家ID'].notna()]['商家ID'].head(5).tolist()
                logger.info(f"表1商家ID样本: {sample_ids_google}")
            if affiliate_valid_count > 0:
                sample_ids_affiliate = df_affiliate[df_affiliate['商家ID'].notna()]['商家ID'].head(5).tolist()
                logger.info(f"表2商家ID样本: {sample_ids_affiliate}")
        
        # 2) 执行合并
        # 使用 inner join 只保留能匹配上的数据，避免数据混乱
        # 如果商家ID为空，则不参与匹配
        if '商家ID' in match_keys:
            # 只匹配商家ID不为空的数据
            df_google_valid = df_google[df_google['商家ID'].notna()].copy() if '商家ID' in df_google.columns else df_google.copy()
            df_affiliate_valid = df_affiliate[df_affiliate['商家ID'].notna()].copy() if '商家ID' in df_affiliate.columns else df_affiliate.copy()
            
            # 添加调试信息
            import logging
            logger = logging.getLogger(__name__)
            logger.info(f"准备合并: 表1有效行数={len(df_google_valid)}, 表2有效行数={len(df_affiliate_valid)}")
            
            # 确保商家ID在合并前格式完全一致（转换为字符串并去除.0）
            if '商家ID' in df_google_valid.columns:
                df_google_valid = df_google_valid.copy()
                df_google_valid['商家ID'] = df_google_valid['商家ID'].astype(str).str.replace(r'\.0$', '', regex=True).str.strip()
            if '商家ID' in df_affiliate_valid.columns:
                df_affiliate_valid = df_affiliate_valid.copy()
                df_affiliate_valid['商家ID'] = df_affiliate_valid['商家ID'].astype(str).str.replace(r'\.0$', '', regex=True).str.strip()
            
            # 使用 inner join 确保数据匹配
            merged = pd.merge(
                df_google_valid,
                df_affiliate_valid,
                on=match_keys,
                how='inner',
                suffixes=('', '_affiliate')
            )
            
            # 记录合并结果
            logger.info(f"合并完成: 匹配成功 {len(merged)} 行数据")
            if len(merged) == 0:
                # 如果合并失败，尝试显示一些不匹配的商家ID用于调试
                google_ids = set(df_google_valid['商家ID'].dropna().astype(str).str.replace(r'\.0$', '', regex=True).str.strip().unique()) if '商家ID' in df_google_valid.columns else set()
                affiliate_ids = set(df_affiliate_valid['商家ID'].dropna().astype(str).str.replace(r'\.0$', '', regex=True).str.strip().unique()) if '商家ID' in df_affiliate_valid.columns else set()
                common_ids = google_ids & affiliate_ids
                logger.warning(f"商家ID匹配失败: 表1唯一商家ID数量={len(google_ids)}, 表2唯一商家ID数量={len(affiliate_ids)}, 共同商家ID数量={len(common_ids)}")
                if len(google_ids) > 0 and len(affiliate_ids) > 0:
                    logger.warning(f"表1商家ID示例: {list(google_ids)[:10]}")
                    logger.warning(f"表2商家ID示例: {list(affiliate_ids)[:10]}")
                    if len(common_ids) > 0:
                        logger.warning(f"共同商家ID: {list(common_ids)[:10]}")
                    else:
                        logger.warning("没有找到共同的商家ID，可能是格式不一致")
            else:
                # 如果合并成功，记录匹配的商家ID
                if '商家ID' in merged.columns:
                    matched_ids = merged['商家ID'].dropna().unique()
                    logger.info(f"成功匹配的商家ID: {list(matched_ids)[:10]}")
        else:
            # 对于非商家ID匹配，使用 outer join 保留所有数据
            merged = pd.merge(
                df_google,
                df_affiliate,
                on=match_keys,
                how='outer',
                suffixes=('', '_affiliate')
            )
        
        # 3) 提取关键字段并计算指标
        result_df = pd.DataFrame()
        
        # 保留匹配键
        for key in match_keys:
            if key in merged.columns:
                result_df[key] = merged[key]
        
        # 点击（来自表1）
        if '点击' in merged.columns:
            result_df['点击'] = merged['点击'].fillna(0)
        else:
            raise ValueError("无法找到'点击'相关字段。\n表1的列名（前10个）: " + 
                           ", ".join(df_google.columns[:10].tolist()) + 
                           "\n请确保表1包含'点击'、'Clicks'或'点击次数'等字段。")
        
        # CPC（来自表1）
        if 'CPC' in merged.columns:
            result_df['CPC'] = merged['CPC'].fillna(0)
        else:
            raise ValueError("无法找到'CPC'相关字段。\n表1的列名（前10个）: " + 
                           ", ".join(df_google.columns[:10].tolist()) + 
                           "\n请确保表1包含'CPC'、'每次点击成本'或'平均每次点击费用'等字段。")
        
        # 订单数（来自表2）
        if '订单' in merged.columns:
            result_df['订单'] = merged['订单'].fillna(0)
        else:
            result_df['订单'] = 0
        
        # 费用（来自表1）——保守ROI计算依赖费用，因此需要在ROI计算前准备好
        if '费用' in merged.columns:
            result_df['费用'] = merged['费用'].fillna(0)
        else:
            result_df['费用'] = 0

        # 佣金（来自表2）——对外统一命名为“佣金”，不再输出“回传佣金”
        if '回传佣金' in merged.columns:
            result_df['佣金'] = merged['回传佣金'].fillna(0)
        elif '佣金' in merged.columns:
            result_df['佣金'] = merged['佣金'].fillna(0)
        else:
            result_df['佣金'] = 0
        
        # 保守佣金 = 佣金 * 0.72（按你提供的口径）
        result_df['保守佣金'] = result_df['佣金'] * 0.72

        # 保守EPC = 保守佣金 / 点击
        result_df['保守EPC'] = result_df.apply(
            lambda row: row['保守佣金'] / row['点击'] if row['点击'] > 0 else 0,
            axis=1
        )
        
        # 保守ROI = (佣金*0.72 - 费用) / 费用
        # 按你要求返回“原始值”，不做 *100 等任何转换；若费用为0则返回None
        result_df['保守ROI'] = result_df.apply(
            lambda row: ((row['保守佣金'] - row['费用']) / row['费用']) if row['费用'] > 0 else None,
            axis=1
        )
        
        # 保留其他有用字段（按照模板顺序）
        if '广告系列' in merged.columns:
            result_df['广告系列'] = merged['广告系列']
        # 费用已在上方计算/填充，这里不再重复赋值
        # 预算（来自表1，如有）
        if '预算' in merged.columns:
            result_df['预算'] = merged['预算'].fillna(0)

        # ========= 通用输出模板字段映射（输出表格.xlsx）=========
        # L7D点击/佣金/花费：过去七天口径（当前实现为表内汇总口径，按现有需求等同于点击/佣金/费用）
        result_df['L7D点击'] = result_df.get('点击', 0)
        result_df['L7D佣金'] = result_df.get('佣金', 0)
        result_df['L7D花费'] = result_df.get('费用', 0)
        # L7D出单天数：过去七天出单天数（优先用表1的过去七天出单天数，否则退化为出单天数）
        if '过去七天出单天数' in merged.columns:
            result_df['L7D出单天数'] = merged['过去七天出单天数'].fillna(0)
        else:
            result_df['L7D出单天数'] = result_df.get('出单天数', 0)
        # 当前Max CPC：最高CPC
        result_df['当前Max CPC'] = result_df.get('最高CPC', result_df.get('CPC', 0))
        # IS Budget丢失 / IS Rank丢失
        result_df['IS Budget丢失'] = result_df.get('预算错失份额', None)
        result_df['IS Rank丢失'] = result_df.get('排名错失份额', None)
        # 广告系列名 / MID
        result_df['广告系列名'] = result_df.get('广告系列', None)
        result_df['MID'] = result_df.get('商家ID', None)
        
        # 出单天数（从表1读取，如果没有则使用订单数）
        if '过去七天出单天数' in merged.columns:
            result_df['出单天数'] = merged['过去七天出单天数']
        elif '订单' in merged.columns:
            # 如果订单数>0，认为出单天数至少为1
            result_df['出单天数'] = merged['订单'].apply(lambda x: 1 if x > 0 else 0)
        else:
            result_df['出单天数'] = 0
        
        # 最高CPC（如果有的话）
        if '最高CPC' in merged.columns:
            result_df['最高CPC'] = merged['最高CPC'].fillna(0)
        else:
            # 如果没有最高CPC，使用CPC作为默认值
            result_df['最高CPC'] = result_df.get('CPC', 0)
        
        # 预算错失份额
        if '预算错失份额' in merged.columns:
            result_df['预算错失份额'] = merged['预算错失份额']
        else:
            result_df['预算错失份额'] = None
        
        # 排名错失份额
        if '排名错失份额' in merged.columns:
            result_df['排名错失份额'] = merged['排名错失份额']
        else:
            result_df['排名错失份额'] = None
        
        # 佣金已在上方统一生成，这里不再重复赋值
        
        # 谷歌状态（原"表1状态"）
        if '谷歌状态' in merged.columns:
            result_df['谷歌状态'] = merged['谷歌状态']
        elif '表1状态' in merged.columns:
            # 兼容旧数据
            result_df['谷歌状态'] = merged['表1状态']
        else:
            # 兜底：留空，后续可由模板规则填充（若你仍想保留规则）
            result_df['谷歌状态'] = None
        
        result_df['异常类型'] = None
        
        # 生成操作指令（根据经理提供的公式）
        # 注意：这里暂时不传递全局值，因为_merge_and_analyze方法没有接收这些参数
        # 我们将在process_analysis中调用_generate_operation_instruction时传递
        result_df['操作指令'] = None  # 先设置为None，后续在process_analysis中生成
        
        # 删除临时索引列（如果存在）
        if '_temp_index' in result_df.columns:
            result_df = result_df.drop(columns=['_temp_index'])
        
        return result_df
    
    def _detect_match_keys(self, df1: pd.DataFrame, df2: pd.DataFrame) -> list:
        """
        自动检测匹配键
        
        查找两个DataFrame中共同的列名作为匹配键
        支持列名的大小写不敏感匹配和相似列名匹配
        """
        # 获取所有列名（转换为小写用于比较）
        df1_cols_lower = {col.lower().strip(): col for col in df1.columns}
        df2_cols_lower = {col.lower().strip(): col for col in df2.columns}
        
        # 找到共同的列（大小写不敏感）
        common_cols_lower = set(df1_cols_lower.keys()) & set(df2_cols_lower.keys())
        
        # 转换为原始列名
        common_cols = []
        for col_lower in common_cols_lower:
            # 优先使用df1的列名
            common_cols.append(df1_cols_lower[col_lower])
        
        if not common_cols:
            # 如果大小写不敏感匹配失败，尝试相似列名匹配
            common_cols = self._find_similar_columns(df1.columns, df2.columns)
        
        if not common_cols:
            # 如果还是没有找到，返回空列表（会在调用处抛出错误）
            return []
        
        # 优先使用日期相关的列（支持中英文）
        date_keywords = ['日期', 'date', '时间', 'time', 'day', '天', '日', 'datetime']
        date_cols = [col for col in common_cols if any(keyword in col.lower() for keyword in date_keywords)]
        if date_cols:
            match_keys = date_cols.copy()
        else:
            match_keys = []
        
        # 添加ID相关的列（支持中英文）
        id_keywords = ['id', '编号', 'code', 'key', '标识', '序号', 'number', 'no', 'num']
        id_cols = [col for col in common_cols if any(keyword in col.lower() for keyword in id_keywords)]
        if id_cols:
            match_keys.extend([col for col in id_cols if col not in match_keys])
        
        # 如果没有找到特殊列，使用所有共同列
        if not match_keys:
            match_keys = common_cols
        
        return match_keys[:3]  # 最多使用3个匹配键
    
    def _find_similar_columns(self, cols1: list, cols2: list) -> list:
        """
        查找相似的列名（处理空格、特殊字符等差异）
        """
        similar_cols = []
        cols1_normalized = {self._normalize_column_name(col): col for col in cols1}
        cols2_normalized = {self._normalize_column_name(col): col for col in cols2}
        
        common_normalized = set(cols1_normalized.keys()) & set(cols2_normalized.keys())
        for norm_col in common_normalized:
            similar_cols.append(cols1_normalized[norm_col])
        
        return similar_cols
    
    def _normalize_column_name(self, col_name: str) -> str:
        """
        标准化列名：去除空格、特殊字符，转换为小写
        """
        import re
        # 去除所有空格和特殊字符，只保留字母数字和中文
        normalized = re.sub(r'[^\w\u4e00-\u9fff]', '', col_name.lower())
        return normalized
    
    def _find_cross_language_columns(self, cols1: list, cols2: list) -> list:
        """
        查找跨语言的相似列名（中英文映射）
        
        常见映射：
        - 日期/Date
        - ID/编号
        - 名称/Name
        - 点击/Clicks
        - 订单/Orders
        """
        # 中英文列名映射表
        column_mapping = {
            # 日期相关
            '日期': ['date', 'day', 'time', 'datetime'],
            'date': ['日期', '天', '日', '时间'],
            'day': ['日期', '天', '日'],
            'time': ['时间', '日期'],
            'datetime': ['日期时间', '日期', '时间'],
            # ID相关
            'id': ['编号', '标识', '序号'],
            '编号': ['id', 'number', 'no', 'num'],
            '标识': ['id', 'identifier'],
            # 名称相关
            'name': ['名称', '名字'],
            '名称': ['name', 'title'],
            '名字': ['name'],
            # 其他常见列
            'clicks': ['点击', '点击数', '点击次数', '点击量'],
            '点击': ['clicks', 'click'],
            '点击数': ['clicks', 'click count'],
            '点击次数': ['clicks', 'click count'],
            'orders': ['订单', '订单数', '订单数量'],
            '订单': ['orders', 'order'],
            '订单数': ['orders', 'order count'],
            '订单数量': ['orders', 'order count'],
        }
        
        matched_cols = []
        cols1_lower = {col.lower(): col for col in cols1}
        cols2_lower = {col.lower(): col for col in cols2}
        
        # 检查每个列名是否有对应的翻译
        for col1_lower, col1_orig in cols1_lower.items():
            # 检查是否有直接映射
            if col1_lower in column_mapping:
                for mapped_name in column_mapping[col1_lower]:
                    if mapped_name in cols2_lower:
                        matched_cols.append(col1_orig)
                        break
            # 检查反向映射
            for mapped_name, translations in column_mapping.items():
                if col1_lower in translations:
                    if mapped_name in cols2_lower:
                        matched_cols.append(col1_orig)
                        break
        
        return matched_cols
    
    def _find_column(self, df: pd.DataFrame, possible_names: list) -> Optional[str]:
        """
        在DataFrame中查找可能的列名
        
        支持：
        1. 精确匹配
        2. 大小写不敏感匹配
        3. 部分匹配（列名包含关键词）
        
        参数:
            df: DataFrame对象
            possible_names: 可能的列名列表
        
        返回:
            找到的列名，如果没找到返回None
        """
        # 首先尝试精确匹配
        for name in possible_names:
            if name in df.columns:
                return name
        
        # 尝试大小写不敏感匹配
        df_cols_lower = {col.lower(): col for col in df.columns}
        for name in possible_names:
            name_lower = name.lower()
            if name_lower in df_cols_lower:
                return df_cols_lower[name_lower]
        
        # 尝试部分匹配（列名包含关键词）
        for name in possible_names:
            name_lower = name.lower()
            for col in df.columns:
                col_lower = col.lower()
                # 如果列名包含关键词，或者关键词包含在列名中
                if name_lower in col_lower or col_lower in name_lower:
                    return col
        
        return None
    
    def _calculate_summary(self, df: pd.DataFrame) -> Dict:
        """
        计算汇总统计
        
        参数:
            df: 分析结果DataFrame
        
        返回:
            汇总统计字典
        """
        summary = {
            "total_rows": len(df),
        }
        
        # 日期范围
        date_cols = [col for col in df.columns if '日期' in col or 'date' in col.lower() or 'Date' in col]
        if date_cols and len(date_cols) > 0:
            date_col = date_cols[0]
            valid_dates = pd.to_datetime(df[date_col], errors='coerce').dropna()
            if len(valid_dates) > 0:
                summary['date_range'] = {
                    "start": valid_dates.min().strftime('%Y-%m-%d'),
                    "end": valid_dates.max().strftime('%Y-%m-%d')
                }
        
        # 保守EPC统计
        if '保守EPC' in df.columns:
            valid_epc = df['保守EPC'].dropna()
            if len(valid_epc) > 0:
                summary['epc'] = {
                    "avg": float(round(valid_epc.mean(), 4)),
                    "max": float(round(valid_epc.max(), 4)),
                    "min": float(round(valid_epc.min(), 4)),
                    "count": int(len(valid_epc))
                }
        
        # 保守ROI统计
        if '保守ROI' in df.columns:
            valid_roi = df['保守ROI'].dropna()
            if len(valid_roi) > 0:
                summary['roi'] = {
                    "avg": float(round(valid_roi.mean(), 2)),
                    "max": float(round(valid_roi.max(), 2)),
                    "min": float(round(valid_roi.min(), 2)),
                    "positive_count": int((valid_roi > 0).sum()),  # 盈利的记录数
                    "negative_count": int((valid_roi < 0).sum()),   # 亏损的记录数
                    "zero_count": int((valid_roi == 0).sum()),     # 盈亏平衡的记录数
                    "count": int(len(valid_roi))
                }
        
        return summary
    
    def _apply_template_rules(self, df: pd.DataFrame) -> pd.DataFrame:
        """
        应用分析表模板规则，生成处理动作建议
        
        参数:
            df: 分析结果DataFrame
        
        返回:
            添加了处理动作的DataFrame
        """
        if not PANDAS_AVAILABLE:
            return df
        
        try:
            template_service = AnalysisTemplateService()
            template_service.load_template()
            
            stage_label_service = StageLabelService()
            stage_label_service.load_rules()
            
            # 应用模板规则
            result_df = df.copy()
            
            # 添加处理动作列
            if '处理动作' not in result_df.columns:
                result_df['处理动作'] = None
            
            # 应用规则生成处理动作
            for idx, row in result_df.iterrows():
                # 获取保守ROI值（可能是百分比字符串，需要转换为数值）
                conservative_roi = row.get('保守ROI', None)
                if conservative_roi is not None:
                    try:
                        # 如果是字符串，去除%并转换为浮点数
                        if isinstance(conservative_roi, str):
                            conservative_roi = float(conservative_roi.replace('%', '').strip())
                        else:
                            conservative_roi = float(conservative_roi)
                    except (ValueError, TypeError):
                        conservative_roi = None
                
                # 使用get_action_for_roi方法获取处理动作
                action_info = template_service.get_action_for_roi(conservative_roi)
                if action_info and action_info.get('action_cn'):
                    result_df.at[idx, '处理动作'] = action_info.get('action_cn')
            
            # 应用阶段标签
            if '阶段标签' not in result_df.columns:
                result_df['阶段标签'] = None
            
            for idx, row in result_df.iterrows():
                stage_label_info = stage_label_service.get_stage_label(
                    clicks=row.get('点击', 0),
                    cpc=row.get('CPC', 0),
                    orders=row.get('订单', 0),
                    conservative_epc=row.get('保守EPC', 0),
                    conservative_roi=row.get('保守ROI', 0),
                    cost=row.get('费用', 0)
                )
                if stage_label_info and stage_label_info.get('stage_label'):
                    result_df.at[idx, '阶段标签'] = stage_label_info['stage_label']
            
            return result_df
            
        except Exception as e:
            # 如果应用规则失败，返回原始数据
            import logging
            logger = logging.getLogger(__name__)
            logger.warning(f"应用模板规则失败: {str(e)}")
            return df
    
    def _detect_anomaly_types(
        self,
        df: pd.DataFrame,
        platform_id: int,
        analysis_date: str,
        db: object
    ) -> pd.DataFrame:
        """
        检测异常类型
        需要对比前一天同一平台、同一商家的数据
        
        参数:
            df: 分析结果DataFrame
            platform_id: 平台ID
            analysis_date: 分析日期（字符串格式：YYYY-MM-DD）
            db: 数据库会话
        
        返回:
            添加了异常类型的DataFrame
        """
        if not PANDAS_AVAILABLE:
            return df
        
        try:
            from app.models.analysis_result import AnalysisResult
            from app.models.affiliate_account import AffiliateAccount
            from datetime import datetime, timedelta
            
            # 解析日期
            try:
                from datetime import date as date_type
                if isinstance(analysis_date, str):
                    current_date = datetime.strptime(analysis_date, '%Y-%m-%d').date()
                elif hasattr(analysis_date, 'date'):
                    # 如果是datetime对象
                    current_date = analysis_date.date()
                elif isinstance(analysis_date, date_type):
                    current_date = analysis_date
                else:
                    current_date = datetime.now().date()
            except Exception as e:
                import logging
                logger = logging.getLogger(__name__)
                logger.warning(f"解析日期失败: {analysis_date}, 错误: {e}")
                current_date = datetime.now().date()
            
            previous_date = current_date - timedelta(days=1)
            
            # 查询前一天同一平台的分析结果
            previous_results = db.query(AnalysisResult).join(
                AffiliateAccount
            ).filter(
                AffiliateAccount.platform_id == platform_id,
                AnalysisResult.analysis_date == previous_date
            ).all()
            
            # 构建前一天数据的索引（按商家ID）
            previous_data_map = {}
            for result in previous_results:
                result_data = result.result_data.get('data', [])
                for row in result_data:
                    merchant_id = str(row.get('商家ID', '')).strip()
                    if merchant_id and merchant_id != 'None' and merchant_id != 'nan':
                        if merchant_id not in previous_data_map:
                            previous_data_map[merchant_id] = row
            
            # 初始化异常类型服务
            anomaly_service = AnomalyService()
            anomaly_service.load_rules()
            
            # 为每行数据检测异常类型
            result_df = df.copy()
            if '异常类型' not in result_df.columns:
                result_df['异常类型'] = None
            
            for idx, row in result_df.iterrows():
                merchant_id = str(row.get('商家ID', '')).strip()
                if not merchant_id or merchant_id == 'None' or merchant_id == 'nan':
                    result_df.at[idx, '异常类型'] = None
                    continue
                
                # 获取前一天的数据
                previous_data = previous_data_map.get(merchant_id)
                if not previous_data:
                    # 如果前一天无数据，则不输出异常类型
                    result_df.at[idx, '异常类型'] = None
                    continue
                
                # 检测异常
                current_data = row.to_dict()
                anomaly_type = anomaly_service.detect_anomaly(current_data, previous_data)
                result_df.at[idx, '异常类型'] = anomaly_type
            
            return result_df
            
        except Exception as e:
            import logging
            logger = logging.getLogger(__name__)
            logger.warning(f"检测异常类型失败: {str(e)}")
            # 如果检测失败，返回原始数据（异常类型列为None）
            if '异常类型' not in df.columns:
                df['异常类型'] = None
            return df
    
    def _generate_operation_instruction(
        self, 
        row: pd.Series,
        past_seven_days_orders_global: Optional[float] = None,
        max_cpc_global: Optional[float] = None
    ) -> str:
        """
        根据经理提供的操作指令公式生成操作指令
        
        公式逻辑：
        =IF(保守ROI<-0.4, "立即关停(PAUSE)",
            IF(保守ROI<0, "▲ CPC降价0.05",
                IF(AND(保守ROI>3, 预算错失份额>0.2, 过去七天出单天数>=4), "💰 预算*1.3 (稳健加产)",
                    IF(AND(保守ROI>2, 排名错失份额>0.15, 最高CPC<(I2*0.8)), "📈 CPC+0.02 (抢占排名)",
                        IF(保守ROI>=1, "✅ 状态稳定-维持现状", "☕ 样本不足-继续观察")
                    )
                )
            )
        )
        """
        try:
            # 获取关键指标
            conservative_roi = row.get('保守ROI', 0)
            if conservative_roi is None:
                conservative_roi = 0
            else:
                try:
                    conservative_roi = float(conservative_roi)
                except:
                    conservative_roi = 0
            
            # 处理预算错失份额（可能是百分比字符串，如"20.00%"）
            budget_lost_share = row.get('预算错失份额', 0)
            if budget_lost_share is None:
                budget_lost_share = 0
            else:
                budget_lost_share_str = str(budget_lost_share)
                if '%' in budget_lost_share_str:
                    try:
                        budget_lost_share = float(budget_lost_share_str.replace('%', '')) / 100
                    except:
                        budget_lost_share = 0
                else:
                    try:
                        budget_lost_share = float(budget_lost_share_str)
                        # 如果值在0-1之间，认为是比例；否则认为是百分比
                        if budget_lost_share > 1:
                            budget_lost_share = budget_lost_share / 100
                    except:
                        budget_lost_share = 0
            
            # 处理排名错失份额
            rank_lost_share = row.get('排名错失份额', 0)
            if rank_lost_share is None:
                rank_lost_share = 0
            else:
                rank_lost_share_str = str(rank_lost_share)
                if '%' in rank_lost_share_str:
                    try:
                        rank_lost_share = float(rank_lost_share_str.replace('%', '')) / 100
                    except:
                        rank_lost_share = 0
                else:
                    try:
                        rank_lost_share = float(rank_lost_share_str)
                        if rank_lost_share > 1:
                            rank_lost_share = rank_lost_share / 100
                    except:
                        rank_lost_share = 0
            
            # 获取CPC和最高CPC（如果有的话）
            cpc = row.get('CPC', 0) or 0
            try:
                cpc = float(cpc)
            except:
                cpc = 0
            
            # 获取过去七天出单天数
            # 注意：这个字段可能需要从历史数据中计算
            # 暂时使用订单数作为近似：如果订单数>=4，认为过去七天出单天数>=4
            orders = row.get('订单', 0) or 0
            try:
                orders = float(orders)
            except:
                orders = 0
            
            # 获取过去七天出单天数
            # 优先级：数据中的字段（从表1读取） > 手动输入的全局值 > 订单数近似值
            past_seven_days_orders = None
            
            # 首先尝试从数据中获取（从表1读取，每个广告系列可能有不同值）
            # 检查列是否存在且值不为空
            if '过去七天出单天数' in row.index and pd.notna(row.get('过去七天出单天数')):
                try:
                    past_seven_days_orders = float(row.get('过去七天出单天数'))
                except (ValueError, TypeError):
                    past_seven_days_orders = None
            
            # 如果数据中没有，使用手动输入的全局值
            if past_seven_days_orders is None and past_seven_days_orders_global is not None:
                try:
                    past_seven_days_orders = float(past_seven_days_orders_global)
                except (ValueError, TypeError):
                    past_seven_days_orders = None
            
            # 如果都没有，使用订单数作为近似
            if past_seven_days_orders is None:
                # 如果订单数>=4，认为过去七天出单天数>=4
                past_seven_days_orders = 4 if orders >= 4 else orders
            
            # 获取最高CPC
            # 优先级：数据中的字段（从表1读取） > 手动输入的全局值 > CPC值
            max_cpc = None
            
            # 首先尝试从数据中获取（从表1读取，每个广告系列可能有不同值）
            # 检查列是否存在且值不为空
            if '最高CPC' in row.index and pd.notna(row.get('最高CPC')):
                try:
                    max_cpc = float(row.get('最高CPC'))
                except (ValueError, TypeError):
                    max_cpc = None
            
            # 如果数据中没有，使用手动输入的全局值
            if max_cpc is None and max_cpc_global is not None:
                try:
                    max_cpc = float(max_cpc_global)
                except (ValueError, TypeError):
                    max_cpc = None
            
            # 如果都没有，使用CPC值
            if max_cpc is None:
                max_cpc = cpc
            
            # 按照公式逻辑生成操作指令
            # 1. 如果保守ROI < -0.4，立即关停
            if conservative_roi < -0.4:
                return "立即关停(PAUSE)"
            
            # 2. 如果保守ROI < 0（但不小于-0.4），CPC降价0.05
            if conservative_roi < 0:
                return "▲ CPC降价0.05"
            
            # 3. 如果保守ROI > 3 且 预算错失份额 > 0.2 且 过去七天出单天数 >= 4，预算*1.3
            if conservative_roi > 3 and budget_lost_share > 0.2 and past_seven_days_orders >= 4:
                return "💰 预算*1.3 (稳健加产)"
            
            # 4. 如果保守ROI > 2 且 排名错失份额 > 0.15 且 最高CPC < (CPC*0.8)，CPC+0.02
            if conservative_roi > 2 and rank_lost_share > 0.15 and max_cpc < (cpc * 0.8):
                return "📈 CPC+0.02 (抢占排名)"
            
            # 5. 如果保守ROI >= 1，状态稳定
            if conservative_roi >= 1:
                return "✅ 状态稳定-维持现状"
            
            # 6. 其他情况，样本不足
            return "☕ 样本不足-继续观察"
            
        except Exception as e:
            import logging
            logger = logging.getLogger(__name__)
            logger.warning(f"生成操作指令失败: {str(e)}")
            return "☕ 样本不足-继续观察"
