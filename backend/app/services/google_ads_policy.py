"""
Google Ads 广告政策数据库
基于 Google Ads 官方政策文档整理，用于 AI 文案生成时的合规检查。
"""

# ═══════════════════════════════════════════════════════════════
# 一、通用编辑规范（适用于所有广告文案）
# ═══════════════════════════════════════════════════════════════
EDITORIAL_RULES = """## Google Ads 编辑合规规范（必须严格遵守）

### 1. 标点与符号
- 禁止连续重复标点（如 "Buy Now!!" "Save $$$"）
- 禁止在标题(headline)中使用感叹号
- 禁止使用 emoji 或特殊 Unicode 符号（如 ★ ♥ ✓ ✔ → ☎）
- 禁止用符号/数字替代字母（如 "fl@wers" "f1owers"）
- 禁止滥用句号、星号、项目符号（如 "*Sale*" "•Free•"）

### 2. 大小写
- 禁止全大写单词（品牌缩写除外，如 "TYMO" "BMW" 可以）
- 禁止 gimmick 式大写（如 "BeSt PrIcE"）
- 正常的标题式大写(Title Case)是允许的

### 3. 内容真实性
- 禁止虚假/误导性声明（如 "Guaranteed #1 on Google"）
- 禁止无法验证的最高级声明（如 "Best in the world" "Cheapest ever"），除非有第三方权威认证
- 禁止虚假紧迫感（如 "Only 2 left!" 除非着陆页确实如此）
- 所有价格、折扣、免运费等声明必须在着陆页可验证

### 4. 商标与品牌
- 禁止在广告中使用竞争对手的商标名称
- 禁止暗示与其他品牌有官方关联（除非确实有）
- 可以使用自己的品牌名

### 5. 语言质量
- 必须使用正确的语法和拼写
- 禁止不完整或截断的句子
- 禁止无意义的文本填充
- 文案必须与着陆页内容相关
"""

# ═══════════════════════════════════════════════════════════════
# 二、禁止内容（绝对不能出现在广告中）
# ═══════════════════════════════════════════════════════════════
PROHIBITED_CONTENT_RULES = """## 禁止内容（文案中绝对不能包含）

### 1. 危险产品/服务
- 毒品、精神活性物质、吸毒用具
- 武器、弹药、爆炸物
- 烟草产品、电子烟（含尼古丁）
- 如何制造武器/爆炸物的指导

### 2. 欺诈/不当行为
- 假冒商品
- 黑客服务、监控软件
- 伪造文件
- 学术作弊服务

### 3. 不当内容
- 仇恨言论、歧视性内容
- 暴力/血腥内容
- 恐吓/骚扰
- 色情/露骨性内容

### 4. 禁止的声明方式
- "Guaranteed results"（保证效果）
- "Miracle cure"（奇迹疗效）
- "Get rich quick"（快速致富）
- "No risk"（零风险）
- "100% success rate"（100%成功率）
- 任何暗示政府/官方背书的声明
"""

