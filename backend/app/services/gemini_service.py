"""
Gemini AI 服务
提供广告分析、优化建议、节日营销等AI功能
支持官方API和哈基米等中转API（OpenAI兼容格式）
"""
import logging
from typing import Optional, List, Dict
from datetime import date, datetime
import json
import requests

logger = logging.getLogger(__name__)

# Gemini API 配置
GEMINI_API_KEY = None
GEMINI_BASE_URL = None
GEMINI_MODEL = "gemini-2.5-flash-lite"


class GeminiService:
    """Gemini AI 服务类
    
    支持哈基米等中转API（OpenAI兼容格式）
    """
    
    def __init__(self, api_key: Optional[str] = None, base_url: Optional[str] = None, model: Optional[str] = None):
        self.api_key = api_key
        self.base_url = base_url or "https://api.gemai.cc"
        self.model = model or "gemini-2.5-flash-lite"
        logger.info(f"Gemini API 配置: base_url={self.base_url}, model={self.model}")
    
    def _call_api(self, prompt: str, image_data: bytes = None) -> str:
        """调用哈基米 API（OpenAI兼容格式）"""
        headers = {
            "Authorization": f"Bearer {self.api_key}",
            "Content-Type": "application/json"
        }
        
        # 构建消息
        if image_data:
            # 图片分析请求
            import base64
            image_base64 = base64.b64encode(image_data).decode('utf-8')
            messages = [{
                "role": "user",
                "content": [
                    {"type": "text", "text": prompt},
                    {"type": "image_url", "image_url": {"url": f"data:image/png;base64,{image_base64}"}}
                ]
            }]
        else:
            # 纯文本请求
            messages = [{"role": "user", "content": prompt}]
        
        payload = {
            "model": self.model,
            "messages": messages,
            "max_tokens": 8192
        }
        
        # 调用 API（哈基米使用 OpenAI 兼容格式）
        # base_url 应该是 https://api.gemai.cc（不带 /v1beta）
        base = self.base_url.rstrip('/')
        if base.endswith('/v1beta'):
            base = base[:-7]  # 移除 /v1beta
        if base.endswith('/v1'):
            base = base[:-3]  # 移除 /v1
        url = f"{base}/v1/chat/completions"
        response = requests.post(url, headers=headers, json=payload, timeout=120)
        
        if response.status_code != 200:
            error_msg = response.text
            logger.error(f"API 调用失败: {response.status_code} - {error_msg}")
            raise Exception(f"API 调用失败: {error_msg}")
        
        result = response.json()
        return result["choices"][0]["message"]["content"]
    
    def analyze_campaign_data(self, campaign_data: Dict) -> Dict:
        """
        A. 分析广告数据，生成优化建议
        
        Args:
            campaign_data: 广告系列数据，包含cost, clicks, impressions, cpc, roi等
        
        Returns:
            分析结果和优化建议
        """
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
            analysis = self._call_api(prompt)
            return {
                "success": True,
                "analysis": analysis,
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
            instructions = self._call_api(prompt)
            return {
                "success": True,
                "instructions": instructions,
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
        
        prompt = f"""你是一位谷歌广告投放专家，特别擅长关键词筛选和广告文案撰写。

**最重要规则**：真实、严谨！所有折扣和物流信息必须从URL中查找真实证据，不能编造！

**产品链接**：{product_url}
**输入关键词**：{', '.join(keywords)}
**目标国家**：{config['name']} ({target_country})
**广告语言**：{config['lang']} ({config['lang_code']})

---

## 1.1 网站主营业务

请访问链接，分析并输出：
1. **该网站主营业务**：这个网站主要卖什么产品/服务？
2. **真实折扣信息**：网站上实际存在的折扣（如无则标注"未找到"）
3. **真实物流信息**：该网站对{config['name']}的配送政策（如无则标注"未找到"）
4. **合规检查**：核查广告词是否会触发谷歌广告政策中心提醒（如涉及敏感词、夸大宣传等）

---

## 1.2 关键词推荐（共8个）

根据网站主营业务，推荐8个高意向关键词。

**推荐关键词格式**（可直接复制到 Google Ads）：
```
[关键词1]
[关键词2]
[关键词3]
"关键词4"
"关键词5"
关键词6
关键词7
关键词8
```

**匹配类型说明**：
- `[完全匹配]`：锁定品牌忠实用户，防止预算被其他品牌词蹭走
- `"词组匹配"`：捕捉 "buy xxx" "best xxx" 等高质量长尾流量
- `广泛匹配`：扩大覆盖范围

**关键词选择依据**：
| # | 关键词 | 推荐匹配类型 | 选择理由 |
|---|--------|-------------|---------|
| 1 | [关键词1] | 完全匹配 | 品牌词/核心词 |
| 2 | [关键词2] | 完全匹配 | ... |
| 3 | [关键词3] | 完全匹配 | ... |
| 4 | "关键词4" | 词组匹配 | 高购买意向 |
| 5 | "关键词5" | 词组匹配 | ... |
| 6 | 关键词6 | 广泛匹配 | 扩大覆盖 |
| 7 | 关键词7 | 广泛匹配 | ... |
| 8 | 关键词8 | 广泛匹配 | ... |

💡 提示：可在 sem.3ue.co 输入域名验证这些关键词的搜索量和竞争度

---

## 1.3 广告文案 (Ad Copy)

### Ad Headlines (广告标题 - 每行 ≤ 25 字符)

前三条已按您的要求锁定：品牌定位、最高折扣、物流信息。

| # | English Headline (Copy & Paste) | 中文翻译 | 字符数 |
|---|--------------------------------|---------|-------|
| 1 | [品牌相关标题] | [翻译] | XX |
| 2 | [折扣标题-从网站找到的真实折扣] | [翻译] | XX |
| 3 | [物流标题-从网站找到的真实物流] | [翻译] | XX |
| 4 | [标题4] | [翻译] | XX |
| ... | ... | ... | ... |
| 17 | [标题17] | [翻译] | XX |

### Ad Descriptions (广告描述 - 50 至 80 字符)

第一条描述包含主力折扣与{config['name']}免邮信息。

| # | English Description (Copy & Paste) | 中文翻译 | 字符数 |
|---|-----------------------------------|---------|-------|
| 1 | [描述1-含折扣和物流] | [翻译] | XX |
| 2 | [描述2] | [翻译] | XX |
| 3 | [描述3] | [翻译] | XX |
| 4 | [描述4] | [翻译] | XX |
| 5 | [描述5] | [翻译] | XX |
| 6 | [描述6] | [翻译] | XX |

---

## 1.4 附加链接描述 (Sitelink Descriptions - ≤ 28 字符)

基于网站真实页面：

| 附加链接小标题 | 第一条描述 (Line 1) | 第二条描述 (Line 2) |
|--------------|-------------------|-------------------|
| [分类1] | [描述] | [描述] |
| [分类2] | [描述] | [描述] |
| [分类3] | [描述] | [描述] |
| [分类4] | [描述] | [描述] |
| [分类5] | [描述] | [描述] |
| [分类6] | [描述] | [描述] |

---

## 1.5 投放建议

预算：4{config['currency']} / Max CPC：0.3{config['currency']}
建议使用 Manual CPC (手动出价) 并仅针对 {config['name']} 投放。

---

## 1.6 Google Ads 政策合规检查

请核查以上所有广告文案：
1. 是否会触发谷歌广告政策中心提醒？
2. 是否涉及敏感词、夸大宣传、虚假承诺？
3. 是否符合 Google Ads 平台规范？

如有问题，请标注并给出修改建议。

⚠️ 如果网站没有折扣或免运费信息，请在对应位置标注"未找到"，不要编造！"""

        try:
            recommendations = self._call_api(prompt)
            return {
                "success": True,
                "recommendations": recommendations,
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
            calendar = self._call_api(prompt)
            return {
                "success": True,
                "calendar": calendar,
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
        try:
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
            
            analysis = self._call_api(prompt, image_data)
            
            return {
                "success": True,
                "analysis": analysis,
                "timestamp": datetime.now().isoformat()
            }
        except Exception as e:
            logger.error(f"分析图片失败: {e}")
            return {"success": False, "message": str(e)}

