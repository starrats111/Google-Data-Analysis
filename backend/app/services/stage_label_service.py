"""
阶段标签分析服务
参照excel文件夹下的表4.xlsx
"""
import pandas as pd
from typing import Dict, List, Optional
from pathlib import Path
from app.config import settings
import re
import logging


class StageLabelService:
    """阶段标签分析服务"""
    
    def __init__(self):
        # 统一以“项目根目录”为基准解析（repo_root/excel/表4.xlsx）
        raw_path = Path(getattr(settings, "STAGE_LABEL_TEMPLATE_FILE", "excel/表4.xlsx"))
        if raw_path.is_absolute():
            self.template_path = raw_path
        else:
            repo_root = Path(__file__).resolve().parents[3]
            self.template_path = repo_root / raw_path
        self.rules = None
        
    def load_rules(self) -> List[Dict]:
        """加载表4的规则"""
        if self.rules is not None:
            return self.rules
            
        if not self.template_path.exists():
            logging.warning(f"表4文件不存在: {self.template_path}")
            return self._get_default_rules()
        
        try:
            df = pd.read_excel(self.template_path, engine='openpyxl')
            
            # 检查必要的列是否存在
            if '分桶（标签）' not in df.columns:
                logging.warning("表4中未找到'分桶（标签）'列，使用默认规则")
                default_rules = self._get_default_rules()
                self.rules = default_rules
                return default_rules
            
            # 清理数据：移除空行和说明行
            df = df.dropna(subset=['分桶（标签）'])
            df = df[df['分桶（标签）'].str.strip() != '']
            
            if len(df) == 0:
                logging.warning("表4中没有有效规则，使用默认规则")
                default_rules = self._get_default_rules()
                self.rules = default_rules
                return default_rules
            
            rules = []
            for _, row in df.iterrows():
                label = str(row['分桶（标签）']).strip()
                if not label or label == 'nan':
                    continue
                    
                rule = {
                    'label': label,
                    'when_to_use': str(row.get('何时使用', '')).strip(),
                    'trigger_conditions': str(row.get('触发条件（满足其一/组合）', '')).strip(),
                    'action_ad': str(row.get('投放动作（投放组）', '')).strip(),
                    'action_data': str(row.get('数据动作（数据组）', '')).strip(),
                    'action_risk': str(row.get('风控动作（风控组）', '')).strip(),
                }
                rules.append(rule)
            
            if len(rules) == 0:
                logging.warning("未解析到任何规则，使用默认规则")
                default_rules = self._get_default_rules()
                self.rules = default_rules
                return default_rules
            
            self.rules = rules
            logging.info(f"成功加载 {len(rules)} 条阶段标签规则")
            return rules
            
        except Exception as e:
            logging.error(f"加载表4规则失败: {e}", exc_info=True)
            return self._get_default_rules()
    
    def get_stage_label(
        self,
        clicks: Optional[float] = None,
        cpc: Optional[float] = None,
        orders: Optional[float] = None,
        conservative_epc: Optional[float] = None,
        conservative_roi: Optional[float] = None,
        cost: Optional[float] = None
    ) -> Dict:
        """
        根据数据计算阶段标签
        
        Args:
            clicks: 点击次数
            cpc: 平均每次点击费用
            orders: 订单数
            conservative_epc: 保守EPC
            conservative_roi: 保守ROI
            cost: 花费
            
        Returns:
            包含标签和动作信息的字典
        """
        if self.rules is None:
            self.load_rules()
        
        # 确保数值类型
        clicks = float(clicks) if clicks is not None and pd.notna(clicks) else 0
        cpc = float(cpc) if cpc is not None and pd.notna(cpc) else 0
        orders = float(orders) if orders is not None and pd.notna(orders) else 0
        conservative_epc = float(conservative_epc) if conservative_epc is not None and pd.notna(conservative_epc) else 0
        conservative_roi = float(conservative_roi) if conservative_roi is not None and pd.notna(conservative_roi) else 0
        cost = float(cost) if cost is not None and pd.notna(cost) else 0
        
        # 确保rules不为None
        if not self.rules:
            logging.warning("规则列表为空，使用默认规则")
            self.rules = self._get_default_rules()
        
        # 按优先级检查规则（K1优先级最高，然后是S1、P1、T2、T1）
        priority_order = ['K1', 'S1', 'P1', 'T2', 'T1']
        sorted_rules = sorted(
            self.rules,
            key=lambda r: self._get_label_priority(r['label'], priority_order)
        )
        
        for rule in sorted_rules:
            if self._check_conditions(
                rule['trigger_conditions'],
                clicks=clicks,
                cpc=cpc,
                orders=orders,
                conservative_epc=conservative_epc,
                conservative_roi=conservative_roi,
                cost=cost
            ):
                return {
                    'stage_label': rule['label'],
                    'when_to_use': rule['when_to_use'],
                    'action_ad': rule['action_ad'],
                    'action_data': rule['action_data'],
                    'action_risk': rule['action_risk'],
                }
        
        # 如果没有匹配到规则，返回默认标签
        return {
            'stage_label': 'T1-试水',
            'when_to_use': '新上品牌、数据不足',
            'action_ad': '小预算；保留最高点击价上限；不追量',
            'action_data': '记录回传 EPC、CPC、订单；不下结论',
            'action_risk': '先应用全局否词库',
        }
    
    def _get_label_priority(self, label: str, priority_order: List[str]) -> int:
        """获取标签优先级（数字越小优先级越高）"""
        for i, prefix in enumerate(priority_order):
            if label.startswith(prefix):
                return i
        return len(priority_order)  # 未知标签优先级最低
    
    def _check_conditions(self, conditions: str, **kwargs) -> bool:
        """
        检查触发条件是否满足
        
        支持的格式：
        - 点击 < 100
        - 点击 ≥ 100
        - 保守EPC ≥ CPC×1.1
        - 点击 ≥ 200 且 保守EPC < CPC×0.7
        - 点击 ≥ 500 或 订单 ≥ 8
        """
        if not conditions or conditions.strip() == '':
            return False
        
        # 替换中文运算符
        conditions = conditions.replace('≥', '>=').replace('≤', '<=').replace('×', '*')
        
        # 替换变量名
        var_map = {
            '点击': 'clicks',
            'CPC': 'cpc',
            '订单': 'orders',
            '保守EPC': 'conservative_epc',
            '保守ROI': 'conservative_roi',
            '花费': 'cost',
        }
        
        for cn_var, en_var in var_map.items():
            conditions = conditions.replace(cn_var, en_var)
        
        # 处理"且"和"或"
        if ' 且 ' in conditions or ' and ' in conditions.lower():
            parts = re.split(r'\s+且\s+|\s+and\s+', conditions, flags=re.IGNORECASE)
            if not parts or len(parts) == 0:
                return False
            return all(self._evaluate_condition(part.strip(), **kwargs) for part in parts if part.strip())
        elif ' 或 ' in conditions or ' or ' in conditions.lower():
            parts = re.split(r'\s+或\s+|\s+or\s+', conditions, flags=re.IGNORECASE)
            if not parts or len(parts) == 0:
                return False
            return any(self._evaluate_condition(part.strip(), **kwargs) for part in parts if part.strip())
        else:
            return self._evaluate_condition(conditions, **kwargs)
    
    def _evaluate_condition(self, condition: str, **kwargs) -> bool:
        """评估单个条件"""
        try:
            # 处理范围条件，如 (0.9 ≤ 保守EPC/CPC ≤ 1.1)
            range_match = re.search(r'\(([\d.]+)\s*<=\s*([^/]+)/([^)]+)\s*<=\s*([\d.]+)\)', condition)
            if range_match:
                min_val = float(range_match.group(1))
                var1 = range_match.group(2).strip()
                var2 = range_match.group(3).strip()
                max_val = float(range_match.group(4))
                
                val1 = kwargs.get(var1, 0)
                val2 = kwargs.get(var2, 1)
                if val2 == 0:
                    return False
                ratio = val1 / val2
                return min_val <= ratio <= max_val
            
            # 处理比较条件，如 保守EPC ≥ CPC×1.1
            comparison_match = re.search(r'([a-z_]+)\s*(>=|<=|>|<)\s*([a-z_]+)\*([\d.]+)', condition)
            if comparison_match:
                var1 = comparison_match.group(1)
                op = comparison_match.group(2)
                var2 = comparison_match.group(3)
                multiplier = float(comparison_match.group(4))
                
                val1 = kwargs.get(var1, 0)
                val2 = kwargs.get(var2, 0) * multiplier
                
                if op == '>=':
                    return val1 >= val2
                elif op == '<=':
                    return val1 <= val2
                elif op == '>':
                    return val1 > val2
                elif op == '<':
                    return val1 < val2
            
            # 处理简单比较，如 点击 < 100
            simple_match = re.search(r'([a-z_]+)\s*(>=|<=|>|<)\s*([\d.]+)', condition)
            if simple_match:
                var = simple_match.group(1)
                op = simple_match.group(2)
                threshold = float(simple_match.group(3))
                
                val = kwargs.get(var, 0)
                
                if op == '>=':
                    return val >= threshold
                elif op == '<=':
                    return val <= threshold
                elif op == '>':
                    return val > threshold
                elif op == '<':
                    return val < threshold
            
            return False
            
        except Exception as e:
            logging.warning(f"评估条件失败: {condition}, 错误: {e}")
            return False
    
    def _get_default_rules(self) -> List[Dict]:
        """获取默认规则"""
        return [
            {
                'label': 'K1-关停（硬止损）',
                'when_to_use': '任何阶段触发即停',
                'trigger_conditions': '点击 >= 200 且 保守EPC < CPC*0.7；或 花费 >= 100 且 订单 == 0',
                'action_ad': '立即暂停并打 K1；记录原因',
                'action_data': '从观察/放量名单移除；进入"亏损复盘池"',
                'action_risk': '复盘触发原因（搜索词污染/竞争/异常）并更新否词',
            },
            {
                'label': 'T1-试水',
                'when_to_use': '新上品牌、数据不足',
                'trigger_conditions': '点击 < 100',
                'action_ad': '小预算；保留最高点击价上限；不追量',
                'action_data': '记录回传 EPC、CPC、订单；不下结论',
                'action_risk': '先应用全局否词库',
            },
            {
                'label': 'T2-观察',
                'when_to_use': '接近盈亏线、继续收样本',
                'trigger_conditions': '点击 >= 100 且 (0.9 <= 保守EPC/CPC <= 1.1)',
                'action_ad': '预算不变；保留上限；不放量',
                'action_data': '标记观察周期（7 天/14 天）；列入"接近盈亏线清单"',
                'action_risk': '每 2–3 天清理搜索词（优先花费最高 20%）',
            },
            {
                'label': 'P1-候选盈利',
                'when_to_use': '有盈利苗头、先验证稳定',
                'trigger_conditions': '订单 >= 3 且 保守EPC >= CPC*1.1；或 点击 >= 200 且 保守EPC >= CPC*1.2',
                'action_ad': '预算提高 2–3 倍；上限保留；持续观察',
                'action_data': '每日复核保守利润/点击；监控是否进入结论确立区',
                'action_risk': '加强搜索词清理；观察异常点击/CPC 波动',
            },
            {
                'label': 'S1-成熟放量',
                'when_to_use': '稳定赚钱、可以吃量占位',
                'trigger_conditions': '点击 >= 500 或 订单 >= 8，且 保守EPC >= CPC*1.2',
                'action_ad': '预算提高到 ¥100+（按天花板）；上限保留；追求稳定出现但不追 100% 极限覆盖',
                'action_data': '进入盈利榜单；每周复核扩量瓶颈（预算/排名）',
                'action_risk': '监控份额/竞争入场；异常一票暂停',
            },
        ]

