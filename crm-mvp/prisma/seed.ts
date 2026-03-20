import "dotenv/config";
import { PrismaClient } from "../src/generated/prisma/client.js";

async function main() {
  const { PrismaMariaDb } = await import("@prisma/adapter-mariadb");
  const bcryptModule = await import("bcryptjs");
  const bcrypt = bcryptModule.default || bcryptModule;

  const adapter = new PrismaMariaDb({
    host: process.env.DB_HOST || "localhost",
    port: parseInt(process.env.DB_PORT || "3306"),
    user: process.env.DB_USER || "google-data-analysis",
    password: process.env.DB_PASSWORD || "Aa147258!",
    database: process.env.DB_NAME || "google-data-analysis",
  });

  const prisma = new PrismaClient({ adapter });

  try {
    // ─── 1. 管理员账号 ───
    const adminExists = await prisma.users.findFirst({
      where: { username: "admin", is_deleted: 0 },
    });
    if (!adminExists) {
      const hash = await bcrypt.hash("admin123", 10);
      await prisma.users.create({
        data: { username: "admin", password_hash: hash, role: "admin", status: "active" },
      });
      console.log("✓ 默认管理员已创建: admin / admin123");
    } else {
      console.log("→ 管理员账号已存在，跳过");
    }

    // ─── 2. 删除测试用户 ───
    const testUser = await prisma.users.findFirst({
      where: { username: "testuser", is_deleted: 0 },
    });
    if (testUser) {
      await prisma.users.update({
        where: { id: testUser.id },
        data: { is_deleted: 1 },
      });
      console.log("✓ 测试用户 testuser 已软删除");
    }

    // ─── 3. 批量创建用户：wj01-10, yz01-10, jy01-10 ───
    const userGroups = [
      { prefix: "wj", count: 10, password: "wj123456" },
      { prefix: "yz", count: 10, password: "yz123456" },
      { prefix: "jy", count: 10, password: "jy123456" },
    ];

    for (const group of userGroups) {
      for (let i = 1; i <= group.count; i++) {
        const username = `${group.prefix}${String(i).padStart(2, "0")}`;
        const exists = await prisma.users.findFirst({
          where: { username, is_deleted: 0 },
        });
        if (!exists) {
          const hash = await bcrypt.hash(group.password, 10);
          const user = await prisma.users.create({
            data: { username, password_hash: hash, role: "user", status: "active" },
          });
          // 自动创建关联设置
          await Promise.all([
            prisma.ad_default_settings.create({ data: { user_id: user.id } }),
            prisma.notification_preferences.create({ data: { user_id: user.id } }),
            prisma.prompt_preferences.create({ data: { user_id: user.id } }),
          ]);
          console.log(`✓ 用户已创建: ${username} / ${group.password}`);
        } else {
          console.log(`→ 用户 ${username} 已存在，跳过`);
        }
      }
    }

    // ─── 3. AI 供应商初始配置 ───
    const providerCount = await prisma.ai_providers.count({ where: { is_deleted: 0 } });
    if (providerCount === 0) {
      await prisma.ai_providers.createMany({
        data: [
          { provider_name: "OpenAI", api_key: "sk-placeholder", api_base_url: "https://api.openai.com/v1", status: "active" },
          { provider_name: "Anthropic", api_key: "sk-placeholder", api_base_url: "https://api.anthropic.com", status: "inactive" },
          { provider_name: "DeepSeek", api_key: "sk-placeholder", api_base_url: "https://api.deepseek.com", status: "inactive" },
        ],
      });
      console.log("✓ AI 供应商初始配置已创建（需要填入真实 API Key）");
    }

    // ─── 4. AI 场景模型分配 ───
    const modelCount = await prisma.ai_model_configs.count({ where: { is_deleted: 0 } });
    if (modelCount === 0) {
      const openai = await prisma.ai_providers.findFirst({ where: { provider_name: "OpenAI", is_deleted: 0 } });
      if (openai) {
        await prisma.ai_model_configs.createMany({
          data: [
            { scene: "ad_copy", provider_id: openai.id, model_name: "gpt-4o", max_tokens: 4096, temperature: 0.7, priority: 1 },
            { scene: "article", provider_id: openai.id, model_name: "gpt-4o", max_tokens: 8192, temperature: 0.8, priority: 1 },
            { scene: "data_insight", provider_id: openai.id, model_name: "gpt-4o-mini", max_tokens: 2048, temperature: 0.3, priority: 1 },
            { scene: "translate", provider_id: openai.id, model_name: "gpt-4o-mini", max_tokens: 4096, temperature: 0.2, priority: 1 },
          ],
        });
        console.log("✓ AI 场景模型分配已创建");
      }
    }

    // ─── 5. 系统配置初始值 ───
    const configCount = await prisma.system_configs.count({ where: { is_deleted: 0 } });
    if (configCount === 0) {
      await prisma.system_configs.createMany({
        data: [
          { config_key: "exchange_rate_update_interval", config_value: "86400", description: "汇率更新间隔（秒）" },
          { config_key: "crawler_concurrency", config_value: "3", description: "爬虫并发数" },
          { config_key: "crawler_timeout", config_value: "30", description: "爬虫超时时间（秒）" },
          { config_key: "crawler_min_images", config_value: "10", description: "爬虫最少图片数" },
          { config_key: "daily_data_sync_hour", config_value: "6", description: "每日数据同步时间（UTC 小时）" },
          { config_key: "ai_insight_enabled", config_value: "true", description: "是否启用 AI 洞察" },
          { config_key: "max_merchants_per_user", config_value: "500", description: "每用户最大商家数" },
          { config_key: "article_generation_timeout", config_value: "120", description: "文章生成超时（秒）" },
        ],
      });
      console.log("✓ 系统配置初始值已创建");
    }

    // ─── 6. 节日日历数据（主要商业节日） ───
    const holidayCount = await prisma.holiday_calendar.count({ where: { is_deleted: 0 } });
    if (holidayCount === 0) {
      const holidays = [
        // 美国
        { country_code: "US", holiday_name: "New Year's Day", holiday_date: new Date("2026-01-01"), holiday_type: "public" },
        { country_code: "US", holiday_name: "Valentine's Day", holiday_date: new Date("2026-02-14"), holiday_type: "commercial" },
        { country_code: "US", holiday_name: "Presidents' Day", holiday_date: new Date("2026-02-16"), holiday_type: "public" },
        { country_code: "US", holiday_name: "Easter", holiday_date: new Date("2026-04-05"), holiday_type: "religious" },
        { country_code: "US", holiday_name: "Mother's Day", holiday_date: new Date("2026-05-10"), holiday_type: "commercial" },
        { country_code: "US", holiday_name: "Memorial Day", holiday_date: new Date("2026-05-25"), holiday_type: "public" },
        { country_code: "US", holiday_name: "Father's Day", holiday_date: new Date("2026-06-21"), holiday_type: "commercial" },
        { country_code: "US", holiday_name: "Independence Day", holiday_date: new Date("2026-07-04"), holiday_type: "public" },
        { country_code: "US", holiday_name: "Labor Day", holiday_date: new Date("2026-09-07"), holiday_type: "public" },
        { country_code: "US", holiday_name: "Halloween", holiday_date: new Date("2026-10-31"), holiday_type: "commercial" },
        { country_code: "US", holiday_name: "Thanksgiving", holiday_date: new Date("2026-11-26"), holiday_type: "public" },
        { country_code: "US", holiday_name: "Black Friday", holiday_date: new Date("2026-11-27"), holiday_type: "commercial" },
        { country_code: "US", holiday_name: "Cyber Monday", holiday_date: new Date("2026-11-30"), holiday_type: "commercial" },
        { country_code: "US", holiday_name: "Christmas", holiday_date: new Date("2026-12-25"), holiday_type: "public" },
        // 英国
        { country_code: "GB", holiday_name: "New Year's Day", holiday_date: new Date("2026-01-01"), holiday_type: "public" },
        { country_code: "GB", holiday_name: "Valentine's Day", holiday_date: new Date("2026-02-14"), holiday_type: "commercial" },
        { country_code: "GB", holiday_name: "Easter Monday", holiday_date: new Date("2026-04-06"), holiday_type: "public" },
        { country_code: "GB", holiday_name: "May Day", holiday_date: new Date("2026-05-04"), holiday_type: "public" },
        { country_code: "GB", holiday_name: "Boxing Day", holiday_date: new Date("2026-12-26"), holiday_type: "commercial" },
        { country_code: "GB", holiday_name: "Christmas", holiday_date: new Date("2026-12-25"), holiday_type: "public" },
        // 澳大利亚
        { country_code: "AU", holiday_name: "Australia Day", holiday_date: new Date("2026-01-26"), holiday_type: "public" },
        { country_code: "AU", holiday_name: "EOFY Sales", holiday_date: new Date("2026-06-30"), holiday_type: "commercial" },
        { country_code: "AU", holiday_name: "Click Frenzy", holiday_date: new Date("2026-11-10"), holiday_type: "commercial" },
        { country_code: "AU", holiday_name: "Christmas", holiday_date: new Date("2026-12-25"), holiday_type: "public" },
        // 加拿大
        { country_code: "CA", holiday_name: "Canada Day", holiday_date: new Date("2026-07-01"), holiday_type: "public" },
        { country_code: "CA", holiday_name: "Thanksgiving", holiday_date: new Date("2026-10-12"), holiday_type: "public" },
        { country_code: "CA", holiday_name: "Boxing Day", holiday_date: new Date("2026-12-26"), holiday_type: "commercial" },
        // 德国
        { country_code: "DE", holiday_name: "Neujahr", holiday_date: new Date("2026-01-01"), holiday_type: "public" },
        { country_code: "DE", holiday_name: "Ostern", holiday_date: new Date("2026-04-05"), holiday_type: "religious" },
        { country_code: "DE", holiday_name: "Tag der Deutschen Einheit", holiday_date: new Date("2026-10-03"), holiday_type: "public" },
        { country_code: "DE", holiday_name: "Weihnachten", holiday_date: new Date("2026-12-25"), holiday_type: "public" },
        // 法国
        { country_code: "FR", holiday_name: "Jour de l'An", holiday_date: new Date("2026-01-01"), holiday_type: "public" },
        { country_code: "FR", holiday_name: "Fête Nationale", holiday_date: new Date("2026-07-14"), holiday_type: "public" },
        { country_code: "FR", holiday_name: "Soldes d'été", holiday_date: new Date("2026-06-24"), holiday_type: "commercial" },
        { country_code: "FR", holiday_name: "Noël", holiday_date: new Date("2026-12-25"), holiday_type: "public" },
      ];

      await prisma.holiday_calendar.createMany({ data: holidays });
      console.log(`✓ 节日日历已创建 (${holidays.length} 条)`);
    }

    // ─── 7. Google Ads 政策限制类别预置数据 ───
    const policyCount = await prisma.ad_policy_categories.count({ where: { is_deleted: 0 } });
    if (policyCount === 0) {
      await prisma.ad_policy_categories.createMany({
        data: [
          {
            category_code: "alcohol",
            category_name: "酒精类",
            category_name_en: "Alcohol",
            restriction_level: "restricted",
            description: "酒精饮料广告可以投放，但必须遵守当地法律法规，不得面向未成年人，不得鼓励过度饮酒。",
            allowed_regions: JSON.stringify(["US","GB","AU","CA","DE","FR","JP","NZ","IE"]),
            blocked_regions: JSON.stringify(["SA","KW","QA","BH","AE","PK","BD","LY"]),
            age_targeting: "21+",
            requires_cert: 0,
            ad_copy_rules: JSON.stringify({
              must_include_disclaimers: ["Drink Responsibly.", "Must be of legal drinking age."],
              forbidden_phrases: ["get drunk","unlimited drinks","binge drinking","drink all you want","促进过度饮酒","未成年人饮酒"],
              tone_restrictions: ["不能使用 urgent(紧迫促销) 风格","不能暗示饮酒带来社会或性方面的成功","不能将饮酒与驾驶关联"],
              headline_rules: "标题中不能直接鼓励购买酒精饮品，需强调品质、产地、工艺或品鉴体验",
              description_rules: "描述中必须包含至少一条免责声明，不能使用夸张的促销语言"
            }),
            landing_page_rules: JSON.stringify({
              requires_age_gate: true,
              age_gate_type: "21+",
              url_params: { policy_gate: "alcohol", age_verify: "true" },
              required_elements: ["年龄验证弹窗/页面","法律免责声明"]
            }),
            match_keywords: JSON.stringify(["alcohol","wine","beer","liquor","spirits","brewery","distillery","champagne","whiskey","vodka","rum","tequila","cocktail","bourbon","cognac","brandy","sake","cider","mead","pub","bar supply","winery"]),
            match_domains: JSON.stringify(["wine.com","totalwine.com","drizly.com","minibar.com","vivino.com","masterofmalt.com","thewhiskyexchange.com","beer.com"]),
            sort_order: 1,
          },
          {
            category_code: "gambling",
            category_name: "赌博类",
            category_name_en: "Gambling",
            restriction_level: "restricted",
            description: "在线赌博和博彩广告需要 Google 认证，且仅限特定国家/地区投放。",
            allowed_regions: JSON.stringify(["GB","IE","FR","DE","IT","ES","AU","NZ","CA"]),
            blocked_regions: JSON.stringify(["US","CN","JP","KR","IN","SA","AE"]),
            age_targeting: "18+",
            requires_cert: 1,
            ad_copy_rules: JSON.stringify({
              must_include_disclaimers: ["Gamble Responsibly.","18+ only.","BeGambleAware.org"],
              forbidden_phrases: ["guaranteed win","risk-free","no-lose","sure bet","必赢","稳赚"],
              tone_restrictions: ["不能暗示赌博是致富途径","不能淡化赌博风险","不能面向未成年人"],
              headline_rules: "标题不能承诺赢利或暗示无风险",
              description_rules: "必须包含负责任赌博声明和年龄限制"
            }),
            landing_page_rules: JSON.stringify({
              requires_age_gate: true,
              age_gate_type: "18+",
              url_params: { policy_gate: "gambling", age_verify: "true" },
              required_elements: ["年龄验证","负责任赌博声明","自我排除链接"]
            }),
            match_keywords: JSON.stringify(["casino","betting","poker","lottery","gambling","slots","wager","sportsbook","bingo","roulette","blackjack","bookmaker","odds","jackpot"]),
            match_domains: JSON.stringify(["bet365.com","pokerstars.com","888casino.com","williamhill.com","ladbrokes.com","betfair.com","draftkings.com","fanduel.com"]),
            sort_order: 2,
          },
          {
            category_code: "healthcare",
            category_name: "医疗保健",
            category_name_en: "Healthcare & Medicines",
            restriction_level: "restricted",
            description: "处方药、医疗器械、在线药房等需要 Google 认证。非处方保健品有文案限制。",
            requires_cert: 1,
            ad_copy_rules: JSON.stringify({
              must_include_disclaimers: ["Consult your healthcare provider."],
              forbidden_phrases: ["cure","miracle","guaranteed results","100% effective","根治","神药","包治百病"],
              tone_restrictions: ["不能做出未经证实的医疗声明","不能承诺治愈效果","不能使用恐吓性语言"],
              headline_rules: "不能声称产品可以治愈疾病，需使用'支持''辅助'等措辞",
              description_rules: "必须建议咨询医疗专业人士，不能替代医疗建议"
            }),
            landing_page_rules: JSON.stringify({
              requires_age_gate: false,
              url_params: { policy_gate: "healthcare" },
              required_elements: ["医疗免责声明","建议咨询医生"]
            }),
            match_keywords: JSON.stringify(["pharmacy","prescription","medication","supplement","cbd","hemp oil","medical device","drug store","health supplement","vitamin","nutraceutical","probiotic","testosterone","steroid"]),
            match_domains: JSON.stringify(["cvs.com","walgreens.com","riteaid.com","healthline.com"]),
            sort_order: 3,
          },
          {
            category_code: "financial",
            category_name: "金融服务",
            category_name_en: "Financial Services",
            restriction_level: "restricted",
            description: "贷款、信用卡、加密货币、外汇交易等金融产品广告有严格的披露要求。",
            age_targeting: "18+",
            requires_cert: 0,
            ad_copy_rules: JSON.stringify({
              must_include_disclaimers: ["Terms and conditions apply.","Capital at risk."],
              forbidden_phrases: ["guaranteed returns","risk-free investment","get rich quick","稳赚不赔","零风险"],
              tone_restrictions: ["不能承诺投资回报","必须披露风险","不能淡化金融风险"],
              headline_rules: "不能承诺具体收益率或暗示无风险",
              description_rules: "必须包含风险提示和条款声明"
            }),
            landing_page_rules: JSON.stringify({
              requires_age_gate: false,
              url_params: { policy_gate: "financial" },
              required_elements: ["风险披露声明","费率和条款","监管信息"]
            }),
            match_keywords: JSON.stringify(["loan","credit","mortgage","payday loan","crypto","forex","trading","investment","binary option","CFD","spread betting","personal loan","debt","refinance","bitcoin exchange"]),
            match_domains: JSON.stringify(["coinbase.com","binance.com","etoro.com","robinhood.com","lending.com"]),
            sort_order: 4,
          },
          {
            category_code: "adult",
            category_name: "成人内容",
            category_name_en: "Adult Content",
            restriction_level: "restricted",
            description: "成人导向内容（如内衣、约会网站）可有限投放，但不得包含露骨色情内容。",
            blocked_regions: JSON.stringify(["SA","IR","PK","BD","AE","QA","KW"]),
            age_targeting: "18+",
            requires_cert: 0,
            ad_copy_rules: JSON.stringify({
              must_include_disclaimers: ["18+ only."],
              forbidden_phrases: ["explicit","pornographic","nude","naked","xxx","色情","裸体"],
              tone_restrictions: ["不能包含露骨性暗示","不能使用色情语言","图片不能包含裸露"],
              headline_rules: "标题必须保持适度，不能包含露骨性暗示",
              description_rules: "描述需保持品味，强调产品功能而非性暗示"
            }),
            landing_page_rules: JSON.stringify({
              requires_age_gate: true,
              age_gate_type: "18+",
              url_params: { policy_gate: "adult", age_verify: "true" },
              required_elements: ["年龄验证"]
            }),
            match_keywords: JSON.stringify(["adult","lingerie","sex toy","dating","escort","strip","erotic","intimate","pleasure","fetish","bondage"]),
            match_domains: JSON.stringify(["victoriassecret.com","adammale.com","lovehoney.com"]),
            sort_order: 5,
          },
          {
            category_code: "weapons",
            category_name: "武器及管制刀具",
            category_name_en: "Weapons & Knives",
            restriction_level: "prohibited",
            description: "Google Ads 禁止推广枪支、弹药、爆炸物、管制刀具等武器类产品。",
            requires_cert: 0,
            ad_copy_rules: JSON.stringify({
              forbidden_phrases: ["buy guns","purchase firearms","ammunition for sale","武器出售","枪支"],
              headline_rules: "禁止投放 — 不生成广告文案",
              description_rules: "禁止投放 — 不生成广告文案"
            }),
            landing_page_rules: undefined,
            match_keywords: JSON.stringify(["gun","firearm","ammunition","weapon","sword","tactical knife","combat knife","switchblade","brass knuckles","stun gun","pepper spray","crossbow","airsoft gun","BB gun","hunting rifle"]),
            match_domains: JSON.stringify(["gunbroker.com","budsgunshop.com","palmettostatearmory.com","brownells.com"]),
            sort_order: 6,
          },
          {
            category_code: "cannabis",
            category_name: "大麻类",
            category_name_en: "Cannabis & Marijuana",
            restriction_level: "prohibited",
            description: "Google Ads 全面禁止大麻及相关产品（包括 THC 产品）的广告投放。CBD 产品在部分地区有限制。",
            requires_cert: 0,
            ad_copy_rules: JSON.stringify({
              forbidden_phrases: ["buy weed","marijuana for sale","THC","cannabis delivery","大麻","毒品"],
              headline_rules: "禁止投放 — 不生成广告文案",
              description_rules: "禁止投放 — 不生成广告文案"
            }),
            landing_page_rules: undefined,
            match_keywords: JSON.stringify(["cannabis","marijuana","weed","thc","hemp","dispensary","edibles","dab","vaporizer cannabis","pot","ganja","hash","kush"]),
            match_domains: JSON.stringify(["leafly.com","weedmaps.com","eaze.com"]),
            sort_order: 7,
          },
          {
            category_code: "tobacco",
            category_name: "烟草类",
            category_name_en: "Tobacco & Vaping",
            restriction_level: "prohibited",
            description: "Google Ads 禁止推广烟草产品、电子烟、尼古丁产品。",
            requires_cert: 0,
            ad_copy_rules: JSON.stringify({
              forbidden_phrases: ["buy cigarettes","vape juice","nicotine","e-liquid","香烟","电子烟","尼古丁"],
              headline_rules: "禁止投放 — 不生成广告文案",
              description_rules: "禁止投放 — 不生成广告文案"
            }),
            landing_page_rules: undefined,
            match_keywords: JSON.stringify(["tobacco","cigarette","vape","e-cigarette","nicotine","smoking","cigar","hookah","shisha","snuff","chewing tobacco","e-liquid","vape juice","mod kit","pod system"]),
            match_domains: JSON.stringify(["juul.com","blu.com","vaporfi.com"]),
            sort_order: 8,
          },
        ],
      });
      console.log("✓ Google Ads 政策限制类别已创建 (8 个类别)");
    } else {
      console.log(`→ 政策限制类别已存在 (${policyCount} 条)，跳过`);
    }

    console.log("\n✅ 种子数据初始化完成！");
  } finally {
    await prisma.$disconnect();
  }
}

main().catch(console.error);
