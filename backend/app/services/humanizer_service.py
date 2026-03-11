"""
去AI味处理服务（OPT-012）
基于 Humanizer-zh 规则，去除 AI 生成文章中的常见痕迹
"""
import re
import random
import logging
from typing import List, Tuple

logger = logging.getLogger(__name__)

AI_WORDS = [
    # 中文 AI 高频词
    "值得注意的是", "需要注意的是", "更重要的是", "毫无疑问",
    "不仅仅是", "让我们", "令人惊叹", "令人印象深刻",
    "事实上", "众所周知", "无可否认", "不可否认",
    "总而言之", "综上所述", "总的来说", "一言以蔽之",
    "然而", "此外", "因此", "与此同时",
    "换句话说", "从本质上讲", "在当今时代",
    # 英文 AI 高频词（扩展列表）
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
]

FILLER_PATTERNS = [
    (r"(?i)在当今\w{0,6}时代[，,]?", ""),
    (r"(?i)随着\w{2,8}的(?:快速|不断|持续)?发展[，,]?", ""),
    (r"(?i)众所周知[，,]?", ""),
    (r"(?i)值得一提的是[，,]?", ""),
    (r"(?i)不得不说[，,]?", ""),
    (r"(?i)让我们一起(?:来)?", ""),
    (r"(?i)In today'?s (?:digital |modern |fast-paced )?(?:world|age|era)[,.]?\s*", ""),
    (r"(?i)It(?:'s| is) (?:worth|important to) not(?:e|ing) that\s*", ""),
    (r"(?i)As we all know[,.]?\s*", ""),
    (r"(?i)In (?:a |the )?(?:world|era|age) (?:where|of)\s+\w+[,.]?\s*", ""),
    (r"(?i)When it comes to\s+", "For "),
    (r"(?i)It(?:'s| is) no secret that\s*", ""),
    (r"(?i)There(?:'s| is) no denying (?:that )?\s*", ""),
    (r"(?i)At the end of the day[,.]?\s*", ""),
    (r"(?i)It goes without saying (?:that )?\s*", ""),
    (r"(?i)One cannot (?:over)?state\s*", ""),
    (r"(?i)(?:Let's|Let us) (?:dive|delve|explore|take a (?:look|deep dive))\s*", ""),
    (r"(?i)(?:Have you ever )?(?:wondered|thought about)\s+", ""),
]

EMPHASIS_MARKS = ["!", "！"]

REPEATING_STRUCTURE_THRESHOLD = 3


def _remove_ai_words(text: str) -> str:
    """去除 AI 高频词汇"""
    for word in AI_WORDS:
        if word in text:
            text = text.replace(word, "", 1)
    return text


def _remove_filler_patterns(text: str) -> str:
    """去除 AI 常见套话开头"""
    for pattern, replacement in FILLER_PATTERNS:
        text = re.sub(pattern, replacement, text, count=2)
    return text


def _reduce_exclamation(text: str) -> str:
    """降低感叹号密度——保留前两个，后续概率性删除"""
    count = 0
    result = []
    for ch in text:
        if ch in EMPHASIS_MARKS:
            count += 1
            if count <= 2:
                result.append(ch)
            elif random.random() < 0.3:
                result.append("。" if "！" in ch else ".")
            else:
                result.append("。" if "！" in ch else ".")
        else:
            result.append(ch)
    return "".join(result)


def _break_parallel_structures(text: str) -> str:
    """打破明显的重复排比结构"""
    lines = text.split("\n")
    if len(lines) < REPEATING_STRUCTURE_THRESHOLD:
        return text

    result = []
    bullet_streak = 0
    for line in lines:
        stripped = line.strip()
        if re.match(r"^[\-\*•]\s", stripped):
            bullet_streak += 1
            if bullet_streak > 4:
                line = re.sub(r"^[\-\*•]\s", "", line, count=1)
                bullet_streak = 0
        else:
            bullet_streak = 0
        result.append(line)
    return "\n".join(result)


def _remove_empty_emphasis(text: str) -> str:
    """去除空泛的修饰语"""
    for w in ["非常", "极其", "真的", "特别", "强烈推荐", "超级"]:
        text = text.replace(w, "", 1)
    return text


def _clean_paragraph_openers(text: str) -> str:
    """清理段落开头的 AI 过渡句"""
    paragraphs = text.split("\n\n")
    cleaned = []
    for p in paragraphs:
        p = re.sub(r"^(?:首先|其次|最后|接下来|另外)[，,]\s*", "", p)
        p = re.sub(r"^(?:First(?:ly)?|Second(?:ly)?|Third(?:ly)?|Finally|Moreover|Furthermore|Additionally|In addition)[,.]?\s*", "", p, flags=re.IGNORECASE)
        cleaned.append(p)
    return "\n\n".join(cleaned)


