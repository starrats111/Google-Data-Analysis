"""
异常类型检测服务
参照excel文件夹下的表5.xlsx
"""
try:
    import pandas as pd
    PANDAS_AVAILABLE = True
except ImportError:
    PANDAS_AVAILABLE = False
    pd = None

from typing import Dict, List, Optional
from pathlib import Path
from app.config import settings
from datetime import datetime, timedelta
import logging
import re


class AnomalyService:
    """异常类型检测服务"""
    
    def __init__(self):
        # 统一以"项目根目录"为基准解析（repo_root/excel/表5.xlsx）
        raw_path = Path(getattr(settings, "ANOMALY_TEMPLATE_FILE", "excel/表5.xlsx"))
        if raw_path.is_absolute():
            self.template_path = raw_path
        else:
            repo_root = Path(__file__).resolve().parents[3]
            self.template_path = repo_root / raw_path
        self.rules = None
        
    def load_rules(self) -> List[Dict]:
        """加载表5的异常类型规则"""
        if self.rules is not None:
            return self.rules
            
        if not self.template_path.exists():
            logging.warning(f"表5文件不存在: {self.template_path}")
            return []
        
        try:
            df = pd.read_excel(self.template_path, engine='openpyxl')
            
            # 检查必要的列是否存在
            required_cols = ['异常类型', '优先级', '触发条件']
            missing_cols = [col for col in required_cols if col not in df.columns]
            if missing_cols:
                logging.warning(f"表5中缺少列: {missing_cols}，使用默认规则")
                return []
            
            # 清理数据：移除空行
            df = df.dropna(subset=['异常类型'])
            df = df[df['异常类型'].str.strip() != '']
            
            if len(df) == 0:
                logging.warning("表5中没有有效规则")
                return []
            
            rules = []
            for _, row in df.iterrows():
                rule = {
                    'anomaly_type': str(row['异常类型']).strip(),
                    'priority': str(row.get('优先级', 'P1')).strip().upper(),
                    'trigger_conditions': str(row.get('触发条件', '')).strip(),
                    'description': str(row.get('说明', '')).strip(),
                }
                rules.append(rule)
            
            self.rules = rules
            logging.info(f"成功加载 {len(rules)} 条异常类型规则")
            return rules
            
        except Exception as e:
            logging.error(f"加载表5规则失败: {e}", exc_info=True)
            return []
    
    def detect_anomaly(
        self,
        current_data: Dict,
        previous_data: Optional[Dict] = None
    ) -> Optional[str]:
        """
        检测异常类型
        
        Args:
            current_data: 当前数据（包含：点击、订单、保守EPC、保守ROI等）
            previous_data: 前一天的数据（可选）
        
        Returns:
            异常类型字符串（包含优先级，如"P0-点击大幅下降"），如果没有异常返回None
        """
        if not previous_data:
            return None
        
        if not self.rules:
            self.load_rules()
        
        if not self.rules:
            return None
        
        # 获取当前和对比基线（previous_data）的关键指标
        # 兼容：旧口径使用“保守EPC/保守ROI”，新“每日分析”口径可能使用“EPC/ROI”
        current_clicks = float(current_data.get('点击', 0) or 0)
        current_orders = float(current_data.get('订单', 0) or 0)
        current_epc = float(current_data.get('保守EPC', current_data.get('EPC', 0)) or 0)
        current_roi = current_data.get('保守ROI', current_data.get('ROI', 0))
        if current_roi is not None:
            try:
                current_roi = float(current_roi)
            except:
                current_roi = 0
        else:
            current_roi = 0
        current_cpc = float(current_data.get('CPC', 0) or 0)
        
        prev_clicks = float(previous_data.get('点击', 0) or 0)
        prev_orders = float(previous_data.get('订单', 0) or 0)
        prev_epc = float(previous_data.get('保守EPC', previous_data.get('EPC', 0)) or 0)
        prev_roi = previous_data.get('保守ROI', previous_data.get('ROI', 0))
        if prev_roi is not None:
            try:
                prev_roi = float(prev_roi)
            except:
                prev_roi = 0
        else:
            prev_roi = 0
        prev_cpc = float(previous_data.get('CPC', 0) or 0)
        
        # 计算变化率（避免除零）
        clicks_change = ((current_clicks - prev_clicks) / prev_clicks * 100) if prev_clicks > 0 else 0
        orders_change = ((current_orders - prev_orders) / prev_orders * 100) if prev_orders > 0 else 0
        epc_change = ((current_epc - prev_epc) / prev_epc * 100) if prev_epc > 0 else 0
        roi_change = ((current_roi - prev_roi) / prev_roi * 100) if prev_roi != 0 and prev_roi is not None else 0
        
        # 按优先级排序（P0优先于P1）
        sorted_rules = sorted(self.rules, key=lambda r: 0 if r.get('priority', 'P1').upper() == 'P0' else 1)
        
        # 检查每个规则
        for rule in sorted_rules:
            if self._check_rule(rule, current_data, previous_data, {
                'clicks_change': clicks_change,
                'orders_change': orders_change,
                'epc_change': epc_change,
                'roi_change': roi_change,
                'current_clicks': current_clicks,
                'prev_clicks': prev_clicks,
                'current_orders': current_orders,
                'prev_orders': prev_orders,
                'current_epc': current_epc,
                'prev_epc': prev_epc,
                'current_roi': current_roi,
                'prev_roi': prev_roi,
            }):
                # 返回包含优先级的异常类型
                priority = rule.get('priority', 'P1').upper()
                anomaly_type = rule.get('anomaly_type', '')
                # 如果异常类型不包含优先级，则添加
                if not anomaly_type.startswith('P0') and not anomaly_type.startswith('P1'):
                    return f"{priority}-{anomaly_type}"
                return anomaly_type
        
        return None
    
    def _check_rule(
        self,
        rule: Dict,
        current_data: Dict,
        previous_data: Dict,
        changes: Dict
    ) -> bool:
        """检查规则是否满足"""
        conditions = rule.get('trigger_conditions', '')
        if not conditions:
            return False
        
        try:
            # 替换中文运算符和变量名
            conditions = conditions.replace('≥', '>=').replace('≤', '<=').replace('×', '*')
            conditions = conditions.replace('点击', 'clicks').replace('订单', 'orders')
            conditions = conditions.replace('保守EPC', 'epc').replace('保守ROI', 'roi')
            conditions = conditions.replace('EPC', 'epc').replace('ROI', 'roi')
            conditions = conditions.replace('下降', 'decrease').replace('上升', 'increase')
            
            # 处理"且"和"或"
            if ' 且 ' in conditions or ' and ' in conditions.lower():
                parts = re.split(r'\s+且\s+|\s+and\s+', conditions, flags=re.IGNORECASE)
                return all(self._evaluate_anomaly_condition(part.strip(), changes) for part in parts if part.strip())
            elif ' 或 ' in conditions or ' or ' in conditions.lower():
                parts = re.split(r'\s+或\s+|\s+or\s+', conditions, flags=re.IGNORECASE)
                return any(self._evaluate_anomaly_condition(part.strip(), changes) for part in parts if part.strip())
            else:
                return self._evaluate_anomaly_condition(conditions, changes)
        except Exception as e:
            logging.warning(f"检查规则失败: {e}")
            return False
    
    def _evaluate_anomaly_condition(self, condition: str, changes: Dict) -> bool:
        """评估单个异常条件"""
        import re
        try:
            # 处理变化率条件，如 "clicks decrease > 50%"
            change_match = re.search(r'(clicks|orders|epc|roi)\s+(decrease|increase)\s*([><=]+)\s*(\d+(?:\.\d+)?)', condition, re.IGNORECASE)
            if change_match:
                metric = change_match.group(1).lower()
                direction = change_match.group(2).lower()
                op = change_match.group(3)
                threshold = float(change_match.group(4))
                
                change_key = f"{metric}_change"
                if change_key not in changes:
                    return False
                
                change_value = changes[change_key]
                if direction == 'decrease':
                    # 下降：变化率应该是负数
                    if op == '>':
                        return change_value < -threshold
                    elif op == '>=':
                        return change_value <= -threshold
                    elif op == '<':
                        return change_value > -threshold
                    elif op == '<=':
                        return change_value >= -threshold
                elif direction == 'increase':
                    # 上升：变化率应该是正数
                    if op == '>':
                        return change_value > threshold
                    elif op == '>=':
                        return change_value >= threshold
                    elif op == '<':
                        return change_value < threshold
                    elif op == '<=':
                        return change_value <= threshold
            
            # 处理绝对值条件，如 "clicks < 10"
            abs_match = re.search(r'(clicks|orders|epc|roi)\s*([><=]+)\s*(\d+(?:\.\d+)?)', condition, re.IGNORECASE)
            if abs_match:
                metric = abs_match.group(1).lower()
                op = abs_match.group(2)
                threshold = float(abs_match.group(3))
                
                value_key = f"current_{metric}"
                if value_key not in changes:
                    return False
                
                value = changes[value_key]
                if op == '>':
                    return value > threshold
                elif op == '>=':
                    return value >= threshold
                elif op == '<':
                    return value < threshold
                elif op == '<=':
                    return value <= threshold
                elif op == '==' or op == '=':
                    return abs(value - threshold) < 0.01
            
            return False
        except Exception as e:
            logging.warning(f"评估条件失败: {condition}, 错误: {e}")
            return False
    
    def _extract_threshold(self, condition: str) -> Optional[float]:
        """从条件字符串中提取阈值"""
        import re
        # 尝试提取数字（百分比）
        match = re.search(r'(\d+(?:\.\d+)?)', condition)
        if match:
            return float(match.group(1))
        return None

