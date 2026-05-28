/**
 * D-039 H2 — 行业感知中性描述模板
 *
 * 当商家属于"高敏感品类"（万圣节装饰、反病毒软件、博彩、成人用品等）时：
 *   1. detectIndustryProfile() 通过 merchant_name / category / pageText 识别行业
 *   2. buildIndustryPromptHint() 生成强制 prompt 注入文本（覆盖 AI 默认 category 判断）
 *   3. ad-compliance-checker.ts 用 extraBannedTerms 做本地校验
 *
 * 设计目标：
 *   - 对默认中性的商家（占 95%+）零影响（detectIndustryProfile 返回 null）
 *   - 对 5% 高敏感品类商家强制使用中性词，避免 "Spooky/Hacked/Sick of" 类违规
 */

export interface IndustryProfile {
  id: string;
  label: string;
  /** detector：命中任意一个 keyword（小写后子串匹配）即认为属于该行业 */
  detectKeywords: string[];
  /** 该行业禁止出现的额外词（在 Google 通用规则之上叠加） */
  extraBannedTerms: string[];
  /** 中性替代描述模板 — 给 AI prompt 的明确指导 */
  neutralAlternatives: Array<{ avoid: string; useInstead: string }>;
  /** 行业专属 prompt 指引（注入到 generate-extensions ad-copy prompt 末尾） */
  promptHint: string;
}

export const INDUSTRY_PROFILES: IndustryProfile[] = [
  {
    id: "halloween_horror",
    label: "万圣节 / 惊悚装饰 / 角色扮演",
    detectKeywords: [
      "halloween", "spooky", "horror", "costume", "scary", "haunted", "spencers", "spirit halloween",
      "demon", "zombie", "vampire", "skeleton", "ghoul", "monster", "creature",
      "万圣节", "恐怖", "鬼屋",
    ],
    extraBannedTerms: [
      "Spooky", "Scary", "Demon", "Demonic", "Blood", "Bloody", "Horror", "Nightmare",
      "Creepy", "Sinister", "Dead", "Death", "Kill", "Killing", "Ghoul", "Zombie",
      "Vampire", "Witch", "Witchcraft", "Devil", "Hell", "Possessed", "Haunt", "Haunting",
    ],
    neutralAlternatives: [
      { avoid: "Spooky welcome", useInstead: "Themed welcome" },
      { avoid: "Scary decoration", useInstead: "Themed decor" },
      { avoid: "Demon Hunters t-shirt", useInstead: "Graphic Tees — Hunter Collection" },
      { avoid: "Horror movie costume", useInstead: "Character costume" },
      { avoid: "Spooky duo decor", useInstead: "Themed decorative set" },
    ],
    promptHint: `
═══ INDUSTRY-SPECIFIC OVERRIDE — Halloween / Themed Decor ═══
This merchant sells themed party / costume / decorative items. Google Ads "shocking content" policy strictly forbids horror/scary language even for this category. You MUST:
  · Replace "Spooky/Scary/Demon/Horror/Blood/Zombie" → "Themed / Decorative / Costume / Graphic"
  · Replace "Haunted house" → "Themed home setup"
  · Replace "Scary makeup" → "Costume makeup" / "Special effects makeup"
  · Use POSITIVE framing: "Party Essentials", "Halloween Party Decor", "Themed Costume Accessories"
  · NEVER use: Spooky, Scary, Demon, Demonic, Blood, Horror, Nightmare, Creepy, Dead, Kill, Ghoul, Zombie, Vampire, Devil
  · Examples:
    ✗ "Spooky welcome for your front door" → ✓ "Themed welcome for your front door"
    ✗ "Demon Hunters tee — Limited Stock" → ✓ "Graphic Tees — Hunter Series, Limited Stock"
    ✗ "Spirit Halloween Best Costumes" → ✓ "Top-Selling Costume Collection"`,
  },
  {
    id: "antivirus_security",
    label: "反病毒 / 安全软件 / VPN",
    detectKeywords: [
      "antivirus", "malware", "malwarebytes", "norton", "mcafee", "kaspersky", "bitdefender",
      "vpn", "spyware", "ransomware", "phishing", "firewall", "endpoint", "cybersecurity",
      "security software", "防病毒", "杀毒",
    ],
    extraBannedTerms: [
      "Hacked", "Hack", "Hacker", "Hacking", "Sick of", "Tired of", "Skip",
      "Stops All", "Block All", "Block Everything", "Catches All",
      "100% Clean", "Threat-Free", "Bulletproof", "Impenetrable", "Unhackable",
      "Pop-Ups", "Sketchy", "Phone Hacked", "iPhone Hacked", "Device Hacked",
      "Award-Winning", "Trusted Brand", "#1 Antivirus",
    ],
    neutralAlternatives: [
      { avoid: "Sick of pop-ups?", useInstead: "Reduce intrusive pop-ups" },
      { avoid: "iPhone hacked ads", useInstead: "Mobile security tools" },
      { avoid: "Stops all malware", useInstead: "Detects malware threats" },
      { avoid: "100% Clean", useInstead: "Strong malware detection" },
      { avoid: "Award-Winning Antivirus", useInstead: "Comprehensive Device Protection" },
      { avoid: "Skip juggling apps", useInstead: "Unified security in one app" },
    ],
    promptHint: `
═══ INDUSTRY-SPECIFIC OVERRIDE — Antivirus / Security / VPN ═══
This merchant sells security software. Google Ads "free desktop software" policy + "unfair advantage" policy strictly forbid scare tactics, absolute claims, and competitor disparagement. You MUST:
  · NEVER use scare-tactic openers: "Sick of", "Tired of", "Phone hacked?", "Worried about"
  · NEVER use absolute claims: "Stops All", "100% Clean", "Block Everything", "Catches Every Threat"
  · NEVER disparage competitors: "Skip other apps", "Better than [competitor]"
  · NEVER use unverified superlatives: "Award-Winning", "Trusted Brand", "#1 Antivirus" unless verifiable
  · USE functional language: "Device Protection", "Privacy Tools", "Malware Detection", "Browse Safely"
  · Examples:
    ✗ "Sick of pop-ups and sketchy links?" → ✓ "Reduce intrusive pop-ups and risky links"
    ✗ "Tired of iPhone hacked ads?" → ✓ "Mobile security and ad-blocking tools"
    ✗ "Award-Winning Malwarebytes" → ✓ "Comprehensive Device Protection"
    ✗ "Scam Guard Stops Fake Links" → ✓ "Scam Guard Helps Identify Suspicious Links"`,
  },
  {
    id: "gambling_casino",
    label: "博彩 / 赌场 / 抽奖",
    detectKeywords: [
      "casino", "gambling", "betting", "sportsbook", "poker", "slot", "roulette",
      "lottery", "sweepstakes", "bingo", "wager", "odds", "blackjack",
      "赌场", "博彩",
    ],
    extraBannedTerms: [
      "Win Big", "Guaranteed Wins", "Easy Money", "Get Rich", "Risk-Free Bet",
      "Sure Bet", "100% Win", "Cant Lose", "Win Every Time",
    ],
    neutralAlternatives: [
      { avoid: "Win big tonight", useInstead: "Play tonight — entertainment first" },
      { avoid: "Guaranteed wins", useInstead: "Real-time odds" },
      { avoid: "Easy money", useInstead: "Casino entertainment" },
    ],
    promptHint: `
═══ INDUSTRY-SPECIFIC OVERRIDE — Gambling / Casino ═══
This merchant operates in gambling. Google Ads gambling policy requires "Play Responsibly" framing. You MUST:
  · NEVER promise wins: "Win Big", "Guaranteed", "Sure Bet", "Cant Lose", "Easy Money"
  · USE entertainment framing: "Casino Games", "Live Tables", "Sports Betting", "Play Responsibly"
  · Mention responsibility if possible: "21+ Only", "Play Responsibly"`,
  },
  {
    id: "adult_intimate",
    label: "成人用品 / 内衣 / 私密用品",
    detectKeywords: [
      "lingerie", "intimate", "adult toy", "sex toy", "swimwear adult", "bikini",
      "loungewear", "sleepwear", "boudoir",
      "情趣", "性用品",
    ],
    extraBannedTerms: [
      "Sexy", "Hot", "Naughty", "XXX", "Erotic", "Seductive", "Aroused",
    ],
    neutralAlternatives: [
      { avoid: "Sexy lingerie", useInstead: "Intimate apparel" },
      { avoid: "Hot bikini", useInstead: "Swimwear collection" },
      { avoid: "Naughty styles", useInstead: "Boudoir styles" },
    ],
    promptHint: `
═══ INDUSTRY-SPECIFIC OVERRIDE — Intimate Apparel ═══
This merchant sells intimate apparel. Google Ads "adult-oriented" policy requires neutral product-functional language. You MUST:
  · Use product-functional terms: "Loungewear", "Swimwear", "Intimate Apparel", "Boudoir Wear"
  · NEVER use provocative descriptors: "Sexy", "Hot", "Naughty", "Erotic", "Seductive"`,
  },
];

