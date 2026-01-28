"""
分析表模板服务
读取分析表模板，解析计算公式和规则，生成处理动作建议
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


class AnalysisTemplateService:
    """分析表模板服务类"""
    
    def __init__(self):
        # 兼容相对路径：统一以“项目根目录”为基准解析（repo_root/excel/分析表.xlsx）
        raw_path = Path(settings.ANALYSIS_TEMPLATE_FILE)
        if raw_path.is_absolute():
            self.template_path = raw_path
        else:
            # __file__ = backend/app/services/analysis_template_service.py
            # parents[3] = repo root (D:\Google Analysis)
            repo_root = Path(__file__).resolve().parents[3]
            self.template_path = repo_root / raw_path
        self.rules = None
        self.formulas = None
        self.column_structure = None
    
    def load_template(self) -> Dict:
        """
        加载分析表模板
        
        返回:
            包含规则、公式和列结构的字典
        """
        if not PANDAS_AVAILABLE:
            return {"error": "pandas未安装"}
        
        if not self.template_path.exists():
            # 如果模板文件不存在，使用默认规则，并写回实例属性（避免后续出现“规则列表为空”）
            default = self._get_default_rules()
            self.rules = default.get("rules") or []
            self.formulas = default.get("formulas") or {}
            self.column_structure = default.get("column_structure") or []
            return default
        
        try:
            # 读取Excel文件，尝试检测标题行
            df = self._read_template_with_header_detection()
            
            # 解析列结构（第一行通常是列名）
            column_structure = self._parse_column_structure(df)
            
            # 解析规则和公式
            rules = self._parse_rules(df)
            formulas = self._parse_formulas(df)
            
            self.rules = rules
            self.formulas = formulas
            self.column_structure = column_structure
            
            return {
                "rules": rules,
                "formulas": formulas,
                "column_structure": column_structure,
                "status": "loaded"
            }
        except Exception as e:
            # 如果读取失败，使用默认规则
            import logging
            logging.warning(f"读取分析表模板失败: {str(e)}，将使用默认规则。模板路径={self.template_path}")
            default = self._get_default_rules()
            self.rules = default.get("rules") or []
            self.formulas = default.get("formulas") or {}
            self.column_structure = default.get("column_structure") or []
            return default
    
    def _read_template_with_header_detection(self) -> pd.DataFrame:
        """
        读取分析表模板并检测标题行
        """
        # 尝试不同的header行
        for header_row in range(3):
            try:
                df = pd.read_excel(self.template_path, engine='openpyxl', header=header_row, nrows=20)
                # 检查是否有有效的列名（不是Unnamed）
                unnamed_count = sum(1 for col in df.columns if str(col).startswith('Unnamed'))
                if unnamed_count < len(df.columns) * 0.5:
                    return df
            except:
                continue
        
        # 如果都失败，使用header=None
        return pd.read_excel(self.template_path, engine='openpyxl', header=None, nrows=20)
    
    def _parse_column_structure(self, df: pd.DataFrame) -> List[str]:
        """
        解析分析表的列结构
        
        返回:
            列名列表（按顺序）
        """
        columns = []
        # 获取第一行作为列名（如果header=None，第一行就是列名）
        if len(df) > 0:
            # 尝试从第一行获取列名
            first_row = df.iloc[0]
            for val in first_row:
                if pd.notna(val):
                    col_str = str(val).strip()
                    if col_str and not col_str.startswith('Unnamed'):
                        columns.append(col_str)
        
        # 如果第一行没有有效列名，使用DataFrame的列名
        if not columns:
            for col in df.columns:
                col_str = str(col).strip()
                if col_str and not col_str.startswith('Unnamed'):
                    columns.append(col_str)
        
        return columns
    
    def _parse_rules(self, df: pd.DataFrame) -> List[Dict]:
        """
        解析规则行
        
        规则格式示例：
        - <100 暂停
        - 200-500 加预算
        - >500 维持不变
        """
        rules = []
        
        # 查找包含规则的行（通常包含"暂停"、"加预算"、"维持不变"等关键词）
        for idx, row in df.iterrows():
            row_str = ' '.join([str(cell) for cell in row if pd.notna(cell)])
            
            # 检查是否包含动作关键词
            if any(keyword in row_str for keyword in ['暂停', '加预算', '维持不变', '暂停', '增加', '保持']):
                # 尝试解析规则
                rule = self._parse_rule_line(row_str)
                if rule:
                    rules.append(rule)
        
        # 如果没有找到规则，使用默认规则
        if not rules:
            return self._get_default_rules()["rules"]
        
        return rules
    
    def _parse_rule_line(self, line: str) -> Optional[Dict]:
        """
        解析单行规则
        
        示例：
        - "<100 暂停" -> {"condition": "<100", "action": "暂停"}
        - "200-500 加预算" -> {"condition": "200-500", "action": "加预算"}
        """
        line = str(line).strip()
        
        # 定义动作关键词映射
        action_keywords = {
            '暂停': 'pause',
            '加预算': 'increase_budget',
            '增加预算': 'increase_budget',
            '维持不变': 'maintain',
            '保持': 'maintain',
            '维持': 'maintain'
        }
        
        # 查找动作
        action = None
        action_cn = None
        for keyword, action_code in action_keywords.items():
            if keyword in line:
                action = action_code
                action_cn = keyword
                break
        
        if not action:
            return None
        
        # 提取条件（通常是数字范围）
        import re
        # 匹配数字范围：<100, >500, 200-500等
        condition_match = re.search(r'([<>]?\d+[-]?\d*)', line)
        if condition_match:
            condition = condition_match.group(1)
        else:
            condition = None
        
        return {
            "condition": condition,
            "action": action,
            "action_cn": action_cn,
            "description": line
        }
    
    def _parse_formulas(self, df: pd.DataFrame) -> Dict:
        """
        解析计算公式
        
        查找包含公式的行，如"保守佣金*0.72"
        """
        formulas = {}
        
        for idx, row in df.iterrows():
            row_str = ' '.join([str(cell) for cell in row if pd.notna(cell)])
            
            # 查找公式（包含*、/、+、-等运算符）
            if any(op in row_str for op in ['*', '/', '+', '-', '=']):
                # 尝试提取公式
                formula = self._extract_formula(row_str)
                if formula:
                    formulas.update(formula)
        
        # 如果没有找到公式，使用默认公式
        if not formulas:
            return self._get_default_rules()["formulas"]
        
        return formulas
    
    def _extract_formula(self, line: str) -> Optional[Dict]:
        """
        提取公式
        
        示例：
        - "保守佣金*0.72" -> {"保守佣金": "保守佣金*0.72"}
        """
        import re
        formulas = {}
        
        # 匹配常见的公式模式
        # 保守佣金*0.72
        pattern = r'(\w+)\s*[*]\s*([\d.]+)'
        matches = re.findall(pattern, line)
        for field, multiplier in matches:
            formulas[field] = f"{field}*{multiplier}"
        
        return formulas if formulas else None
    
    def _get_default_rules(self) -> Dict:
        """
        获取默认规则（当模板文件不存在或无法读取时使用）
        """
        return {
            "rules": [
                {
                    "condition": "<100",
                    "action": "pause",
                    "action_cn": "暂停",
                    "description": "保守ROI < 100% 暂停"
                },
                {
                    "condition": "100-200",
                    "action": "maintain",
                    "action_cn": "维持不变",
                    "description": "保守ROI 100%-200% 维持不变"
                },
                {
                    "condition": "200-500",
                    "action": "increase_budget",
                    "action_cn": "加预算",
                    "description": "保守ROI 200%-500% 加预算"
                },
                {
                    "condition": ">500",
                    "action": "maintain",
                    "action_cn": "维持不变",
                    "description": "保守ROI > 500% 维持不变"
                }
            ],
            "formulas": {
                "保守佣金": "保守佣金*0.72"
            },
            "column_structure": [],  # 默认无列结构，将使用数据中的列顺序
            "status": "default"
        }
    
    def get_action_for_roi(self, roi: Optional[float]) -> Dict:
        """
        根据保守ROI值获取处理动作
        
        参数:
            roi: 保守ROI值（百分比）
        
        返回:
            包含动作信息的字典
        """
        if not self.rules:
            self.load_template()
        
        if roi is None or pd.isna(roi):
            return {
                "action": "maintain",
                "action_cn": "维持不变",
                "reason": "ROI数据缺失"
            }
        
        # 处理特殊情况：ROI为-100通常表示点击为0或数据不匹配
        if roi <= -99:
            return {
                "action": "pause",
                "action_cn": "暂停",
                "reason": "点击数据为0或数据不匹配，建议暂停"
            }
        
        # 确保rules不为None且是列表
        if not self.rules or not isinstance(self.rules, list) or len(self.rules) == 0:
            return {
                "action": "maintain",
                "action_cn": "维持不变",
                "reason": "规则列表为空"
            }
        
        # 应用规则（按优先级排序，从大到小）
        # 先按条件值排序，确保更具体的规则先匹配
        try:
            sorted_rules = sorted(
                self.rules,
                key=lambda r: self._get_condition_priority(r.get("condition", "")),
                reverse=True
            )
        except Exception as e:
            import logging
            logging.warning(f"排序规则失败: {e}，使用原始规则顺序")
            sorted_rules = self.rules
        
        for rule in sorted_rules:
            if self._check_condition(roi, rule.get("condition")):
                return {
                    "action": rule.get("action", "maintain"),
                    "action_cn": rule.get("action_cn", "维持不变"),
                    "reason": rule.get("description", "")
                }
        
        # 默认动作
        return {
            "action": "maintain",
            "action_cn": "维持不变",
            "reason": "未匹配到规则"
        }
    
    def _get_condition_priority(self, condition: str) -> float:
        """
        获取条件的优先级（用于排序）
        数值范围越具体，优先级越高
        """
        if not condition:
            return 0
        
        # 范围条件（如200-500）优先级更高
        if '-' in condition:
            return 100
        # 大于条件
        elif condition.startswith('>'):
            return 50
        # 小于条件
        elif condition.startswith('<'):
            return 30
        
        return 0
    
    def _check_condition(self, value: float, condition: Optional[str]) -> bool:
        """
        检查值是否满足条件
        
        参数:
            value: 要检查的值
            condition: 条件字符串，如"<100", "200-500", ">500"
        
        返回:
            是否满足条件
        """
        if not condition:
            return False
        
        condition = str(condition).strip()
        
        try:
            # <100
            if condition.startswith('<'):
                threshold = float(condition[1:].strip())
                return value < threshold
            
            # >500
            if condition.startswith('>'):
                threshold = float(condition[1:].strip())
                return value > threshold
            
            # <=100 或 >=500
            if condition.startswith('<='):
                threshold = float(condition[2:].strip())
                return value <= threshold
            
            if condition.startswith('>='):
                threshold = float(condition[2:].strip())
                return value >= threshold
            
            # 200-500
            if '-' in condition:
                parts = condition.split('-')
                if len(parts) == 2:
                    min_val = float(parts[0].strip())
                    max_val = float(parts[1].strip())
                    return min_val <= value <= max_val
        except (ValueError, TypeError):
            return False
        
        return False
    
    def apply_formulas(self, data: Dict) -> Dict:
        """
        应用公式到数据
        
        参数:
            data: 包含字段的字典
        
        返回:
            应用公式后的数据
        """
        if not self.formulas:
            self.load_template()
        
        result = data.copy()
        
        for field, formula in self.formulas.items():
            if field in result:
                try:
                    # 简单的公式计算（仅支持乘法）
                    if '*' in formula:
                        parts = formula.split('*')
                        if len(parts) == 2:
                            field_name = parts[0].strip()
                            multiplier = float(parts[1].strip())
                            if field_name in result:
                                result[field] = result[field_name] * multiplier
                except:
                    pass
        
        return result

