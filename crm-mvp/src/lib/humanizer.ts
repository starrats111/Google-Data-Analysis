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