/**
 * 根据 merchant_name / category / pageText 自动识别行业。
 * 命中任意一个 detectKeyword（子串匹配，大小写无关）即归属该行业。
 * 多个命中时按 INDUSTRY_PROFILES 数组顺序优先（万圣节 > 反病毒 > 博彩 > 成人）。
 */
export function detectIndustryProfile(input: {
  merchantName?: string | null;
  category?: string | null;
  pageText?: string | null;
}): IndustryProfile | null {
  const haystack = [input.merchantName ?? "", input.category ?? "", (input.pageText ?? "").slice(0, 2000)]
    .join(" ")
    .toLowerCase();
  if (!haystack.trim()) return null;
  for (const profile of INDUSTRY_PROFILES) {
    if (profile.detectKeywords.some((kw) => haystack.includes(kw.toLowerCase()))) {
      return profile;
    }
  }
  return null;
}

/** 生成注入到 generate-extensions prompt 末尾的行业感知指引 */
export function buildIndustryPromptHint(profile: IndustryProfile | null): string {
  if (!profile) return "";
  return `\n${profile.promptHint.trim()}\n`;
}

/** 返回该 profile 的所有 banned terms（小写化）— 供本地校验器和 forbidden_terms 叠加使用 */
export function getIndustryBannedTerms(profile: IndustryProfile | null): string[] {
  if (!profile) return [];
  return profile.extraBannedTerms.map((t) => t.toLowerCase());
}