def _diversify_paragraph_starts(text: str) -> str:
    """
    段落开头多样性检查：避免连续段落用相同句式开头。
    检测 <p> 标签内的文本开头，如果连续 2+ 段落以相同模式开头，重写开头。
    """
    # 匹配 <p> 标签内容
    p_pattern = re.compile(r'(<p[^>]*>)(.*?)(</p>)', re.DOTALL | re.IGNORECASE)
    matches = list(p_pattern.finditer(text))
    if len(matches) < 3:
        return text

    # 提取每段开头的前几个词
    def _get_opener(content):
        clean = re.sub(r'<[^>]+>', '', content).strip()
        words = clean.split()[:4]
        return " ".join(words).lower() if words else ""

    openers = [_get_opener(m.group(2)) for m in matches]

    # 检测连续相同开头模式
    # 如果连续段落以 "The" 或 "This" 或 "It" 开头，在第二个之后的段落前面不做修改
    # 但如果连续 3+ 段落以完全相同的词开头，标记需要处理
    repetitive_indices = set()
    for i in range(2, len(openers)):
        first_word_i = openers[i].split()[0] if openers[i] else ""
        first_word_prev = openers[i-1].split()[0] if openers[i-1] else ""
        first_word_prev2 = openers[i-2].split()[0] if openers[i-2] else ""
        if first_word_i and first_word_i == first_word_prev == first_word_prev2:
            repetitive_indices.add(i)

    if not repetitive_indices:
        return text

    # 对重复开头的段落，尝试移除开头的过渡词
    transition_starters = re.compile(
        r'^(?:The |This |It |These |That |Those |Here |There |While |Although |But |And |So |Yet |However, |Moreover, |Furthermore, |Additionally, |In fact, |Indeed, )',
        re.IGNORECASE
    )

    result = text
    offset = 0
    for idx in sorted(repetitive_indices):
        m = matches[idx]
        inner = m.group(2)
        clean_inner = transition_starters.sub('', inner, count=1)
        if clean_inner != inner:
            old_full = m.group(0)
            new_full = m.group(1) + clean_inner + m.group(3)
            pos = result.find(old_full, m.start() + offset)
            if pos >= 0:
                result = result[:pos] + new_full + result[pos + len(old_full):]
                offset += len(new_full) - len(old_full)

    return result


def _control_transition_density(text: str) -> str:
    """过渡词密度控制：如果过渡词出现过于频繁，移除部分"""
    transition_words = [
        "however", "moreover", "furthermore", "additionally",
        "nevertheless", "consequently", "therefore", "thus",
        "meanwhile", "subsequently", "nonetheless",
    ]
    for tw in transition_words:
        # 如果同一个过渡词出现 3+ 次，移除第 3 次及之后的
        pattern = re.compile(r'(?i)\b' + re.escape(tw) + r'[,.]?\s*', re.IGNORECASE)
        found = list(pattern.finditer(text))
        if len(found) >= 3:
            # 从后往前移除，保留前 2 个
            for m in reversed(found[2:]):
                text = text[:m.start()] + text[m.end():]
    return text


def humanize(text: str) -> str:
    """
    对文本进行去AI味处理，返回处理后的文本。
    不改变 HTML 标签结构，只处理纯文本内容。
    """
    if not text or len(text) < 50:
        return text

    html_tags: List[Tuple[int, str]] = []
    tag_pattern = re.compile(r"<[^>]+>")

    parts = tag_pattern.split(text)
    tags = tag_pattern.findall(text)

    processed_parts = []
    for part in parts:
        part = _remove_ai_words(part)
        part = _remove_filler_patterns(part)
        part = _reduce_exclamation(part)
        part = _break_parallel_structures(part)
        part = _remove_empty_emphasis(part)
        part = _clean_paragraph_openers(part)
        part = _control_transition_density(part)
        processed_parts.append(part)

    result = []
    for i, part in enumerate(processed_parts):
        result.append(part)
        if i < len(tags):
            result.append(tags[i])

    final = "".join(result)

    # 段落开头多样性检查（在 HTML 重组后执行，因为需要看 <p> 标签）
    final = _diversify_paragraph_starts(final)

    final = re.sub(r"\n{3,}", "\n\n", final)
    final = re.sub(r"[ \t]+\n", "\n", final)
    final = re.sub(r"([。.！!？?])\s*([。.！!？?])", r"\1", final)

    return final.strip()
