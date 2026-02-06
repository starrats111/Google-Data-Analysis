"""
Gemini AI 服务
提供广告分析、优化建议、节日营销等AI功能
"""
import logging
from typing import Optional, List, Dict
from datetime import date, datetime
import json

logger = logging.getLogger(__name__)

# Gemini API 配置
GEMINI_API_KEY = None

def configure_gemini(api_key: str):
    """配置 Gemini API 密钥"""
    global GEMINI_API_KEY
    GEMINI_API_KEY = api_key
    try:
        import google.generativeai as genai
        genai.configure(api_key=api_key)
        logger.info("Gemini API 配置成功")
        return True
    except Exception as e:
        logger.error(f"Gemini API 配置失败: {e}")
        return False


def get_model():
    """获取 Gemini 模型"""
    try:
        import google.generativeai as genai
        return genai.GenerativeModel('gemini-1.5-flash')
    except Exception as e:
        logger.error(f"获取 Gemini 模型失败: {e}")
        return None


class GeminiService:
    """Gemini AI 服务类"""
    
    def __init__(self, api_key: Optional[str] = None):
        if api_key:
            configure_gemini(api_key)
        self.model = get_model()
    
    def analyze_campaign_data(self, campaign_data: Dict) -> Dict:
        """
        A. 分析广告数据，生成优化建议
        
        Args:
            campaign_data: 广告系列数据，包含cost, clicks, impressions, cpc, roi等
        
        Returns:
            分析结果和优化建议
        """
        if not self.model:
            return {"success": False, "message": "Gemini 模型未配置"}
        
        prompt = f"""你是一位资深的Google Ads广告优化专家。请分析以下广告数据并提供详细的优化建议。

广告数据：
{json.dumps(campaign_data, ensure_ascii=False, indent=2)}

请从以下几个维度进行分析：
1. **数据概览**：总结关键指标表现
2. **问题诊断**：识别数据中的问题（如ROI过低、CPC过高、IS丢失严重等）
3. **优化建议**：针对每个问题给出具体的操作建议
4. **优先级排序**：将建议按重要性和紧急程度排序
5. **预期效果**：预估优化后的效果提升

请用中文回答，格式清晰易读。"""

        try:
            response = self.model.generate_content(prompt)
            return {
                "success": True,
                "analysis": response.text,
                "timestamp": datetime.now().isoformat()
            }
        except Exception as e:
            logger.error(f"分析广告数据失败: {e}")
            return {"success": False, "message": str(e)}
    
    def generate_operation_instruction(self, campaign_data: Dict) -> Dict:
        """
        B. 智能生成操作指令
        
        Args:
            campaign_data: 广告系列数据
        
        Returns:
            操作指令列表
        """
        if not self.model:
            return {"success": False, "message": "Gemini 模型未配置"}
        
        prompt = f"""你是一位Google Ads操作专家。根据以下广告数据，生成具体的操作指令。

广告数据：
{json.dumps(campaign_data, ensure_ascii=False, indent=2)}

请生成清晰、可执行的操作指令，格式如下：
1. 【操作类型】具体操作内容
   - 原因：为什么要这样做
   - 预期效果：预计带来的改善

操作类型包括：加预算、降预算、提CPC、降CPC、暂停、开启、观察、优化等。

请只输出最重要的3-5条操作指令，按优先级排序。用中文回答。"""

        try:
            response = self.model.generate_content(prompt)
            return {
                "success": True,
                "instructions": response.text,
                "timestamp": datetime.now().isoformat()
            }
        except Exception as e:
            logger.error(f"生成操作指令失败: {e}")
            return {"success": False, "message": str(e)}
    
    def analyze_keywords_and_recommend(
        self, 
        keywords: List[str], 
        product_url: Optional[str] = None,
        target_country: str = "US"
    ) -> Dict:
        """
        C. 根据关键词生成推荐预算、CPC和广告词
        
        Args:
            keywords: 关键词列表
            product_url: 产品链接（可选）
            target_country: 目标国家
        
        Returns:
            推荐配置和广告词
        """
        if not self.model:
            return {"success": False, "message": "Gemini 模型未配置"}
        
        prompt = f"""你是一位Google Ads广告策划专家。请根据以下信息生成广告投放建议。

关键词：{', '.join(keywords)}
目标国家：{target_country}
{'产品链接：' + product_url if product_url else ''}

请提供以下建议：

1. **推荐预算**
   - 日预算范围（美元）
   - 预算分配建议

2. **推荐CPC**
   - 建议Max CPC范围（美元）
   - 不同关键词的CPC建议

3. **广告词建议**
   - 标题（3个选项，每个30字符以内）
   - 描述（2个选项，每个90字符以内）
   - 行动号召语

4. **投放建议**
   - 最佳投放时段
   - 设备定向建议
   - 受众定向建议

请用中文回答，预算和CPC用美元。"""

        try:
            response = self.model.generate_content(prompt)
            return {
                "success": True,
                "recommendations": response.text,
                "keywords": keywords,
                "target_country": target_country,
                "timestamp": datetime.now().isoformat()
            }
        except Exception as e:
            logger.error(f"生成推荐配置失败: {e}")
            return {"success": False, "message": str(e)}
    
    def get_marketing_calendar(
        self, 
        country: str = "US",
        month: Optional[int] = None,
        year: Optional[int] = None
    ) -> Dict:
        """
        D. 获取热门节日和推荐商家
        
        Args:
            country: 国家代码（US/UK/DE/FR等）
            month: 月份（默认当月）
            year: 年份（默认今年）
        
        Returns:
            节日列表和商家推荐
        """
        if not self.model:
            return {"success": False, "message": "Gemini 模型未配置"}
        
        today = date.today()
        if not month:
            month = today.month
        if not year:
            year = today.year
        
        # 下个月
        next_month = month + 1 if month < 12 else 1
        next_year = year if month < 12 else year + 1
        
        country_names = {
            "US": "美国", "UK": "英国", "DE": "德国", "FR": "法国",
            "ES": "西班牙", "IT": "意大利", "AU": "澳大利亚", "CA": "加拿大",
            "JP": "日本", "KR": "韩国"
        }
        country_name = country_names.get(country, country)
        
        prompt = f"""你是一位跨境电商营销专家。请提供{country_name}的营销日历信息。

请列出以下内容：

## {year}年{month}月 - {country_name}热门节日/营销节点

对于每个节日，请提供：
- **节日名称**（英文+中文）
- **日期**：具体日期
- **营销意义**：这个节日对电商的意义
- **适用品牌/品类**：哪些类型的商家适合在这个节日营销
- **营销建议**：简短的营销策略建议

## {next_year}年{next_month}月 - {country_name}热门节日/营销节点

（同样格式）

请按日期顺序排列，重点标注对电商最重要的节日。用中文回答。"""

        try:
            response = self.model.generate_content(prompt)
            return {
                "success": True,
                "calendar": response.text,
                "country": country,
                "current_month": f"{year}年{month}月",
                "next_month": f"{next_year}年{next_month}月",
                "timestamp": datetime.now().isoformat()
            }
        except Exception as e:
            logger.error(f"获取营销日历失败: {e}")
            return {"success": False, "message": str(e)}
    
    def analyze_image(self, image_data: bytes, prompt: str = None) -> Dict:
        """
        分析图片（如关键词截图）
        
        Args:
            image_data: 图片二进制数据
            prompt: 分析提示词
        
        Returns:
            图片分析结果
        """
        if not self.model:
            return {"success": False, "message": "Gemini 模型未配置"}
        
        try:
            import google.generativeai as genai
            import PIL.Image
            import io
            
            # 使用支持多模态的模型
            vision_model = genai.GenerativeModel('gemini-1.5-flash')
            
            # 将bytes转为PIL Image
            image = PIL.Image.open(io.BytesIO(image_data))
            
            if not prompt:
                prompt = """请分析这张截图中的关键词数据，提取以下信息：
1. 关键词列表
2. 搜索量数据
3. 竞争程度
4. CPC参考值

然后基于这些数据，给出：
- 推荐投放的关键词
- 建议的Max CPC范围
- 日预算建议"""
            
            response = vision_model.generate_content([prompt, image])
            
            return {
                "success": True,
                "analysis": response.text,
                "timestamp": datetime.now().isoformat()
            }
        except Exception as e:
            logger.error(f"分析图片失败: {e}")
            return {"success": False, "message": str(e)}

