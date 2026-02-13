"""
Claude API 服务 - 支持 Tool Use 的网页分析和内容生成
"""
import httpx
import json
import re
import logging
from typing import Dict, List, Any, Optional
from anthropic import Anthropic

logger = logging.getLogger(__name__)


class ClaudeService:
    """Claude API 服务，支持 Tool Use"""
    
    # 哈基米代理 base_url
    HAGIMI_BASE_URL = "https://api.gemai.cc"
    # 默认模型
    DEFAULT_MODEL = "[特价B]claude-sonnet-4-20250514"
    DEFAULT_FALLBACK_MODEL = "[特价B]claude-opus-4-5-20251101"
    
    def __init__(self, api_key: str, base_url: str = None, model: str = None, fallback_model: str = None):
        self.model = model or self.DEFAULT_MODEL
        self.fallback_model = fallback_model or self.DEFAULT_FALLBACK_MODEL
        self.current_model = self.model  # 当前使用的模型
        
        # 存储最后一次 Playwright 提取的图片数据（含 base64）
        self._last_playwright_images: List[Dict] = []
        
        # 如果是哈基米的 API Key（以 sk- 开头），使用哈基米代理
        if api_key.startswith("sk-"):
            base_url = base_url or self.HAGIMI_BASE_URL
            # 移除末尾的 /v1，Anthropic SDK 会自动添加正确的路径
            if base_url.endswith("/v1"):
                base_url = base_url[:-3]
            self.client = Anthropic(api_key=api_key, base_url=base_url)
            logger.info(f"[Claude] 使用哈基米代理: {base_url}, 主模型: {self.model}, 备用: {self.fallback_model}")
        else:
            self.client = Anthropic(api_key=api_key)
            logger.info(f"[Claude] 使用 Anthropic 官方 API, 模型: {self.model}")
        self.tools = self._define_tools()
    
    def _call_api_with_fallback(self, **kwargs):
        """调用 API，主模型失败时自动切换到备用模型"""
        # 尝试主模型
        try:
            kwargs['model'] = self.model
            response = self.client.messages.create(**kwargs)
            self.current_model = self.model
            return response
        except Exception as e:
            error_msg = str(e)
            # 检查是否是模型不可用的错误
            if "无权访问" in error_msg or "forbidden" in error_msg.lower() or "not allowed" in error_msg.lower():
                logger.warning(f"[Claude] 主模型 {self.model} 不可用，切换到备用模型: {self.fallback_model}")
                try:
                    kwargs['model'] = self.fallback_model
                    response = self.client.messages.create(**kwargs)
                    self.current_model = self.fallback_model
                    logger.info(f"[Claude] 使用备用模型成功: {self.fallback_model}")
                    return response
                except Exception as fallback_error:
                    logger.error(f"[Claude] 备用模型也失败: {fallback_error}")
                    raise fallback_error
            else:
                raise e
    
    def _define_tools(self) -> List[Dict]:
        """定义可用的工具"""
        return [
            {
                "name": "fetch_webpage",
                "description": "获取指定URL的网页HTML内容，用于分析商家网站",
                "input_schema": {
                    "type": "object",
                    "properties": {
                        "url": {
                            "type": "string",
                            "description": "要获取的网页URL"
                        }
                    },
                    "required": ["url"]
                }
            },
            {
                "name": "fetch_image_info",
                "description": "获取图片的元信息（尺寸、格式等）",
                "input_schema": {
                    "type": "object",
                    "properties": {
                        "url": {
                            "type": "string",
                            "description": "图片URL"
                        }
                    },
                    "required": ["url"]
                }
            }
        ]
    
    async def analyze_merchant_url(self, url: str) -> Dict[str, Any]:
        """
        分析商家URL，提取品牌信息和图片
        
        Args:
            url: 商家网站URL
            
        Returns:
            包含品牌信息和图片的字典
        """
        logger.info(f"[Claude] 开始分析商家URL: {url}")
        
        messages = [{
            "role": "user",
            "content": f"""请分析以下商家网站，提取品牌信息和产品图片。

**分析步骤：**
1. 获取商家网站首页
2. 在网页末尾查找 <!-- EXTRACTED_IMAGES: [...] --> 注释，这里包含已通过浏览器渲染提取的图片列表（JSON格式）
3. 从 EXTRACTED_IMAGES 中选择最适合做博客配图的图片

**图片选择标准：**
- 优先选择：尺寸大于 300x300 的产品图、场景图、生活方式图
- 排除：logo、图标、小于200px的缩略图、按钮图片、社交媒体图标
- 第一张设为 hero（主图），其余为 content（内容图）

**需要提取的信息：**
1. 品牌名称 (brand_name)
2. 品牌描述（简短，brand_description）  
3. 主营产品类型 (product_type)
4. 当前促销活动或热门产品 (promotions)
5. 5张高质量图片（优先从 EXTRACTED_IMAGES 中选择大尺寸图片）
6. 为每张图片生成英文 alt 描述

商家网址: {url}

**返回JSON格式：**
{{
  "brand_name": "品牌名称",
  "brand_description": "品牌简短描述",
  "product_type": "产品类型",
  "promotions": ["促销活动1", "促销活动2"],
  "products": [
    {{"name": "产品名", "price": "$XX.XX", "description": "描述"}}
  ],
  "images": [
    {{"url": "完整图片URL", "type": "hero", "alt": "英文描述"}},
    {{"url": "完整图片URL", "type": "content", "alt": "英文描述"}},
    {{"url": "完整图片URL", "type": "content", "alt": "英文描述"}},
    {{"url": "完整图片URL", "type": "content", "alt": "英文描述"}},
    {{"url": "完整图片URL", "type": "content", "alt": "英文描述"}}
  ],
  "category_suggestion": "建议分类代码"
}}

重要：必须返回至少1张图片，尽可能返回5张高质量产品图片。"""
        }]
        
        try:
            response = self._call_api_with_fallback(
                max_tokens=4096,
                tools=self.tools,
                messages=messages
            )
            
            # 处理工具调用循环
            while response.stop_reason == "tool_use":
                tool_results = []
                
                for content in response.content:
                    if content.type == "tool_use":
                        logger.info(f"[Claude] 调用工具: {content.name}")
                        result = await self._execute_tool(content.name, content.input)
                        tool_results.append({
                            "type": "tool_result",
                            "tool_use_id": content.id,
                            "content": result if isinstance(result, str) else json.dumps(result)
                        })
                
                # 继续对话
                messages.append({"role": "assistant", "content": response.content})
                messages.append({"role": "user", "content": tool_results})
                
                # 后续调用使用当前已确定可用的模型
                response = self.client.messages.create(
                    model=self.current_model,
                    max_tokens=4096,
                    tools=self.tools,
                    messages=messages
                )
            
            # 解析最终结果
            for content in response.content:
                if hasattr(content, 'text'):
                    result = self._parse_json_response(content.text)
                    
                    # 关键：将 Claude 选择的图片与 Playwright 提取的 Base64 数据合并
                    result = self._merge_images_with_base64(result)
                    
                    logger.info(f"[Claude] 分析完成: {result.get('brand_name', 'Unknown')} (使用模型: {self.current_model})")
                    return result
            
            raise Exception("分析失败：无法获取结果")
            
        except Exception as e:
            logger.error(f"[Claude] 分析失败: {e}")
            raise
    
    async def generate_article(
        self,
        merchant_data: Dict[str, Any],
        tracking_link: str,
        keyword_count: int,
        prompt_template: str,
        images: Optional[List[Dict]] = None,
        target_country: str = "US",
        target_language: str = "en-US",
        target_country_name: str = "美国"
    ) -> Dict[str, Any]:
        """
        生成文章内容
        
        Args:
            merchant_data: 商家数据（来自 analyze_merchant_url）
            tracking_link: 追踪链接
            keyword_count: 关键词出现次数
            prompt_template: 提示词模板
            images: 图片列表（可选，覆盖 merchant_data 中的图片）
            target_country: 目标国家代码
            target_language: 目标语言代码
            target_country_name: 目标国家名称
            
        Returns:
            生成的文章数据
        """
        logger.info(f"[Claude] 开始生成文章: {merchant_data.get('brand_name', 'Unknown')} (目标: {target_country}/{target_language})")
        
        # 使用提供的图片或 merchant_data 中的图片
        article_images = images or merchant_data.get('images', [])
        
        # 获取语言本地化指令
        localization_instruction = self._get_localization_instruction(target_country, target_language, target_country_name)
        
        # 构建提示词
        prompt = prompt_template
        prompt = prompt.replace("[商家信息]", json.dumps(merchant_data, ensure_ascii=False, indent=2))
        prompt = prompt.replace("[品牌名称]", merchant_data.get('brand_name', ''))
        prompt = prompt.replace("[追踪链接]", tracking_link)
        prompt = prompt.replace("[关键词次数]", str(keyword_count))
        prompt = prompt.replace("[图片列表]", json.dumps(article_images, ensure_ascii=False))
        prompt = prompt.replace("[目标国家]", target_country_name)
        prompt = prompt.replace("[目标语言]", target_language)
        prompt = prompt.replace("[本地化指令]", localization_instruction)
        
        # 如果模板没有包含本地化占位符，在末尾追加本地化指令
        if "[本地化指令]" not in prompt_template and "[目标语言]" not in prompt_template:
            prompt = f"{prompt}\n\n## 重要：本地化要求\n{localization_instruction}"
        
        try:
            response = self._call_api_with_fallback(
                max_tokens=8192,
                messages=[{"role": "user", "content": prompt}]
            )
            
            for content in response.content:
                if hasattr(content, 'text'):
                    result = self._parse_json_response(content.text)
                    # 添加图片信息
                    result['images'] = self._format_images(article_images)
                    logger.info(f"[Claude] 文章生成完成: {result.get('title', 'Untitled')} (使用模型: {self.current_model})")
                    return result
            
            raise Exception("生成失败")
            
        except Exception as e:
            logger.error(f"[Claude] 文章生成失败: {e}")
            raise
    
    async def regenerate_section(
        self,
        current_content: str,
        section: str,
        instructions: str,
        merchant_data: Dict[str, Any]
    ) -> str:
        """
        重新生成文章的某个部分
        
        Args:
            current_content: 当前内容
            section: 要重新生成的部分（title/excerpt/content）
            instructions: 修改指令
            merchant_data: 商家数据
            
        Returns:
            重新生成的内容
        """
        prompt = f"""请根据以下指令修改文章的 {section} 部分：

## 当前内容
{current_content}

## 商家信息
{json.dumps(merchant_data, ensure_ascii=False, indent=2)}

## 修改指令
{instructions}

请只返回修改后的 {section} 内容，不需要其他解释。"""
        
        try:
            response = self._call_api_with_fallback(
                max_tokens=4096,
                messages=[{"role": "user", "content": prompt}]
            )
            
            for content in response.content:
                if hasattr(content, 'text'):
                    return content.text.strip()
            
            return current_content
            
        except Exception as e:
            logger.error(f"[Claude] 重新生成失败: {e}")
            raise
    
    def _get_localization_instruction(self, country: str, language: str, country_name: str) -> str:
        """
        获取本地化指令，根据目标国家生成对应的语言和文化风格要求
        """
        # 语言-国家映射和本地化指导
        localization_guides = {
            "en-US": {
                "language": "American English",
                "instruction": """
- Write in American English with natural, conversational tone
- Use American spelling (color, favorite, organize)
- Include American cultural references and idioms where appropriate
- Use USD ($) for prices
- Date format: MM/DD/YYYY
- Measurements: feet, inches, pounds, Fahrenheit
- Shopping terms: cart, checkout, shipping
"""
            },
            "en-GB": {
                "language": "British English",
                "instruction": """
- Write in British English with proper Queen's English conventions
- Use British spelling (colour, favourite, organise)
- Include British cultural references
- Use GBP (£) for prices
- Date format: DD/MM/YYYY
- Measurements: metres, centimetres, kilograms, Celsius
- Shopping terms: basket, checkout, delivery
"""
            },
            "en-CA": {
                "language": "Canadian English",
                "instruction": """
- Write in Canadian English
- Mix of British and American spelling (colour but organize)
- Include Canadian cultural references
- Use CAD ($) for prices
- Date format: YYYY-MM-DD or DD/MM/YYYY
- Measurements: metric system (metres, kilograms, Celsius)
"""
            },
            "en-AU": {
                "language": "Australian English",
                "instruction": """
- Write in Australian English
- Use British spelling conventions
- Include Australian slang and cultural references where appropriate
- Use AUD ($) for prices
- Date format: DD/MM/YYYY
- Measurements: metric system
"""
            },
            "de": {
                "language": "German (Deutsch)",
                "instruction": """
- Schreiben Sie auf Deutsch in einem professionellen, aber freundlichen Ton
- Verwenden Sie korrekte deutsche Grammatik und Rechtschreibung
- Verwenden Sie EUR (€) für Preise
- Datumsformat: DD.MM.YYYY
- Verwenden Sie das metrische System
- Formelle Anrede ("Sie") für den Leser
- Berücksichtigen Sie deutsche Verbrauchergewohnheiten
"""
            },
            "fr": {
                "language": "French (Français)",
                "instruction": """
- Rédigez en français avec un ton élégant et engageant
- Utilisez une grammaire et une orthographe françaises correctes
- Utilisez EUR (€) pour les prix
- Format de date: DD/MM/YYYY
- Utilisez le système métrique
- Vouvoiement pour le lecteur
- Tenez compte des préférences culturelles françaises
"""
            },
            "es": {
                "language": "Spanish (Español - Spain)",
                "instruction": """
- Escriba en español de España con tono profesional y cercano
- Use gramática y ortografía españolas correctas
- Use EUR (€) para precios
- Formato de fecha: DD/MM/YYYY
- Use el sistema métrico
- Tuteo o usted según el contexto
- Considere las preferencias culturales españolas
"""
            },
            "es-MX": {
                "language": "Spanish (Español - Mexico)",
                "instruction": """
- Escriba en español mexicano con tono amigable y accesible
- Use vocabulario y expresiones mexicanas
- Use MXN ($) para precios
- Formato de fecha: DD/MM/YYYY
- Use el sistema métrico
- Considere las preferencias culturales mexicanas
"""
            },
            "it": {
                "language": "Italian (Italiano)",
                "instruction": """
- Scrivete in italiano con tono elegante e coinvolgente
- Usate grammatica e ortografia italiane corrette
- Usate EUR (€) per i prezzi
- Formato data: DD/MM/YYYY
- Usate il sistema metrico
- Considerate le preferenze culturali italiane
"""
            },
            "ja": {
                "language": "Japanese (日本語)",
                "instruction": """
- 日本語で丁寧で親しみやすいトーンで書いてください
- 正しい日本語の文法と敬語を使用してください
- 価格には円（¥）を使用してください
- 日付形式：YYYY年MM月DD日
- メートル法を使用してください
- 日本の消費者の好みと文化的な配慮を含めてください
- 適切な敬語レベルを維持してください
"""
            },
            "ko": {
                "language": "Korean (한국어)",
                "instruction": """
- 한국어로 친근하고 전문적인 어조로 작성해 주세요
- 올바른 한국어 문법과 맞춤법을 사용하세요
- 가격에는 원(₩)을 사용하세요
- 날짜 형식: YYYY년 MM월 DD일
- 미터법을 사용하세요
- 한국 소비자의 취향과 문화적 고려사항을 포함하세요
- 적절한 존댓말을 사용하세요
"""
            },
            "pt-BR": {
                "language": "Portuguese (Português - Brazil)",
                "instruction": """
- Escreva em português brasileiro com tom amigável e acessível
- Use gramática e ortografia brasileiras
- Use BRL (R$) para preços
- Formato de data: DD/MM/YYYY
- Use o sistema métrico
- Considere as preferências culturais brasileiras
- Use "você" para se dirigir ao leitor
"""
            },
            "nl": {
                "language": "Dutch (Nederlands)",
                "instruction": """
- Schrijf in het Nederlands met een professionele maar toegankelijke toon
- Gebruik correcte Nederlandse grammatica en spelling
- Gebruik EUR (€) voor prijzen
- Datumformaat: DD-MM-YYYY
- Gebruik het metrische stelsel
- Houd rekening met Nederlandse consumentenvoorkeuren
"""
            },
            "pl": {
                "language": "Polish (Polski)",
                "instruction": """
- Pisz po polsku w profesjonalnym, ale przyjaznym tonie
- Używaj poprawnej polskiej gramatyki i ortografii
- Używaj PLN (zł) dla cen
- Format daty: DD.MM.YYYY
- Używaj systemu metrycznego
- Uwzględnij polskie preferencje kulturowe
"""
            },
            "sv": {
                "language": "Swedish (Svenska)",
                "instruction": """
- Skriv på svenska med en professionell men vänlig ton
- Använd korrekt svensk grammatik och stavning
- Använd SEK (kr) för priser
- Datumformat: YYYY-MM-DD
- Använd metriska systemet
- Ta hänsyn till svenska konsumentpreferenser
"""
            },
        }
        
        # 获取对应的本地化指南
        guide = localization_guides.get(language, localization_guides.get(language.split('-')[0], None))
        
        if guide:
            return f"""
**Target Language:** {guide['language']}
**Target Country:** {country_name}

**Localization Requirements:**
{guide['instruction']}

**IMPORTANT:** The entire article (title, excerpt, content, category names) MUST be written in {guide['language']}. 
Do NOT write in English if the target language is not English.
Ensure the writing style feels natural to native speakers of {country_name}.
"""
        else:
            # 默认英语
            return f"""
**Target Language:** English
**Target Country:** {country_name}

Write the article in natural English appropriate for {country_name} readers.
"""

    async def _execute_tool(self, tool_name: str, tool_input: Dict) -> str:
        """执行工具调用"""
        
        if tool_name == "fetch_webpage":
            return await self._fetch_webpage(tool_input["url"])
        elif tool_name == "fetch_image_info":
            return await self._fetch_image_info(tool_input["url"])
        else:
            return f"未知工具: {tool_name}"
    
    async def _fetch_webpage(self, url: str) -> str:
        """获取网页内容（使用 Playwright 渲染 JavaScript）"""
        try:
            # 尝试使用 Playwright 渲染
            html = await self._fetch_with_playwright(url)
            if html:
                return html
        except Exception as e:
            logger.warning(f"[Claude] Playwright 渲染失败，降级到 httpx: {e}")
        
        # 降级到 httpx（静态获取）
        try:
            async with httpx.AsyncClient(timeout=15.0) as client:
                response = await client.get(
                    url,
                    headers={
                        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"
                    },
                    follow_redirects=True
                )
                response.raise_for_status()
                html = response.text
                if len(html) > 50000:
                    logger.warning(f"[Claude] 网页内容过长，截断至 50000 字符")
                    html = html[:50000]
                return html
        except httpx.TimeoutException:
            logger.warning(f"[Claude] 获取网页超时: {url}")
            return "Error: 请求超时，请稍后重试"
        except httpx.HTTPStatusError as e:
            logger.warning(f"[Claude] HTTP错误: {e.response.status_code}")
            return f"Error: HTTP {e.response.status_code}"
        except Exception as e:
            logger.error(f"[Claude] 获取网页失败: {e}")
            return f"Error: {str(e)}"
    
    async def _fetch_with_playwright(self, url: str) -> str:
        """使用 Playwright 渲染网页并提取内容"""
        try:
            from playwright.async_api import async_playwright
        except ImportError:
            logger.warning("[Claude] Playwright 未安装，跳过 JS 渲染")
            return None
        
        logger.info(f"[Claude] 使用 Playwright 渲染: {url}")
        
        async with async_playwright() as p:
            browser = await p.chromium.launch(headless=True)
            try:
                context = await browser.new_context(
                    user_agent="Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"
                )
                page = await context.new_page()
                
                # 访问页面，使用 domcontentloaded 更快完成（不等待所有网络请求）
                await page.goto(url, wait_until="domcontentloaded", timeout=60000)
                
                # 等待页面稳定
                await page.wait_for_load_state("load", timeout=30000)
                
                # 等待图片加载
                await page.wait_for_timeout(2000)
                
                # 滚动页面以触发懒加载
                await page.evaluate("""
                    async () => {
                        for (let i = 0; i < 5; i++) {
                            window.scrollBy(0, window.innerHeight);
                            await new Promise(r => setTimeout(r, 300));
                        }
                        window.scrollTo(0, 0);
                    }
                """)
                
                # 等待图片加载
                await page.wait_for_timeout(2000)
                
                # 提取所有图片 URL 信息
                image_urls = await page.evaluate("""
                    () => {
                        const imgElements = Array.from(document.querySelectorAll('img'));
                        
                        // 过滤有效图片（大于 50x50 像素，排除小图标）
                        const validImgs = imgElements.filter(img => {
                            const src = img.src || img.dataset.src || img.dataset.lazySrc || '';
                            if (!src || !src.startsWith('http') || src.includes('data:')) return false;
                            const w = img.naturalWidth || img.width || 0;
                            const h = img.naturalHeight || img.height || 0;
                            return w >= 50 && h >= 50;
                        });
                        
                        // 按图片面积排序，取最大的 8 张
                        validImgs.sort((a, b) => {
                            const areaA = (a.naturalWidth || a.width || 0) * (a.naturalHeight || a.height || 0);
                            const areaB = (b.naturalWidth || b.width || 0) * (b.naturalHeight || b.height || 0);
                            return areaB - areaA;
                        });
                        
                        return validImgs.slice(0, 8).map(img => ({
                            url: img.src || img.dataset.src || img.dataset.lazySrc || '',
                            alt: img.alt || '',
                            width: img.naturalWidth || img.width || 0,
                            height: img.naturalHeight || img.height || 0
                        }));
                    }
                """)
                
                # 使用 Playwright 的 page.goto 方式下载每张图片并转为 Base64
                images_data = []
                for img_info in image_urls[:8]:
                    try:
                        img_url = img_info['url']
                        # 使用 Playwright 请求图片（自动带上正确的 Cookie 和 Referer）
                        response = await page.request.get(img_url, timeout=10000)
                        if response.ok:
                            img_bytes = await response.body()
                            if len(img_bytes) > 1000:  # 至少 1KB
                                import base64
                                # 检测图片类型
                                content_type = response.headers.get('content-type', 'image/jpeg')
                                if 'png' in content_type:
                                    mime = 'image/png'
                                elif 'gif' in content_type:
                                    mime = 'image/gif'
                                elif 'webp' in content_type:
                                    mime = 'image/webp'
                                else:
                                    mime = 'image/jpeg'
                                
                                b64_str = base64.b64encode(img_bytes).decode('utf-8')
                                images_data.append({
                                    'url': img_url,
                                    'src': img_url,
                                    'base64': f'data:{mime};base64,{b64_str}',
                                    'alt': img_info['alt'],
                                    'width': img_info['width'],
                                    'height': img_info['height']
                                })
                                logger.info(f"[Claude] 图片下载成功: {img_url[:50]}... ({len(img_bytes)} bytes)")
                    except Exception as e:
                        logger.warning(f"[Claude] 图片下载失败: {img_info['url'][:50]}... - {e}")
                        continue
                
                logger.info(f"[Claude] 共成功转换 {len(images_data)} 张图片为 Base64")
                
                # 保存图片数据到实例变量，供后续使用
                self._last_playwright_images = images_data
                
                # 获取页面 HTML
                html = await page.content()
                
                # 将图片信息（不含 base64，避免内容过长）附加到 HTML 末尾，便于 Claude 分析
                if images_data:
                    # Claude 只需要 url, alt, width, height 来选择图片
                    images_for_claude = [{
                        'url': img['url'],
                        'alt': img.get('alt', ''),
                        'width': img.get('width', 0),
                        'height': img.get('height', 0)
                    } for img in images_data]
                    images_json = json.dumps(images_for_claude, ensure_ascii=False)
                    html += f"\n<!-- EXTRACTED_IMAGES: {images_json} -->"
                    logger.info(f"[Claude] Playwright 提取到 {len(images_data)} 张图片")
                
                # 限制长度
                if len(html) > 80000:
                    logger.warning(f"[Claude] 网页内容过长，截断至 80000 字符")
                    html = html[:80000]
                
                return html
                
            finally:
                await browser.close()
    
    async def _fetch_image_info(self, url: str) -> Dict[str, Any]:
        """获取图片信息"""
        try:
            async with httpx.AsyncClient(timeout=10.0) as client:
                response = await client.head(url, follow_redirects=True)
                return {
                    "url": url,
                    "status": "valid" if response.is_success else "invalid",
                    "content_type": response.headers.get("content-type", ""),
                    "content_length": response.headers.get("content-length", "0")
                }
        except Exception as e:
            return {"url": url, "status": "error", "error": str(e)}
    
    def _parse_json_response(self, text: str) -> Dict:
        """解析 JSON 响应"""
        # 尝试从 markdown 代码块中提取
        json_match = re.search(r'```json\s*([\s\S]*?)\s*```', text)
        if json_match:
            try:
                return json.loads(json_match.group(1))
            except json.JSONDecodeError:
                pass
        
        # 尝试直接解析
        json_match = re.search(r'\{[\s\S]*\}', text)
        if json_match:
            try:
                return json.loads(json_match.group(0))
            except json.JSONDecodeError:
                pass
        
        raise Exception("无法解析 JSON 响应")
    
    def _normalize_url(self, url: str) -> str:
        """
        规范化 URL，用于模糊匹配
        - 移除协议前缀
        - 移除查询参数
        - 移除末尾斜杠
        - 转小写
        """
        if not url:
            return ''
        # 移除协议
        normalized = url.replace('https://', '').replace('http://', '')
        # 移除查询参数
        if '?' in normalized:
            normalized = normalized.split('?')[0]
        # 移除末尾斜杠
        normalized = normalized.rstrip('/')
        # 转小写
        return normalized.lower()
    
    def _extract_image_path(self, url: str) -> str:
        """
        提取图片路径的核心部分（文件名+扩展名）
        用于更宽松的匹配
        """
        if not url:
            return ''
        # 移除协议和域名，获取路径
        path = url.replace('https://', '').replace('http://', '')
        if '/' in path:
            path = path.split('/', 1)[1] if '/' in path else path
        # 移除查询参数
        if '?' in path:
            path = path.split('?')[0]
        return path.lower()
    
    def _merge_images_with_base64(self, result: Dict) -> Dict:
        """
        将 Claude 选择的图片与 Playwright 提取的 Base64 数据合并
        
        Claude 只返回了图片的 URL，但 Playwright 已经下载并转换为 Base64
        这里将两者匹配，让前端可以直接显示 Base64 图片
        
        匹配策略（按优先级）：
        1. 完全匹配 URL
        2. 协议互换匹配（http <-> https）
        3. 规范化匹配（忽略查询参数、协议、大小写）
        4. 路径匹配（只比较图片路径部分）
        """
        if not result.get('images') or not self._last_playwright_images:
            # 如果 Claude 没有返回图片但 Playwright 有，直接使用 Playwright 的图片
            if not result.get('images') and self._last_playwright_images:
                logger.info(f"[Claude] Claude 未返回图片，使用 Playwright 提取的 {len(self._last_playwright_images)} 张图片")
                result['images'] = []
                for i, img in enumerate(self._last_playwright_images[:5]):  # 最多5张
                    result['images'].append({
                        'url': img.get('url', ''),
                        'base64': img.get('base64', ''),
                        'alt': img.get('alt', f'Product image {i+1}'),
                        'type': 'hero' if i == 0 else 'content'
                    })
                return result
            
            logger.info(f"[Claude] 无需合并图片数据: images={len(result.get('images', []))}, playwright={len(self._last_playwright_images)}")
            return result
        
        # 创建多级 URL 映射
        url_to_data = {}  # 完整图片数据（包含 base64）
        normalized_to_data = {}  # 规范化 URL -> 数据
        path_to_data = {}  # 路径 -> 数据
        
        for img in self._last_playwright_images:
            url = img.get('url', '')
            base64_data = img.get('base64', '')
            if url and base64_data:
                img_data = {
                    'base64': base64_data,
                    'alt': img.get('alt', ''),
                    'width': img.get('width', 0),
                    'height': img.get('height', 0)
                }
                # 完全匹配
                url_to_data[url] = img_data
                # 协议互换
                if url.startswith('https://'):
                    url_to_data[url.replace('https://', 'http://')] = img_data
                elif url.startswith('http://'):
                    url_to_data[url.replace('http://', 'https://')] = img_data
                # 规范化匹配
                normalized = self._normalize_url(url)
                if normalized:
                    normalized_to_data[normalized] = img_data
                # 路径匹配
                path = self._extract_image_path(url)
                if path:
                    path_to_data[path] = img_data
        
        logger.info(f"[Claude] URL 映射表: 完全={len(url_to_data)}, 规范化={len(normalized_to_data)}, 路径={len(path_to_data)}")
        
        # 合并 Base64 到结果图片
        merged_count = 0
        for img in result.get('images', []):
            img_url = img.get('url', '')
            matched_data = None
            match_type = None
            
            # 策略1：完全匹配
            if img_url in url_to_data:
                matched_data = url_to_data[img_url]
                match_type = '完全匹配'
            
            # 策略2：规范化匹配
            if not matched_data:
                normalized = self._normalize_url(img_url)
                if normalized in normalized_to_data:
                    matched_data = normalized_to_data[normalized]
                    match_type = '规范化匹配'
            
            # 策略3：路径匹配
            if not matched_data:
                path = self._extract_image_path(img_url)
                if path in path_to_data:
                    matched_data = path_to_data[path]
                    match_type = '路径匹配'
            
            # 策略4：包含匹配（URL 是否包含某个路径）
            if not matched_data:
                for p_path, p_data in path_to_data.items():
                    if p_path and len(p_path) > 10 and p_path in img_url.lower():
                        matched_data = p_data
                        match_type = '包含匹配'
                        break
            
            if matched_data:
                img['base64'] = matched_data['base64']
                merged_count += 1
                logger.debug(f"[Claude] 图片已合并 ({match_type}): {img_url[:50]}...")
        
        # 如果匹配失败的图片太多，直接将 Playwright 的 base64 按顺序附加
        unmerged_count = len(result.get('images', [])) - merged_count
        if unmerged_count > 0 and self._last_playwright_images:
            logger.warning(f"[Claude] {unmerged_count} 张图片未能匹配，尝试按顺序填充")
            playwright_idx = 0
            for img in result.get('images', []):
                if not img.get('base64') and playwright_idx < len(self._last_playwright_images):
                    pw_img = self._last_playwright_images[playwright_idx]
                    if pw_img.get('base64'):
                        img['base64'] = pw_img.get('base64')
                        img['url'] = img.get('url') or pw_img.get('url', '')
                        merged_count += 1
                        logger.debug(f"[Claude] 图片按顺序填充: idx={playwright_idx}")
                    playwright_idx += 1
        
        logger.info(f"[Claude] 成功合并 {merged_count}/{len(result.get('images', []))} 张图片的 Base64 数据")
        
        return result
    
    def _format_images(self, images: List[Dict]) -> Dict[str, Any]:
        """格式化图片数据（保留 base64 字段）"""
        if not images:
            return {"hero": None, "content": []}
        
        hero = None
        content = []
        
        for img in images:
            img_data = {
                "url": img.get('url'),
                "alt": img.get('alt', '')
            }
            # 保留 base64 字段（如果有）
            if img.get('base64'):
                img_data['base64'] = img.get('base64')
            
            if img.get('type') == 'hero' and not hero:
                hero = img_data
            else:
                content.append(img_data)
        
        # 如果没有标记 hero，使用第一张作为 hero
        if not hero and content:
            hero = content.pop(0)
        
        return {"hero": hero, "content": content[:4]}  # 最多4张内容图


# 单例实例（延迟初始化）
_claude_service: Optional[ClaudeService] = None


def get_claude_service(api_key: str = None, base_url: str = None, model: str = None, fallback_model: str = None) -> ClaudeService:
    """获取 Claude 服务实例"""
    global _claude_service
    
    if _claude_service is None:
        from app.config import settings
        if api_key is None:
            api_key = getattr(settings, 'CLAUDE_API_KEY', None)
            if not api_key:
                raise ValueError("CLAUDE_API_KEY 未配置")
        if base_url is None:
            base_url = getattr(settings, 'CLAUDE_BASE_URL', None)
        if model is None:
            model = getattr(settings, 'CLAUDE_MODEL', None)
        if fallback_model is None:
            fallback_model = getattr(settings, 'CLAUDE_MODEL_FALLBACK', None)
        _claude_service = ClaudeService(api_key, base_url, model, fallback_model)
    
    return _claude_service

