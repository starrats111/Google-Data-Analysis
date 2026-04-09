/**
 * 去 AI 味处理服务（移植自 humanizer_service.py）
 * 去除 AI 生成文章中的常见痕迹
 */

const AI_WORDS = [
  // 中文 AI 高频词
  "值得注意的是", "需要注意的是", "更重要的是", "毫无疑问",
  "不仅仅是", "让我们", "令人惊叹", "令人印象深刻",
  "事实上", "众所周知", "无可否认", "不可否认",
  "总而言之", "综上所述", "总的来说", "一言以蔽之",
  "然而", "此外", "因此", "与此同时",
  "换句话说", "从本质上讲", "在当今时代",
  // 英文 AI 高频词
  "revolutionize", "revolutionizing", "game-changer", "cutting-edge",
  "seamlessly", "seamless", "leverage", "leveraging",
  "elevate", "elevating", "delve into", "delve",
  "comprehensive", "landscape", "foster", "fostering",
  "harness", "harnessing", "robust", "streamline", "streamlining",
  "empower", "empowering", "curated", "innovative",
  "transformative", "groundbreaking", "paradigm", "paradigm shift",
  "ecosystem", "synergy", "holistic", "multifaceted",
  "pivotal", "testament", "beacon", "tapestry",
  "realm", "embark", "navigate", "navigating",
  "it is worth noting", "it's important to note",
  "in today's world", "in this digital age",
  "without a doubt", "needless to say",
  "in conclusion", "to sum up", "all in all",
  "furthermore", "moreover", "however",
  "incredibly", "absolutely", "undoubtedly",
  "it goes without saying", "at the end of the day",
  "when it comes to", "in the realm of",
  "a testament to", "serves as a beacon",
  "stands as a testament", "paves the way",
  "in a world where", "in an era of",
  "it's no secret that", "there's no denying",
  "one cannot overstate", "it cannot be overstated",
];