# ═══════════════════════════════════════════════════════════════
# 三、限制品类政策（根据商家品类动态注入）
# ═══════════════════════════════════════════════════════════════
RESTRICTED_CATEGORY_POLICIES = {
    "alcohol": {
        "label": "酒类",
        "keywords": [
            "whiskey", "whisky", "vodka", "rum", "gin", "tequila", "brandy",
            "cognac", "bourbon", "wine", "beer", "brewery", "brewing",
            "distillery", "spirits", "liquor", "champagne", "sake", "cider",
            "mead", "absinthe", "moonshine", "cocktail", "scotch", "ale",
            "lager", "stout", "prosecco", "mezcal", "soju", "baijiu",
        ],
        "policy": """### 酒类广告特殊政策
- 仅限以下国家投放: US, UK, CA, AU, DE, FR, JP, BR, IT, ES, NL, BE, AT, CH, IE, NZ, ZA, MX, AR, CL, CO, PE, SE, NO, DK, FI, PL, CZ, HU, RO, BG, HR, SK, SI, PT, GR, KR, TW, HK, SG, MY, TH, PH, VN(≤5.5%ABV), IN(0%ABV), ID(0%ABV)
- 禁止面向未成年人（不得暗示年轻人饮酒）
- 禁止推广过量饮酒或酗酒
- 禁止将饮酒与驾驶、运动、工作表现关联
- 禁止暗示饮酒能改善社交/性吸引力
- 着陆页必须标注酒精含量(ABV)
- 文案建议: 强调品质、工艺、产地、口感，避免"party""drunk""get wasted"等词
- 安全用语: "Crafted with care" "Premium quality" "Aged to perfection" "Discover our collection"
""",
    },
    "gambling": {
        "label": "赌博",
        "keywords": [
            "casino", "poker", "betting", "gamble", "gambling", "lottery",
            "slot", "bingo", "wager", "sportsbook", "jackpot",
        ],
        "policy": """### 赌博广告特殊政策（需要 Google 认证）
- 必须持有 Google 赌博广告认证
- 必须持有投放目标国家的合法赌博牌照
- 仅限已批准的国家投放
- 禁止面向未成年人
- 必须包含负责任赌博信息
- 禁止暗示赌博能解决财务问题
- 文案必须包含: 年龄限制提示、负责任赌博声明
- ⚠ 建议: 如无赌博认证，不要投放此类广告
""",
    },
    "healthcare": {
        "label": "医疗/保健",
        "keywords": [
            "pharmacy", "pharmaceutical", "prescription", "drug", "medicine",
            "supplement", "vitamin", "health", "wellness", "treatment",
            "therapy", "cure", "clinical", "medical", "doctor",
            "weight loss", "diet pill", "fat burner",
        ],
        "policy": """### 医疗/保健广告特殊政策
- 处方药广告需要 Google 药品认证
- 禁止声称能治愈疾病（如 "Cures cancer" "Eliminates diabetes"）
- 禁止使用 "miracle" "guaranteed cure" "100% effective" 等词
- 保健品不得声称有医疗效果
- 减肥产品禁止不切实际的承诺（如 "Lose 30 lbs in a week"）
- OTC保健品/维生素可以投放，但需谨慎措辞
- 安全用语: "Support your health" "Wellness essentials" "Quality supplements"
- 禁止用语: "Cure" "Treat" "Heal" "Miracle" "Doctor recommended"(除非有证据)
""",
    },
    "financial": {
        "label": "金融服务",
        "keywords": [
            "loan", "credit", "mortgage", "insurance", "invest", "trading",
            "forex", "crypto", "bitcoin", "stock", "bond", "banking",
            "payday loan", "debt", "refinance",
        ],
        "policy": """### 金融服务广告特殊政策
- 必须在着陆页披露所有费用和条款
- 禁止隐藏费用或误导性利率
- 禁止保证投资回报（如 "Guaranteed 20% returns"）
- 加密货币广告需要 Google 认证
- 个人贷款广告必须披露 APR
- 禁止面向财务困难人群的掠夺性广告
- 安全用语: "Compare rates" "Learn about options" "Get a free quote"
- 禁止用语: "Guaranteed approval" "No credit check" "Get rich" "Easy money"
""",
    },
    "adult": {
        "label": "成人内容",
        "keywords": [
            "adult", "xxx", "porn", "sex toy", "lingerie", "erotic",
            "escort", "dating",
        ],
        "policy": """### 成人内容广告特殊政策
- 露骨色情内容完全禁止
- 成人约会服务有限制，需要认证
- 内衣/泳装可以投放，但图片不得过于暴露
- 禁止性暗示文案
- 安全用语: 使用专业、优雅的产品描述
""",
    },
    "weapon": {
        "label": "武器",
        "keywords": [
            "firearm", "ammunition", "gun", "rifle", "pistol", "shotgun",
            "weapon", "knife", "sword", "tactical",
        ],
        "policy": """### 武器广告政策（严格限制）
- 枪支、弹药、爆炸物广告完全禁止
- 刀具/户外工具可以投放，但不得强调攻击性
- 禁止使用暴力相关词汇
- 安全用语: "Outdoor tools" "Camping essentials" "Precision craftsmanship"
- 禁止用语: "Deadly" "Kill" "Attack" "Combat" "Assault"
""",
    },
}

# ═══════════════════════════════════════════════════════════════
# 四、RSA 广告格式规范
# ═══════════════════════════════════════════════════════════════
RSA_FORMAT_RULES = """## RSA 广告格式硬性规范
- Headline: 最多 30 字符，最多 15 条，禁止感叹号
- Description: 最多 90 字符，最多 4 条
- Sitelink link_text: 最多 25 字符
- Sitelink description: 最多 35 字符
- Callout text: 最多 25 字符，禁止感叹号
- Path: 最多 15 字符
- 双宽字符语言(中日韩)字符限制减半
"""


def detect_restricted_categories(merchant_name: str, categories: str = "") -> list:
    """检测商家是否属于限制品类，返回匹配的政策列表"""
    name_lower = (merchant_name or "").lower()
    cat_lower = (categories or "").lower()
    matched = []
    for cat_id, info in RESTRICTED_CATEGORY_POLICIES.items():
        if any(kw in name_lower or kw in cat_lower for kw in info["keywords"]):
            matched.append(info)
    return matched


def build_policy_prompt(merchant_name: str, categories: str = "") -> str:
    """根据商家信息构建完整的政策合规 prompt 片段"""
    sections = [EDITORIAL_RULES, PROHIBITED_CONTENT_RULES, RSA_FORMAT_RULES]

    # 检测限制品类并添加特定政策
    restricted = detect_restricted_categories(merchant_name, categories)
    if restricted:
        labels = [r["label"] for r in restricted]
        sections.append(f"\n⚠️ 该商家涉及限制品类: {', '.join(labels)}，必须严格遵守以下额外政策：")
        for r in restricted:
            sections.append(r["policy"])

    return "\n".join(sections)
