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
        # 哈基米模型名称需要带前缀，如 [福利]gemini-2.5-flash-lite
        self.model = model or "[福利]gemini-2.5-flash-lite"
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

## 1.4 附加链接 (Sitelinks) - 必须包含真实链接 URL！

**重要**：附加链接必须是网站上真实存在的页面 URL！请从网站导航栏、菜单中找到真实的分类页面链接。

| 附加链接标题 (≤25字符) | 真实页面 URL (完整链接) | 描述1 (≤28字符) | 描述2 (≤28字符) |
|---------------------|----------------------|----------------|----------------|
| [分类名1] | https://xxx.com/path1 | [描述] | [描述] |
| [分类名2] | https://xxx.com/path2 | [描述] | [描述] |
| [分类名3] | https://xxx.com/path3 | [描述] | [描述] |
| [分类名4] | https://xxx.com/path4 | [描述] | [描述] |
| [分类名5] | https://xxx.com/path5 | [描述] | [描述] |
| [分类名6] | https://xxx.com/path6 | [描述] | [描述] |

⚠️ **URL 必须真实存在**：请从网站的导航菜单、底部链接找到真实URL，不要编造！如果找不到6个，输出找到的即可。

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
        D. 获取热门节日和推荐商家（返回结构化JSON）
        
        Args:
            country: 国家代码（US/UK/DE/FR等）
            month: 月份（默认当月）
            year: 年份（默认今年）
        
        Returns:
            节日列表和商家推荐（JSON结构）
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
        
        prompt = f"""你是一位跨境电商营销专家。请提供{country_name}未来2个月（{year}年{month}月和{next_year}年{next_month}月）的营销日历信息。

今天是 {today.strftime('%Y-%m-%d')}，只返回今天及以后的节日，已过去的节日不要返回。

请严格按以下JSON格式返回，不要添加任何其他文字：
```json
{{
  "holidays": [
    {{
      "name_en": "Valentine's Day",
      "name_cn": "情人节",
      "date": "2026-02-14",
      "importance": "⭐⭐⭐⭐⭐",
      "meaning": "极其重要的电商节点，礼品销售高峰期",
      "categories": ["珠宝", "巧克力", "鲜花", "服装", "香水", "家居装饰"],
      "brands": ["Norma Kamali", "B&W/Polk"],
      "tips": "1月中下旬开始进入礼品搜索期，提前预热"
    }}
  ]
}}
```

字段说明：
- name_en: 英文名称
- name_cn: 中文名称  
- date: 日期格式 YYYY-MM-DD
- importance: 重要性（1-5个⭐）
- meaning: 对电商的营销意义（一句话）
- categories: 适用品类数组
- brands: 适用品牌示例数组
- tips: 简短营销建议

请按日期升序排列，返回8-15个节日/营销节点。只返回JSON，不要markdown代码块标记。"""

        try:
            response = self._call_api(prompt)
            
            # 尝试解析JSON
            try:
                # 清理响应：移除可能的markdown代码块标记
                clean_response = response.strip()
                if clean_response.startswith('```json'):
                    clean_response = clean_response[7:]
                if clean_response.startswith('```'):
                    clean_response = clean_response[3:]
                if clean_response.endswith('```'):
                    clean_response = clean_response[:-3]
                clean_response = clean_response.strip()
                
                data = json.loads(clean_response)
                holidays = data.get('holidays', [])
                
                # 过滤已过去的节日
                today_str = today.strftime('%Y-%m-%d')
                future_holidays = [h for h in holidays if h.get('date', '') >= today_str]
                
                return {
                    "success": True,
                    "holidays": future_holidays,
                    "country": country,
                    "country_name": country_name,
                    "current_month": f"{year}年{month}月",
                    "next_month": f"{next_year}年{next_month}月",
                    "today": today_str,
                    "timestamp": datetime.now().isoformat()
                }
            except json.JSONDecodeError as je:
                logger.warning(f"JSON解析失败，返回原始文本: {je}")
                # 如果解析失败，返回原始文本作为备用
                return {
                    "success": True,
                    "calendar": response,
                    "holidays": [],
                    "country": country,
                    "country_name": country_name,
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
    
    def analyze_l7d_campaigns(self, campaigns_data: List[Dict]) -> Dict:
        """
        L7D 广告系列审计分析
        
        基于品牌词套利审计提示词 v5 版本
        对广告系列进行全量审计与分级，输出可执行方案
        
        Args:
            campaigns_data: 广告系列数据列表，每个包含：
                - campaign_name: 系列名称
                - cost: L7D花费
                - clicks: L7D点击
                - impressions: L7D展示
                - cpc: 当前CPC
                - budget: 当前预算
                - conservative_epc: 保守EPC（已含0.72系数）
                - is_budget_lost: Budget丢失比例
                - is_rank_lost: Rank丢失比例
                - orders: L7D订单数
                - order_days: 出单天数
                - commission: 佣金
        
        Returns:
            完整审计报告
        """
        # 获取今天星期几
        today = datetime.now()
        weekday_names = ["周一", "周二", "周三", "周四", "周五", "周六", "周日"]
        weekday = today.weekday()
        weekday_name = weekday_names[weekday]
        is_analysis_day = weekday in [0, 2, 4]  # 周一、三、五
        
        # 转换数据为表格格式
        table_rows = []
        for c in campaigns_data:
            table_rows.append(f"| {c.get('campaign_name', '')} | {c.get('cost', 0)} | {c.get('clicks', 0)} | {c.get('impressions', 0)} | {c.get('cpc', 0)} | {c.get('budget', 0)} | {c.get('conservative_epc', 0)} | {c.get('is_budget_lost', 0)} | {c.get('is_rank_lost', 0)} | {c.get('orders', 0)} | {c.get('order_days', 0)} | {c.get('commission', 0)} |")
        
        table_header = "| 系列名 | L7D花费 | L7D点击 | L7D展示 | CPC | 预算 | 保守EPC | Budget丢失 | Rank丢失 | 订单 | 出单天数 | 佣金 |"
        table_divider = "|--------|---------|---------|---------|-----|------|---------|-----------|----------|------|---------|------|"
        table_data = "\n".join([table_header, table_divider] + table_rows)
        
        prompt = f"""# Google Ads 品牌词套利审计提示词（v5 强制完整版）

你是资深 Google Ads 品牌词直连套利操盘手。对表格中每个广告系列做全量审计与分级，输出可执行方案。

══════════════════════════════════════
【团队节奏】
══════════════════════════════════════
分析日：周一、三、五。根据今日自动判断是否分析日。
今日：{today.strftime('%Y-%m-%d')} {weekday_name}（{"✅ 分析日" if is_analysis_day else "⚠️ 非分析日"}）

══════════════════════════════════════
【口径】
══════════════════════════════════════
- 保守EPC/ROI 已含0.72系数，禁止重复乘
- L7D = D-1至D-8滚动累计
- 日均点击 = L7D点击 ÷ 7
- 红线CPC = 保守EPC × 0.7

══════════════════════════════════════
【样本量判定】
══════════════════════════════════════
| 日均点击 | 判定 | 约束 |
|---------|------|------|
| < 10 | 🔴 | 禁判D（除非EPC=0） |
| 10-25 | 🟡 | 禁判S |
| > 25 | 🟢 | 正常判定 |

══════════════════════════════════════
【瓶颈判定】
══════════════════════════════════════
- Budget瓶颈：Budget丢失 ≥ 40% 且 > Rank丢失
- Rank瓶颈：Rank丢失 ≥ 40% 且 > Budget丢失
- 混合：两者都 ≥ 40%
- 正常：两者都 < 40%

══════════════════════════════════════
【分级规则】
══════════════════════════════════════
▶ S级：必须同时满足
  ① ROI ≥ 3.0  ② 不倒挂  ③ 出单天数 ≥ 5  ④ 样本🟢
  任一不满足 → B级

▶ D级：满足任一
  ① ROI ≤ 0 且 样本🟢
  ② 倒挂幅度 ≥ 0.05 且 ROI < 1.0 且 样本🟢
  ③ L7D点击 ≥ 100 且 出单 = 0
  ④ 保守EPC = 0

▶ B级：不满足S也不触发D

══════════════════════════════════════
【动作规则】
══════════════════════════════════════
预算上限：默认+30%；S级且Budget丢失>60%时允许+100%

▶ S级：Budget丢失>60%预算×2.0，40-60%预算×1.3，Rank丢失>60%加CPC至红线×0.9
▶ B级：倒挂→降CPC至红线；样本🔴🟡→预算×1.3
▶ D级：立即PAUSE
▶ 周五：S级额外+20%

══════════════════════════════════════
【效果预测公式（必算）】
══════════════════════════════════════
预期日点击 = 新预算 ÷ 新CPC
预期ROI = (保守EPC - 新CPC) ÷ 新CPC

方案可行性判定：
- 预期日点击 > 25 → ✅可达🟢
- 预期日点击 ≤ 25 → ⚠️无法达🟢
- 若无法达🟢：最低达标预算 = 26 × 新CPC

══════════════════════════════════════
【输出格式】
══════════════════════════════════════

A) 节奏面板
📅 今日：YYYY-MM-DD 周X（✅/⚠️）| 上次：周X | 下次：周X

B) 概览
总系列：X | S级：X | B级：X | D级：X

C) 审计总表
| # | 系列名 | 级别 | 日均点击 | 样本 | 红线 | MaxCPC | 倒挂 | ROI | 瓶颈 | 预期日点击 | 可行性 |

══════════════════════════════════════
D) 逐系列完整分析
══════════════════════════════════════
【强制要求】：
1. 必须对输入表格中的【每一个系列】单独输出
2. 必须按下方模板输出【全部字段】，缺一不可
3. S/B/D 三种级别使用【同一模板】，字段完全相同
4. 禁止使用"核心示例""典型""其余类似"等省略表述
5. 禁止合并多个系列
6. D级系列也必须输出完整字段（动作固定为PAUSE）

【统一模板 - 每个系列必须包含以下全部10行】：
---
【系列名称】
级别：S / B / D
检验：ROI=X.XX[✓/✗] | 不倒挂[✓/✗] | 出单≥5[✓/✗] | 样本🟢[✓/✗] → [4✓=S / 否则B / 触发D规则=D]
D级检查：①ROI≤0且🟢[是/否] ②倒挂≥0.05且ROI<1且🟢[是/否] ③点击≥100且出单=0[是/否] ④EPC=0[是/否] → 触发：[无/规则X]
诊断：日均X.X(🔴/🟡/🟢) | 红线$X.XX | 倒挂幅度$X.XX | Budget丢失X%/Rank丢失X% → [瓶颈类型]
动作：CPC $X.XX→$X.XX | 预算 $X.XX→$X.XX(+X%) | [S/B/D特定动作说明]
效果：预期日点击=$X.XX÷$X.XX=X.X | 可行性[✅可达🟢/⚠️仅🟡/❌仍🔴] | 若⚠️❌:达🟢需$X.XX,缺口$X.XX | 预期ROI:X.XX→X.XX
验证：MM-DD周X | 届时预期状态 | 检查项 | 未达标处置
升降：升级条件 | 降级触发 | 维持观察点
---

E) 执行清单
| 优先级 | 系列 | 动作 | 操作 | 预期效果 | 可行性 | 验证日 |
| 🔴 | xxx | 暂停 | PAUSE | 止损 | - | - |
| 🟡 | xxx | 调价 | CPC X→X | ROI X→X | ✅ | MM-DD |
| 🟢 | xxx | 加预算 | $X→$X | 日点击X→X | ⚠️ | MM-DD |

F) 专项名单
1. 潜力股：[系列] - 原因
2. 吸血鬼：[系列] - 触发规则X
3. 样本不足：[系列] - 可行性[✅/⚠️]，若⚠️达🟢需$X.XX
4. 受限系列：[系列] - 需X次+30%调整达🟢

G) 综述
关键发现 | 下次重点 | [周五]周末策略

══════════════════════════════════════
【自检清单】
══════════════════════════════════════
输出前必须逐条确认：
□ 1. 输出系列数 = 输入系列数（写出：X = X）
□ 2. 每个系列都有完整10行（逐个确认）
□ 3. S级全满足4条件
□ 4. 所有MaxCPC ≤ 红线
□ 5. 预算调整 ≤ 上限
□ 6. D级都标明触发规则
□ 7. B级都有升降条件
□ 8. 倒挂≥0.05且ROI<1且🟢都判D
□ 9. 每个系列都有效果预测
□ 10. ⚠️❌系列都标注达🟢所需预算

══════════════════════════════════════
【禁止事项】
══════════════════════════════════════
❌ 省略任何系列
❌ 使用"核心示例""典型分析""其余类似""统一处理"等表述
❌ D级系列简化输出（必须输出完整字段）
❌ 合并多个系列到一个分析块
❌ MaxCPC > 红线
❌ 样本🔴判D（除非EPC=0）
❌ 样本🟡判S
❌ 预算超限
❌ 效果预测缺失
❌ ⚠️❌系列不标注达🟢所需预算
❌ 验证窗口无依据

══════════════════════════════════════
【完整性最终确认】
══════════════════════════════════════
输出结束前，必须写：
"✅ 完整性确认：共输入X个系列，已全部输出X个系列，无省略。"

若输出数 ≠ 输入数，必须补全后再输出确认。

══════════════════════════════════════
待审计的广告系列数据：
══════════════════════════════════════
{table_data}

请开始审计。"""

        try:
            analysis = self._call_api(prompt)
            return {
                "success": True,
                "analysis": analysis,
                "campaign_count": len(campaigns_data),
                "analysis_date": today.strftime('%Y-%m-%d'),
                "weekday": weekday_name,
                "is_analysis_day": is_analysis_day,
                "timestamp": datetime.now().isoformat()
            }
        except Exception as e:
            logger.error(f"L7D 分析失败: {e}")
            return {"success": False, "message": str(e)}
    
    def generate_operation_report(self, campaigns_data: List[Dict], custom_prompt: str = None) -> Dict:
        """
        生成专业广告分析报告
        
        包含阶段评价、市场洞察、数据深度分析、节日营销预判和优化建议
        
        Args:
            campaigns_data: 广告系列数据
            custom_prompt: 用户自定义提示词（可选）
        
        Returns:
            专业分析报告
        """
        today = datetime.now()
        weekday_names = ["周一", "周二", "周三", "周四", "周五", "周六", "周日"]
        weekday_name = weekday_names[today.weekday()]
        
        # 转换数据为详细表格格式
        table_rows = []
        for c in campaigns_data:
            # 计算关键指标
            cost = c.get('cost', 0) or 0
            clicks = c.get('clicks', 0) or 0
            impressions = c.get('impressions', 0) or 0
            commission = c.get('commission', 0) or 0
            conservative_commission = commission * 0.72
            roi = (conservative_commission - cost) / cost if cost > 0 else 0
            ctr = (clicks / impressions * 100) if impressions > 0 else 0
            epc = conservative_commission / clicks if clicks > 0 else 0
            
            table_rows.append(
                f"| {c.get('campaign_name', '')} | "
                f"${cost:.2f} | ${c.get('budget', 0):.2f} | ${c.get('cpc', 0):.4f} | "
                f"{clicks} | {impressions} | {ctr:.2f}% | "
                f"{c.get('orders', 0)} | {c.get('order_days', 0)}/7天 | "
                f"${commission:.2f} | ${epc:.4f} | {roi*100:.1f}% | "
                f"{c.get('is_budget_lost', 0)*100:.0f}% | {c.get('is_rank_lost', 0)*100:.0f}% |"
            )
        
        table_header = "| 系列名 | L7D花费 | 预算 | CPC | 点击 | 展示 | CTR | 订单 | 出单天数 | 佣金 | EPC | ROI | Budget丢失 | Rank丢失 |"
        table_divider = "|--------|---------|------|-----|------|------|-----|------|---------|------|-----|-----|-----------|----------|"
        table_data = "\n".join([table_header, table_divider] + table_rows)
        
        # 默认提示词 - 专业广告分析报告
        default_prompt = """你是一位拥有10年以上经验的跨境电商 Google Ads 投放专家，精通品牌词套利策略。请对以下广告系列数据进行深度分析，生成一份专业的广告投放分析报告。

## 报告结构要求

对于每个广告系列，请输出以下内容：

### 📊 [广告系列名称]

#### 1. 阶段评价
分析该广告系列目前处于什么阶段：
- 🌱 冷启动期（数据不足，需要观察）
- 📈 成长期（数据向好，值得投入）
- 🏆 成熟期（稳定盈利，优化细节）
- 📉 衰退期（效果下滑，需要调整）

总结过去7天的整体表现。

#### 2. 市场洞察
- 从系列名称解析商家信息和投放国家
- 分析该商家在投放国家的市场竞争情况
- 评估同类品牌词的竞价强度

#### 3. 数据深度分析
- **CPC 分析**: 当前CPC是否合理？与EPC对比如何？是否存在倒挂风险？
- **费用效率**: L7D花费与产出比是否健康？
- **点击率趋势**: CTR表现如何？是否需要优化广告素材？
- **转化情况**: 订单数和出单天数说明了什么？
- **ROI 健康度**: ROI是否达标？与行业基准对比如何？
- **流量瓶颈**: Budget丢失和Rank丢失分别说明什么问题？

#### 4. 节日营销预判
- 该投放国家未来2-4周是否有重要节日？
- 是否需要提前调整预算布局？
- 头图/广告素材是否需要节日化优化？

#### 5. 优化建议
- **推荐预算**: $XX（说明调整原因）
- **推荐CPC**: $X.XX（说明定价逻辑，如红线CPC计算）
- **其他建议**: 关键词优化、广告素材、投放时段等

#### 6. 风险提示
- 需要关注的潜在风险
- 建议监控的关键指标
- 触发预警的条件

---

## 分析规则参考

- 保守EPC = 佣金 × 0.72 ÷ 点击数
- 保守ROI = (保守佣金 - 花费) ÷ 花费
- 红线CPC = 保守EPC × 0.7（CPC不应超过此值）
- 日均点击 = L7D点击 ÷ 7
- Budget瓶颈: Budget丢失 ≥ 40% 说明预算不足
- Rank瓶颈: Rank丢失 ≥ 40% 说明出价不够

## 输出要求

1. 使用专业、详实的语言
2. 每个分析点要有数据支撑
3. 建议要具体可执行
4. 不要输出简单的操作指令表格"""

        prompt_text = custom_prompt if custom_prompt and custom_prompt.strip() else default_prompt
        
        full_prompt = f"""{prompt_text}

══════════════════════════════════════
【今日日期】{today.strftime('%Y-%m-%d')} {weekday_name}
【广告系列数量】{len(campaigns_data)} 个
══════════════════════════════════════

【广告系列详细数据】
{table_data}

请开始生成专业分析报告。"""

        try:
            analysis = self._call_api(full_prompt)
            return {
                "success": True,
                "analysis": analysis,
                "campaign_count": len(campaigns_data),
                "analysis_date": today.strftime('%Y-%m-%d'),
                "timestamp": datetime.now().isoformat()
            }
        except Exception as e:
            logger.error(f"生成专业分析报告失败: {e}")
            return {"success": False, "message": str(e)}

