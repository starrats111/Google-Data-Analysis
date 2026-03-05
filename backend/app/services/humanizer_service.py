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
    "值得注意的是", "需要注意的是", "更重要的是", "毫无疑问",
    "不仅仅是", "让我们", "令人惊叹", "令人印象深刻",
    "事实上", "众所周知", "无可否认", "不可否认",
    "总而言之", "综上所述", "总的来说", "一言以蔽之",
    "然而", "此外", "因此", "与此同时",
    "换句话说", "从本质上讲", "在当今时代",
    "revolutionize", "game-changer", "cutting-edge",
    "seamlessly", "leverage", "elevate", "delve into",
    "it is worth noting", "it's important to note",
    "in today's world", "in this digital age",
    "without a doubt", "needless to say",
    "in conclusion", "to sum up", "all in all",
    "furthermore", "moreover", "however",
    "incredibly", "absolutely", "undoubtedly",
    "groundbreaking", "transformative", "innovative",
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
        p = re.sub(r"^(?:First(?:ly)?|Second(?:ly)?|Third(?:ly)?|Finally|Moreover|Furthermore)[,.]?\s*", "", p, flags=re.IGNORECASE)
        cleaned.append(p)
    return "\n\n".join(cleaned)


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
        processed_parts.append(part)

    result = []
    for i, part in enumerate(processed_parts):
        result.append(part)
        if i < len(tags):
            result.append(tags[i])

    final = "".join(result)

    final = re.sub(r"\n{3,}", "\n\n", final)
    final = re.sub(r"[ \t]+\n", "\n", final)
    final = re.sub(r"([。.！!？?])\s*([。.！!？?])", r"\1", final)

    return final.strip()
