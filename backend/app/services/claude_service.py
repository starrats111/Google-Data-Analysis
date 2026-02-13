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
    DEFAULT_MODEL = "claude-sonnet-4-20250514"
    
    def __init__(self, api_key: str, base_url: str = None, model: str = None):
        self.model = model or self.DEFAULT_MODEL
        
        # 如果是哈基米的 API Key（以 sk- 开头），使用哈基米代理
        if api_key.startswith("sk-"):
            base_url = base_url or self.HAGIMI_BASE_URL
            # 移除末尾的 /v1，Anthropic SDK 会自动添加正确的路径
            if base_url.endswith("/v1"):
                base_url = base_url[:-3]
            self.client = Anthropic(api_key=api_key, base_url=base_url)
            logger.info(f"[Claude] 使用哈基米代理: {base_url}, 模型: {self.model}")
        else:
            self.client = Anthropic(api_key=api_key)
            logger.info(f"[Claude] 使用 Anthropic 官方 API, 模型: {self.model}")
        self.tools = self._define_tools()
    
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
            "content": f"""请分析以下商家网站，提取：
1. 品牌名称 (brand_name)
2. 品牌描述（简短，brand_description）
3. 主营产品类型 (product_type)
4. 当前促销活动或热门产品 (promotions)
5. 从网页中选取5张最适合做博客配图的高质量图片URL（1张主图+4张内容图）
   - 优先选择产品图、场景图
   - 过滤掉logo、小图标、banner广告
   - 图片尺寸应大于400x400
6. 为每张图片生成简短的alt描述

商家网址: {url}

请以JSON格式返回结果，格式如下：
{{
  "brand_name": "品牌名称",
  "brand_description": "品牌描述",
  "product_type": "产品类型",
  "promotions": ["促销活动1", "促销活动2"],
  "products": [
    {{"name": "产品名", "price": "$XX.XX", "description": "描述"}}
  ],
  "images": [
    {{"url": "图片URL", "type": "hero", "alt": "图片描述"}},
    {{"url": "图片URL", "type": "content", "alt": "图片描述"}}
  ],
  "category_suggestion": "建议分类代码"
}}"""
        }]
        
        try:
            response = self.client.messages.create(
                model=self.model,
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
                
                response = self.client.messages.create(
                    model=self.model,
                    max_tokens=4096,
                    tools=self.tools,
                    messages=messages
                )
            
            # 解析最终结果
            for content in response.content:
                if hasattr(content, 'text'):
                    result = self._parse_json_response(content.text)
                    logger.info(f"[Claude] 分析完成: {result.get('brand_name', 'Unknown')}")
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
            response = self.client.messages.create(
                model=self.model,
                max_tokens=8192,
                messages=[{"role": "user", "content": prompt}]
            )
            
            for content in response.content:
                if hasattr(content, 'text'):
                    result = self._parse_json_response(content.text)
                    # 添加图片信息
                    result['images'] = self._format_images(article_images)
                    logger.info(f"[Claude] 文章生成完成: {result.get('title', 'Untitled')}")
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
            response = self.client.messages.create(
                model=self.model,
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
        """获取网页内容"""
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
                # 限制长度，避免 token 超限
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
    
    def _format_images(self, images: List[Dict]) -> Dict[str, Any]:
        """格式化图片数据"""
        if not images:
            return {"hero": None, "content": []}
        
        hero = None
        content = []
        
        for img in images:
            if img.get('type') == 'hero' and not hero:
                hero = {
                    "url": img.get('url'),
                    "alt": img.get('alt', '')
                }
            else:
                content.append({
                    "url": img.get('url'),
                    "alt": img.get('alt', '')
                })
        
        # 如果没有标记 hero，使用第一张作为 hero
        if not hero and content:
            hero = content.pop(0)
        
        return {"hero": hero, "content": content[:4]}  # 最多4张内容图


# 单例实例（延迟初始化）
_claude_service: Optional[ClaudeService] = None


def get_claude_service(api_key: str = None, base_url: str = None, model: str = None) -> ClaudeService:
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
        _claude_service = ClaudeService(api_key, base_url, model)
    
    return _claude_service

