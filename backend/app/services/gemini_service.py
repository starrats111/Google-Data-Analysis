"""
Gemini AI 服务
提供广告分析、优化建议、节日营销等AI功能
支持官方API和哈基米等中转API
"""
import logging
from typing import Optional, List, Dict
from datetime import date, datetime
import json

logger = logging.getLogger(__name__)

# Gemini API 配置
GEMINI_API_KEY = None
GEMINI_BASE_URL = None
GEMINI_MODEL = "gemini-2.0-flash"

def configure_gemini(api_key: str, base_url: str = None, model: str = None):
    """配置 Gemini API
    
    Args:
        api_key: API密钥
        base_url: API基础地址（留空使用官方，填写中转地址如 https://burn.hair/v1beta）
        model: 模型名称（默认 gemini-2.0-flash）
    """
    global GEMINI_API_KEY, GEMINI_BASE_URL, GEMINI_MODEL
    GEMINI_API_KEY = api_key
    GEMINI_BASE_URL = base_url
    if model:
        GEMINI_MODEL = model
    
    try:
        import google.generativeai as genai
        
        # 配置API密钥
        if base_url:
            # 使用中转API（如哈基米）
            from google.generativeai import configure
            # 设置自定义端点
            genai.configure(api_key=api_key, transport='rest')
            # 注意：google-generativeai 库需要通过环境变量设置自定义URL
            import os
            os.environ['GOOGLE_API_BASE_URL'] = base_url
            logger.info(f"Gemini API 配置成功 (中转: {base_url}, 模型: {GEMINI_MODEL})")
        else:
            # 使用官方API
            genai.configure(api_key=api_key)
            logger.info(f"Gemini API 配置成功 (官方, 模型: {GEMINI_MODEL})")
        
        return True
    except Exception as e:
        logger.error(f"Gemini API 配置失败: {e}")
        return False


def get_model(model_name: str = None):
    """获取 Gemini 模型"""
    try:
        import google.generativeai as genai
        name = model_name or GEMINI_MODEL
        return genai.GenerativeModel(name)
    except Exception as e:
        logger.error(f"获取 Gemini 模型失败: {e}")
        return None


class GeminiService:
    """Gemini AI 服务类
    
    支持官方API和哈基米等中转API
    """
    
    def __init__(self, api_key: Optional[str] = None, base_url: Optional[str] = None, model: Optional[str] = None):
        if api_key:
            configure_gemini(api_key, base_url, model)
        self.model = get_model(model)
    
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
            product_url: 产品链接（必须提供，用于抓取真实折扣和物流信息）
            target_country: 目标国家
        
        Returns:
            推荐配置和广告词
        """
        if not self.model:
            return {"success": False, "message": "Gemini 模型未配置"}
        
        if not product_url:
            return {"success": False, "message": "请提供产品链接URL，用于获取真实的折扣和物流信息"}
        
        # 国家配置：语言、货币
        country_config = {
            "US": {"lang": "英语", "lang_code": "English", "currency": "USD", "name": "美国"},
            "UK": {"lang": "英语", "lang_code": "English", "currency": "GBP", "name": "英国"},
            "DE": {"lang": "德语", "lang_code": "German", "currency": "EUR", "name": "德国"},
            "FR": {"lang": "法语", "lang_code": "French", "currency": "EUR", "name": "法国"},
            "ES": {"lang": "西班牙语", "lang_code": "Spanish", "currency": "EUR", "name": "西班牙"},
            "IT": {"lang": "意大利语", "lang_code": "Italian", "currency": "EUR", "name": "意大利"},
            "AU": {"lang": "英语", "lang_code": "English", "currency": "AUD", "name": "澳大利亚"},
            "CA": {"lang": "英语", "lang_code": "English", "currency": "CAD", "name": "加拿大"},
            "JP": {"lang": "日语", "lang_code": "Japanese", "currency": "JPY", "name": "日本"},
            "KR": {"lang": "韩语", "lang_code": "Korean", "currency": "KRW", "name": "韩国"},
        }
        
        config = country_config.get(target_country, country_config["US"])
        
        prompt = f"""你是一位谷歌广告投放专家，特别擅长关键词筛选和广告文案撰写，对谷歌搜索广告各种指标及作用了如指掌。

**最最最重要的规则**：真实、严谨、不误导消费者！所有折扣和物流信息必须从我提供的URL中查找真实存在的证据，绝对不能编造！

---

## 前置任务：访问并分析产品链接

**产品链接**：{product_url}

请先访问该链接，仔细查找并提取以下真实信息：

1. **网站主营业务**：该网站是卖什么的？
2. **真实折扣信息**：
   - 网站上实际存在的折扣（如 20% OFF, Buy 1 Get 1 等）
   - 优惠码（如果有）
   - 促销活动（如果有）
   - ⚠️ 如果网站没有折扣，就不要在广告中提及折扣！
3. **真实物流信息**：
   - 该网站对{config['name']}的配送政策
   - 是否免运费？运费多少？
   - 配送时间
   - ⚠️ 如果找不到物流信息，就不要编造！
4. **站内链接**：网站的主要分类/页面

---

## 第一步：关键词筛选与基础配置

**输入关键词**：{', '.join(keywords)}
**目标国家**：{config['name']} ({target_country})
**广告语言**：{config['lang']} ({config['lang_code']})

1. **筛选关键词**（输出可直接复制的格式）
2. **推荐预算**：日预算 4{config['currency']}
3. **推荐CPC**：Max CPC 0.3{config['currency']}
4. **核查**：确认广告词不会触发谷歌广告政策中心提醒

---

## 第二步：生成广告标题和描述

**广告标题要求**（共17条）：
- 字数：每条不超过25个字符（含标点和空格）
- 第1条：包含**真实的**折扣信息（从网站找到的，优选最大折扣）
- 第2条：包含**真实的**物流信息（针对{config['name']}，从网站找到的）
- 第3条起：其他吸引顾客的标题
- 第4条起：可包含次要折扣（必须真实存在）
- 语言：用{config['lang_code']}输出，每条后面用中文翻译
- 避免过多大写字符
- ⚠️ 如果网站没有折扣/免运费，不要在标题中提及！

**广告描述要求**（共6条）：
- 字数：每条50-80个字符（含空格和标点），绝对不少于50个字符
- 其中1条包含**真实的**折扣+物流信息（仅当网站确实有时）
- 语言：用{config['lang_code']}输出，每条后面用中文翻译
- 具有品牌特色，符合Google Ads规范

---

## 第三步：附加链接（基于网站真实页面）

根据网站的**真实站内链接**生成6条，每条：
- 链接标题：不超过25字符
- 链接描述：2条，每条不超过28字符
- ⚠️ 必须是网站上真实存在的页面/分类！

---

**输出格式要求**：
1. 首先列出从网站找到的真实信息（折扣、物流、分类）
2. 标题和描述单独列行，醒目清晰
3. 每条后标注字符数
4. 生成后核实字数是否符合标准
5. ⚠️ 如果某些信息在网站上找不到，明确标注"未找到"，不要编造！"""

        try:
            response = self.model.generate_content(prompt)
            return {
                "success": True,
                "recommendations": response.text,
                "keywords": keywords,
                "product_url": product_url,
                "target_country": target_country,
                "country_name": config['name'],
                "language": config['lang'],
                "currency": config['currency'],
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
            vision_model = genai.GenerativeModel(GEMINI_MODEL)
            
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