const FILLER_PATTERNS: [RegExp, string][] = [
  [/在当今\S{0,6}时代[，,]?/gi, ""],
  [/随着\S{2,8}的(?:快速|不断|持续)?发展[，,]?/gi, ""],
  [/众所周知[，,]?/gi, ""],
  [/值得一提的是[，,]?/gi, ""],
  [/不得不说[，,]?/gi, ""],
  [/让我们一起(?:来)?/gi, ""],
  [/In today'?s (?:digital |modern |fast-paced )?(?:world|age|era)[,.]?\s*/gi, ""],
  [/It(?:'s| is) (?:worth|important to) not(?:e|ing) that\s*/gi, ""],
  [/As we all know[,.]?\s*/gi, ""],
  [/In (?:a |the )?(?:world|era|age) (?:where|of)\s+\w+[,.]?\s*/gi, ""],
  [/When it comes to\s+/gi, "For "],
  [/It(?:'s| is) no secret that\s*/gi, ""],
  [/There(?:'s| is) no denying (?:that )?\s*/gi, ""],
  [/At the end of the day[,.]?\s*/gi, ""],
  [/It goes without saying (?:that )?\s*/gi, ""],
  [/(?:Let's|Let us) (?:dive|delve|explore|take a (?:look|deep dive))\s*/gi, ""],
];

function removeAiWords(text: string): string {
  let result = text;
  for (const word of AI_WORDS) {
    if (result.includes(word)) {
      result = result.replace(word, "");
    }
  }
  return result;
}

function removeFillerPatterns(text: string): string {
  let result = text;
  for (const [pattern, replacement] of FILLER_PATTERNS) {
    result = result.replace(pattern, replacement);
  }
  return result;
}

function reduceExclamation(text: string): string {
  let count = 0;
  let result = "";
  for (const ch of text) {
    if (ch === "!" || ch === "！") {
      count++;
      if (count <= 2) {
        result += ch;
      } else {
        result += ch === "！" ? "。" : ".";
      }
    } else {
      result += ch;
    }
  }
  return result;
}

function cleanParagraphOpeners(text: string): string {
  const paragraphs = text.split("\n\n");
  const cleaned = paragraphs.map((p) => {
    let r = p.replace(/^(?:首先|其次|最后|接下来|另外)[，,]\s*/, "");
    r = r.replace(/^(?:First(?:ly)?|Second(?:ly)?|Third(?:ly)?|Finally|Moreover|Furthermore|Additionally|In addition)[,.]?\s*/i, "");
    return r;
  });
  return cleaned.join("\n\n");
}

function removeEmptyEmphasis(text: string): string {
  let result = text;
  for (const w of ["非常", "极其", "真的", "特别", "强烈推荐", "超级"]) {
    result = result.replace(w, "");
  }
  return result;
}

/** 主入口：对文章内容进行去 AI 味处理 */
export function humanize(text: string): string {
  if (!text) return text;
  let result = text;
  result = removeAiWords(result);
  result = removeFillerPatterns(result);
  result = reduceExclamation(result);
  result = cleanParagraphOpeners(result);
  result = removeEmptyEmphasis(result);
  // 清理多余空行
  result = result.replace(/\n{3,}/g, "\n\n");
  return result.trim();
}

// ─── 广告文案去 AI 味 ───

const AD_COPY_REPLACEMENTS: [RegExp, string][] = [
  [/^Unlock\s+/i, "Get "],
  [/^Unleash\s+/i, "Try "],
  [/^Elevate\s+(?:Your\s+)?/i, "Upgrade "],
  [/^Transform\s+(?:Your\s+)?/i, "Improve "],
  [/^Discover\s+(?:the\s+)?/i, "See "],
  [/^Experience\s+(?:the\s+)?/i, "See "],
  [/^Embrace\s+/i, "Choose "],
  [/^Reimagine\s+/i, "Rethink "],
  [/^Redefine\s+(?:Your\s+)?/i, "Change "],
  [/^Supercharge\s+/i, "Boost "],
  [/^Empower\s+(?:Your\s+)?/i, "Strengthen "],
  [/^Navigate\s+(?:Your\s+)?/i, "Plan "],
  [/^Harness\s+(?:the\s+)?/i, "Use "],
  [/\bseamless(?:ly)?\b/gi, "smooth"],
  [/\bcutting[\s-]edge\b/gi, "modern"],
  [/\bworld[\s-]class\b/gi, "top"],
  [/\bbest[\s-]in[\s-]class\b/gi, "top"],
  [/\bunmatched\b/gi, "great"],
  [/\bunparalleled\b/gi, "top"],
  [/\brevolution(?:ary|ize|izing)\b/gi, "new"],
  [/\bgame[\s-]chang(?:er|ing)\b/gi, "effective"],
  [/\btransformative\b/gi, "powerful"],
  [/\bgroundbreaking\b/gi, "new"],
  [/\bholistic\b/gi, "complete"],
  [/\bsynergy\b/gi, "teamwork"],
  [/\bparadigm(?:\s+shift)?\b/gi, "approach"],
  [/\bbespoke\b/gi, "custom"],
  [/\bcurated\b/gi, "selected"],
  [/\bdelve\b/gi, "look"],
  [/\btestament\b/gi, "proof"],
  [/\bpivotal\b/gi, "key"],
  [/\brobust\b/gi, "strong"],
  [/\bstreamline[ds]?\b/gi, "simplify"],
  [/\binnovative\b/gi, "new"],
  // 中文 AI 高频广告词
  [/引领\S{0,4}(?:未来|潮流|趋势)/g, ""],
  [/(?:全面)?(?:赋能|赋予力量)/g, "帮助"],
  [/无缝(?:衔接|连接|体验)/g, "顺畅"],
  [/(?:颠覆|革新|革命性)/g, "全新"],
  [/(?:前沿|尖端|领先)技术/g, "新技术"],
  [/一站式(?:解决方案)?/g, "完整方案"],
  [/(?:极致|卓越|非凡)(?:体验|品质)/g, "优质"],
  [/开启\S{0,4}之旅/g, "开始使用"],
];

/** 广告文案去 AI 味：对单条标题/描述做轻量替换，保留字数限制内的可读性 */
export function humanizeAdCopy(text: string): string {
  if (!text) return text;
  let result = text;
  for (const [pattern, replacement] of AD_COPY_REPLACEMENTS) {
    result = result.replace(pattern, replacement);
  }
  result = result.replace(/\s{2,}/g, " ").trim();
  return result;
}

/**
 * 批量处理广告文案：对标题/描述数组做去 AI 味处理
 * 如果处理后超长或过短，则保留原始文案
 */
export function humanizeAdCopyBatch(items: string[], minLen: number, maxLen: number): string[] {
  return items.map((item) => {
    const cleaned = humanizeAdCopy(item);
    if (cleaned.length < minLen || cleaned.length > maxLen) return item;
    return cleaned;
  });
}

/** 注入到广告文案 prompt 中的反 AI 指令块 */
export const AD_COPY_ANTI_AI_BLOCK = `
【WRITING STYLE — CRITICAL】
Write like a real conversion copywriter who gets paid for results, NOT a generic AI. Your output will be checked — vague, inflated, or AI-sounding copy will be rejected.

BANNED words (auto-rejected — any use fails quality check):
unlock, unleash, elevate, transform, discover, revolutionize, game-changer, seamless, seamlessly, cutting-edge, world-class, best-in-class, unmatched, unparalleled, supercharge, empower, harness, navigate, embrace, reimagine, redefine, groundbreaking, innovative, transformative, holistic, synergy, paradigm, bespoke, curated, delve, testament, pivotal, robust, streamline, ecosystem, embark, realm, tapestry, beacon, multifaceted

THE GOLD STANDARD: Write copy that makes someone mid-scroll STOP and think "wait, this is exactly what I need."
A smart 16-year-old should understand it instantly. A skeptical adult should trust it immediately.

CONVERSION COPY PLAYBOOK — how Adrian writes:
- PAINT THE OUTCOME, not the product: "Wake up to clear skin" beats "Advanced skincare formula"
- USE SENSORY WORDS: "buttery soft", "crystal clear", "whisper quiet" — make them FEEL it
- NUMBERS CREATE TRUST: "4.8★ rating", "2-week results", "3 active ingredients", "10,000+ sold"
- NAME THE ENEMY, then defeat it: "No more breakouts" / "Stop wasting money on products that don't work"
- CREATE CONTRAST: "Without harsh chemicals" / "Not another generic formula" / "Finally, one that actually works"
- ACTIVE VERBS ONLY: works, clears, fights, lasts, fits, helps, protects, saves, stops, fades, locks, blocks
- SPECIFICITY IS KING: "Clears acne in 14 days" beats "Effective skincare" by 10x
- URGENCY WITHOUT DESPERATION: "Selling fast" beats "BUY NOW!!!"

STRONG COPY (study these patterns):
  "Real results for real skin — see the difference in 2 weeks"
  "Tired of chargers that quit? Ours lasts all day"
  "Loved by 12K+ customers who tried everything else first"
  "No harsh chemicals. No compromises. Just results"
  "Handmade in Italy — feel the quality in every stitch"

WEAK COPY (these will be auto-rejected):
  "Experience our innovative skincare solution" (says nothing)
  "Premium quality products at great prices" (zero specificity)
  "Discover the best collection online" (generic, forgettable)
  "Your one-stop shop for all your needs" (meaningless filler)

【GOOGLE ADS POLICY COMPLIANCE — MANDATORY PRE-CHECK】
Before writing ANY ad copy, you MUST assess whether the merchant's product category could trigger Google's restricted content policies. If the merchant name, product, or niche is ambiguous or borderline:
- Identify the LEGAL, LEGITIMATE use case of the product
- Write copy that CLEARLY describes the legal use, leaving ZERO room for Google's automated policy system to misinterpret
- NEVER use terminology associated with controlled substances, even if the merchant's website uses it
- Example: A mushroom cultivation supply store → write "Mushroom Growing Kits", "Mycology Equipment", "Spore Cultivation Supplies" — NEVER "magic mushrooms", "shrooms", "psychedelic"
- Example: A knife store → write "Kitchen Knives", "Chef's Knife Set" — NEVER "buy weapons", "combat knife"
- If in doubt, choose the SAFER word. A slightly less catchy headline that passes review beats a brilliant one that gets rejected.

【SELF-CHECK PROTOCOL — MANDATORY BEFORE OUTPUT】
Before outputting ANY headline or description, run these 3 checks on EACH line. If any check fails, rewrite immediately — no excuses.

CHECK 1 — Human Voice Test:
  Ask yourself: "If I were the user scrolling through search results, would this feel like a real person talking to me, or a program spitting out ads?"
  → If it feels like a template, a bot, or mass-generated copy → REWRITE.
  → Pass criteria: Reads like something a friend would text you — has emotion, has edge, has the "only an insider would say this" flavor.

CHECK 2 — Dead Weight Test:
  Ask yourself: "Is there ANY word in this line that, if deleted, would leave the meaning completely unchanged?"
  → If yes, cut that word or rewrite the whole line. Every word must earn its place. Words without purpose are noise.

CHECK 3 — Click Desire Test:
  Ask yourself: "If this headline appeared in Google search results surrounded by competitor ads, WHY would someone click mine?"
  → If you can't articulate a reason → REWRITE.
  → Pass criteria: Either an impossible-to-ignore number, or a pain point that makes them think "damn, that's exactly my problem."

⚠️ IRON RULE: All 3 checks must pass before output. Any failure = immediate rewrite. No shortcuts.
`;
