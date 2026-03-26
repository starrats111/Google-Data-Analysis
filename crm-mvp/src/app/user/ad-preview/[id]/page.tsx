"use client";
import { useState, useEffect, useCallback } from "react";
import { useParams, useRouter } from "next/navigation";
import {
  Card, Row, Col, Input, Button, Space, Tag, Typography, Spin, Alert,
  Select, InputNumber, Switch, Divider, App, Tooltip, Popconfirm, Checkbox,
  Upload, Image,
} from "antd";
import {
  ThunderboltOutlined, LoadingOutlined,
  DeleteOutlined, PlusOutlined, EditOutlined, RocketOutlined,
  ArrowLeftOutlined, ReloadOutlined, LinkOutlined, PictureOutlined,
  SoundOutlined, CheckCircleOutlined, ExclamationCircleOutlined,
  InboxOutlined, WarningOutlined, TranslationOutlined,
  PhoneOutlined, DollarOutlined, TagOutlined, UnorderedListOutlined,
} from "@ant-design/icons";
import { useApiWithParams, mutateApi } from "@/lib/swr";
import { BIDDING_STRATEGIES } from "@/lib/constants";
import { getAdMarketConfig, getCurrencyCodeByCountry, getLanguageCodeByCountry, getSnippetHeaderByCountry } from "@/lib/ad-market";

const CURRENCY_OPTIONS = ["USD", "EUR", "GBP", "CAD", "AUD", "CHF", "BRL", "JPY"];

const { Title, Text } = Typography;
const { TextArea } = Input;

const HEADLINE_MAX = 30;
const DESC_MAX = 90;
const SITELINK_TITLE_MAX = 25;
const SITELINK_DESC_MAX = 35;
const CALLOUT_MAX = 25;
const IMAGE_FALLBACK = "data:image/svg+xml;base64,PHN2ZyB3aWR0aD0iODAiIGhlaWdodD0iODAiIHhtbG5zPSJodHRwOi8vd3d3LnczLm9yZy8yMDAwL3N2ZyI+PHJlY3Qgd2lkdGg9IjgwIiBoZWlnaHQ9IjgwIiBmaWxsPSIjZjVmNWY1Ii8+PHRleHQgeD0iNDAiIHk9IjQ0IiB0ZXh0LWFuY2hvcj0ibWlkZGxlIiBmaWxsPSIjYmZiZmJmIiBmb250LXNpemU9IjEyIj7ml6Dms5XliqDovb08L3RleHQ+PC9zdmc+";

function formatCid(cid: string): string {
  const digits = cid.replace(/\D/g, "");
  if (digits.length === 10) return `${digits.slice(0, 3)}-${digits.slice(3, 6)}-${digits.slice(6)}`;
  return cid;
}

// Google Ads 支持的语言列表
const GOOGLE_ADS_LANGUAGES = [
  { code: "en", name: "English" }, { code: "fr", name: "Français" },
  { code: "de", name: "Deutsch" }, { code: "es", name: "Español" },
  { code: "it", name: "Italiano" }, { code: "pt", name: "Português" },
  { code: "nl", name: "Nederlands" }, { code: "ja", name: "日本語" },
  { code: "ko", name: "한국어" }, { code: "zh_CN", name: "中文(简体)" },
  { code: "zh_TW", name: "中文(繁體)" }, { code: "ru", name: "Русский" },
  { code: "pl", name: "Polski" }, { code: "sv", name: "Svenska" },
  { code: "no", name: "Norsk" }, { code: "da", name: "Dansk" },
  { code: "fi", name: "Suomi" }, { code: "cs", name: "Čeština" },
  { code: "tr", name: "Türkçe" }, { code: "th", name: "ไทย" },
  { code: "vi", name: "Tiếng Việt" }, { code: "id", name: "Bahasa Indonesia" },
  { code: "ms", name: "Bahasa Melayu" }, { code: "ar", name: "العربية" },
  { code: "iw", name: "עברית" }, { code: "el", name: "Ελληνικά" },
  { code: "ro", name: "Română" }, { code: "hu", name: "Magyar" },
  { code: "bg", name: "Български" }, { code: "hi", name: "हिन्दी" },
  { code: "uk", name: "Українська" },
];

interface SitelinkItem {
  title: string;
  desc1: string;
  desc2: string;
  url: string;
  urlStatus?: "valid" | "invalid" | "checking" | "";
}

interface KeywordItem {
  id?: string;
  text: string;
  matchType: string;
  score?: number | null;
  reason?: string;
  avgMonthlySearches?: number | null;
  competition?: string | null;
  suggestedBid?: number | null;
  competitionBand?: string;
}

interface AdPreviewData {
  campaign: any;
  adGroup: any;
  adCreative: any;
  keywords: Array<{
    id: string;
    keyword_text: string;
    match_type: string;
    score?: number;
    reason?: string;
    avg_monthly_searches?: number | null;
    competition?: string | null;
    suggested_bid?: number | null;
    competition_band?: string;
    recommended_match_type?: string;
  }>;
  adSettings: any;
  merchant: any;
  mccAccounts?: { id: string | number; [key: string]: any }[];
  isReady: boolean;
}

function normalizeSitelinkItems(items: unknown): SitelinkItem[] {
  if (!Array.isArray(items)) return [];
  return items
    .map((item) => {
      const record = (item ?? {}) as Record<string, unknown>;
      const title = String(record.title || "").trim();
      const desc1 = String(record.desc1 || record.description1 || "").trim();
      const desc2 = String(record.desc2 || record.description2 || "").trim();
      const url = String(record.url || record.finalUrl || "").trim();
      return {
        title,
        desc1,
        desc2,
        url,
        urlStatus: url ? "valid" as const : "",
      };
    })
    .filter((item) => item.title || item.desc1 || item.desc2 || item.url);
}

function normalizeImageUrls(items: unknown): string[] {
  if (!Array.isArray(items)) return [];
  return Array.from(new Set(
    items
      .map((item) => String(item || "").trim())
      .filter((url) => url.startsWith("http")),
  ));
}

export default function AdPreviewPage() {
  const params = useParams();
  const router = useRouter();
  const { message } = App.useApp();
  const campaignId = params.id as string;

  // 核心编辑状态
  const [headlines, setHeadlines] = useState<string[]>([]);
  const [descriptions, setDescriptions] = useState<string[]>([]);
  const [kwList, setKwList] = useState<KeywordItem[]>([]);
  const [newKeyword, setNewKeyword] = useState("");
  const [budget, setBudget] = useState(2);
  const [maxCpc, setMaxCpc] = useState(0.3);
  const [biddingStrategy, setBiddingStrategy] = useState("MAXIMIZE_CLICKS");
  const [networkSearch, setNetworkSearch] = useState(true);
  const [networkPartners, setNetworkPartners] = useState(false);
  const [networkDisplay, setNetworkDisplay] = useState(false);
  const [adLanguage, setAdLanguage] = useState("");
  const [euPoliticalAd, setEuPoliticalAd] = useState(0);
  const [submitting, setSubmitting] = useState(false);
  const [initialized, setInitialized] = useState(false);

  // MCC / CID 选择
  const [selectedMccId, setSelectedMccId] = useState<string>("");
  const [selectedCid, setSelectedCid] = useState<string>("");
  const [cidList, setCidList] = useState<{ customer_id: string; customer_name: string; is_available: string }[]>([]);
  const [cidLoading, setCidLoading] = useState(false);
  const [cidSyncing, setCidSyncing] = useState(false);

  // 扩展模块
  const [sitelinks, setSitelinks] = useState<SitelinkItem[]>([]);
  const [sitelinksLoading, setSitelinksLoading] = useState(false);
  const [imageUrls, setImageUrls] = useState<string[]>([]);
  const [crawledImages, setCrawledImages] = useState<string[]>([]);
  const [newImageUrl, setNewImageUrl] = useState("");
  const [imagesLoading, setImagesLoading] = useState(false);
  const [enableCallouts, setEnableCallouts] = useState(false);
  const [callouts, setCallouts] = useState<string[]>([]);
  const [calloutsLoading, setCalloutsLoading] = useState(false);
  const [crawlFailed, setCrawlFailed] = useState(false);

  // 促销扩展
  const [enablePromotion, setEnablePromotion] = useState(false);
  const [promotionLoading, setPromotionLoading] = useState(false);
  const [promotion, setPromotion] = useState<{
    occasion?: string; language_code?: string; promotion_target: string;
    discount_type: "MONETARY" | "PERCENT"; discount_amount?: number; discount_percent?: number;
    currency_code?: string; promo_code?: string; final_url?: string;
  }>({
    promotion_target: "", discount_type: "PERCENT", discount_percent: 10,
    currency_code: "USD", language_code: "en", final_url: "",
  });

  // 价格扩展
  const [enablePrice, setEnablePrice] = useState(false);
  const [priceLoading, setPriceLoading] = useState(false);
  const [priceType, setPriceType] = useState("BRANDS");
  const [priceItems, setPriceItems] = useState<{
    header: string; description: string; price_amount: number; currency_code: string; unit?: string; final_url: string;
  }[]>([]);

  // 致电扩展
  const [enableCall, setEnableCall] = useState(false);
  const [callLoading, setCallLoading] = useState(false);
  const [callCountryCode, setCallCountryCode] = useState("US");
  const [callPhoneNumber, setCallPhoneNumber] = useState("");

  // 结构化摘要
  const [enableSnippet, setEnableSnippet] = useState(false);
  const [snippetLoading, setSnippetLoading] = useState(false);
  const [snippetHeader, setSnippetHeader] = useState("Brands");
  const [snippetValues, setSnippetValues] = useState<string[]>(["", "", ""]);

  // 中文参考翻译（只读）
  const [headlinesZh, setHeadlinesZh] = useState<string[]>([]);
  const [descriptionsZh, setDescriptionsZh] = useState<string[]>([]);
  const [calloutsZh, setCalloutsZh] = useState<string[]>([]);
  const [sitelinksZh, setSitelinksZh] = useState<{ title: string; desc1: string; desc2: string }[]>([]);

  // 翻译
  const [translating, setTranslating] = useState(false);

  // AI 生成标题/描述
  const [generatingHeadlines, setGeneratingHeadlines] = useState(false);
  const [generatingDescriptions, setGeneratingDescriptions] = useState(false);

  // 关键词获取
  const [kwFetching, setKwFetching] = useState(false);
  const [semrushFailed, setSemrushFailed] = useState(false);
  const [semrushUrl, setSemrushUrl] = useState("");
  const [semrushUrlFetching, setSemrushUrlFetching] = useState(false);

  // 轮询获取数据 — 就绪后停止
  const { data: preview, isLoading, mutate } = useApiWithParams<AdPreviewData>(
    "/api/user/ad-creation/status",
    { campaign_id: campaignId },
    { refreshInterval: initialized ? 0 : 5000 },
  );
  const isReady = preview?.isReady ?? false;
  const targetCountry = String(preview?.campaign?.target_country || "US").toUpperCase();
  const market = getAdMarketConfig(targetCountry);
  const currencyOptions = Array.from(new Set([market.currencyCode, ...CURRENCY_OPTIONS])).map((value) => ({ value, label: value }));
  const defaultCurrencyCode = getCurrencyCodeByCountry(targetCountry);
  const defaultLanguageCode = getLanguageCodeByCountry(targetCountry);
  const defaultSnippetHeader = getSnippetHeaderByCountry(targetCountry);

  // 数据就绪后初始化编辑状态
  useEffect(() => {
    if (!preview || initialized || !isReady) return;
    const h = Array.isArray(preview.adCreative?.headlines) ? preview.adCreative.headlines : [];
    const d = Array.isArray(preview.adCreative?.descriptions) ? preview.adCreative.descriptions : [];
    setHeadlines(h.length >= 15 ? h.slice(0, 15) : [...h, ...Array(15 - h.length).fill("")]);
    setDescriptions(d.length >= 4 ? d.slice(0, 4) : [...d, ...Array(4 - d.length).fill("")]);
    setHeadlinesZh(preview.adCreative?.headlines_zh || []);
    setDescriptionsZh(preview.adCreative?.descriptions_zh || []);
    setKwList((preview.keywords || []).map((k: any) => ({
      id: k.id,
      text: k.keyword_text,
      matchType: k.match_type,
      score: k.score ?? null,
      reason: k.reason || "",
      avgMonthlySearches: k.avg_monthly_searches ?? null,
      competition: k.competition ?? null,
      suggestedBid: k.suggested_bid != null ? Number(k.suggested_bid) : null,
      competitionBand: k.competition_band || "",
    })));
    const c = preview.campaign;
    const s = preview.adSettings;
    const marketCfg = getAdMarketConfig((c?.target_country || "US").toUpperCase());
    setBudget(Number(c?.daily_budget || s?.daily_budget || 2));
    setMaxCpc(Number(c?.max_cpc_limit || s?.max_cpc || 0.3));
    setBiddingStrategy(c?.bidding_strategy || s?.bidding_strategy || "MAXIMIZE_CLICKS");
    setNetworkSearch(c?.network_search === 1 || s?.network_search === 1);
    setNetworkPartners(c?.network_partners === 1 || s?.network_partners === 1);
    setNetworkDisplay(c?.network_display === 1 || s?.network_display === 1);
    // 初始化广告语言：优先用后端根据国家自动设置的 language_id，兜底按国家推断
    const savedLang = c?.language_id || "";
    if (savedLang) {
      setAdLanguage(savedLang);
    } else {
      const country = (c?.target_country || "").toUpperCase();
      setAdLanguage(getLanguageCodeByCountry(country) || "en");
    }
    setPromotion((prev) => ({
      ...prev,
      currency_code: marketCfg.currencyCode,
      language_code: marketCfg.promotionLanguageCode,
    }));
    setCallCountryCode((c?.target_country || "US").toUpperCase());
    setSnippetHeader(marketCfg.snippetHeader);
    // 初始化 EU 政治广告设置
    setEuPoliticalAd(s?.eu_political_ad ?? 0);
    // 初始化 MCC/CID
    if (preview.campaign?.mcc_id) {
      setSelectedMccId(String(preview.campaign.mcc_id));
    } else if ((preview.mccAccounts?.length ?? 0) > 0) {
      setSelectedMccId(String(preview.mccAccounts![0].id));
    }
    if (preview.campaign?.customer_id) {
      setSelectedCid(preview.campaign.customer_id);
    }
    // 初始化已有扩展数据
    const existingSitelinks = normalizeSitelinkItems(preview.adCreative?.sitelinks);
    if (existingSitelinks.length > 0) {
      setSitelinks(existingSitelinks);
    }
    const existingCallouts = preview.adCreative?.callouts as string[] | null;
    if (existingCallouts?.length) {
      setEnableCallouts(true);
      setCallouts(existingCallouts);
    }
    const existingImages = normalizeImageUrls(preview.adCreative?.image_urls);
    if (existingImages.length > 0) {
      setCrawledImages(existingImages);
      setImageUrls(existingImages);
    }
    setInitialized(true);

    // 站内链接和图片默认自动触发
    if (existingSitelinks.length === 0) {
      setTimeout(() => generateExtension("sitelinks"), 100);
    }
    if (existingImages.length === 0) {
      setTimeout(() => generateExtension("images"), 200);
    }
  }, [preview, isReady, initialized]);

  // ─── 生成中文翻译（仅参考，不影响广告内容） ───
  const generateZhTranslation = useCallback(async () => {
    const validH = headlines.filter((h) => h.trim().length > 0);
    const validD = descriptions.filter((d) => d.trim().length > 0);
    const validC = enableCallouts ? callouts.filter((c) => c.trim().length > 0) : [];
    const validS = sitelinks.filter((s) => s.title.trim().length > 0).map((s) => ({
      title: s.title, desc1: s.desc1, desc2: s.desc2,
    }));
    if (validH.length === 0 && validD.length === 0 && validC.length === 0 && validS.length === 0) {
      message.warning("没有需要翻译的内容");
      return;
    }
    setTranslating(true);
    try {
      const res = await fetch("/api/user/ad-creation/translate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          headlines: validH,
          descriptions: validD,
          callouts: validC,
          sitelinks: validS,
          target_country: "CN",
          merchant_name: preview?.merchant?.merchant_name,
        }),
      });
      const json = await res.json();
      if (json.code === 0) {
        if (json.data.headlines?.length > 0) setHeadlinesZh(json.data.headlines);
        if (json.data.descriptions?.length > 0) setDescriptionsZh(json.data.descriptions);
        if (json.data.callouts?.length > 0) setCalloutsZh(json.data.callouts);
        if (json.data.sitelinks?.length > 0) setSitelinksZh(json.data.sitelinks);
        message.success("中文翻译已更新");
      } else {
        message.error(json.message || "翻译失败");
      }
    } catch (err: any) {
      message.error(err?.message || "翻译失败");
    } finally {
      setTranslating(false);
    }
  }, [headlines, descriptions, callouts, enableCallouts, sitelinks, preview, message]);

  // ─── 标题/描述操作 ───
  const updateHeadline = (idx: number, val: string) => {
    setHeadlines((prev) => { const n = [...prev]; n[idx] = val; return n; });
  };
  const removeHeadline = (idx: number) => setHeadlines((prev) => prev.filter((_, i) => i !== idx));
  const addHeadline = () => { if (headlines.length < 15) setHeadlines((prev) => [...prev, ""]); };
  const updateDescription = (idx: number, val: string) => {
    setDescriptions((prev) => { const n = [...prev]; n[idx] = val; return n; });
  };
  const removeDescription = (idx: number) => setDescriptions((prev) => prev.filter((_, i) => i !== idx));
  const addDescription = () => { if (descriptions.length < 4) setDescriptions((prev) => [...prev, ""]); };

  // ─── AI 生成更多标题 ───
  const aiGenerateHeadlines = useCallback(async () => {
    if (headlines.length >= 15) { message.warning("标题已满 15 条"); return; }
    setGeneratingHeadlines(true);
    try {
      const res = await fetch("/api/user/ad-creation/generate-more", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          type: "headlines",
          existing: headlines.filter((h) => h.trim()),
          merchant_name: preview?.merchant?.merchant_name || "",
          country: preview?.campaign?.target_country || "US",
          keywords: kwList.map((kw) => kw.text).filter(Boolean),
          daily_budget: budget,
          max_cpc: maxCpc,
          bidding_strategy: biddingStrategy,
          count: 15,
        }),
      });
      const json = await res.json();
      if (json.code === 0 && json.data?.items?.length > 0) {
        const maxAdd = 15 - headlines.length;
        const toAdd = json.data.items.slice(0, maxAdd);
        setHeadlines((prev) => [...prev, ...toAdd]);
        message.success(`AI 已生成 ${toAdd.length} 条标题`);
      } else {
        message.warning(json.message || "AI 生成失败，请手动输入");
        if (headlines.length < 15) setHeadlines((prev) => [...prev, ""]);
      }
    } catch {
      message.warning("AI 生成失败，请手动输入");
      if (headlines.length < 15) setHeadlines((prev) => [...prev, ""]);
    } finally {
      setGeneratingHeadlines(false);
    }
  }, [headlines, preview, message, kwList, budget, maxCpc, biddingStrategy]);

  // ─── AI 生成更多描述（与当前标题差异化，贴合 Google「描述更独特」）───
  const aiGenerateDescriptions = useCallback(async () => {
    if (descriptions.length >= 4) { message.warning("描述已满 4 条"); return; }
    setGeneratingDescriptions(true);
    try {
      const res = await fetch("/api/user/ad-creation/generate-more", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          type: "descriptions",
          existing: descriptions.filter((d) => d.trim()),
          merchant_name: preview?.merchant?.merchant_name || "",
          country: preview?.campaign?.target_country || "US",
          keywords: kwList.map((kw) => kw.text).filter(Boolean),
          headlines_for_uniqueness: headlines.filter((h) => h.trim()),
          daily_budget: budget,
          max_cpc: maxCpc,
          bidding_strategy: biddingStrategy,
          count: 4,
        }),
      });
      const json = await res.json();
      if (json.code === 0 && json.data?.items?.length > 0) {
        const maxAdd = 4 - descriptions.length;
        const toAdd = json.data.items.slice(0, maxAdd);
        setDescriptions((prev) => [...prev, ...toAdd]);
        message.success(`AI 已生成 ${toAdd.length} 条描述`);
      } else {
        message.warning(json.message || "AI 生成失败，请手动输入");
        if (descriptions.length < 4) setDescriptions((prev) => [...prev, ""]);
      }
    } catch {
      message.warning("AI 生成失败，请手动输入");
      if (descriptions.length < 4) setDescriptions((prev) => [...prev, ""]);
    } finally {
      setGeneratingDescriptions(false);
    }
  }, [descriptions, headlines, preview, message, kwList, budget, maxCpc, biddingStrategy]);

  // ─── 关键词操作 ───
  const [newKwMatchType, setNewKwMatchType] = useState<string>("PHRASE");
  const addKeyword = () => {
    if (newKeyword.trim()) {
      setKwList((prev) => [...prev, { text: newKeyword.trim(), matchType: newKwMatchType }]);
      setNewKeyword("");
    }
  };
  const removeKeyword = (idx: number) => setKwList((prev) => prev.filter((_, i) => i !== idx));
  const updateKeywordMatchType = (idx: number, matchType: string) => {
    setKwList((prev) => { const n = [...prev]; n[idx] = { ...n[idx], matchType }; return n; });
  };

  // ─── SemRush 关键词合并（去重+映射） ───
  const mergeSemrushKeywords = (rawKws: any[], existingList: typeof kwList) => {
    const existing = new Set(existingList.map((k) => k.text.toLowerCase()));
    return rawKws
      .filter((kw: any) => !existing.has((kw.phrase || "").toLowerCase()))
      .map((kw: any) => ({
        text: kw.phrase,
        matchType: kw.recommended_match_type || kw.match_type || "PHRASE",
        score: kw.score ?? null,
        reason: kw.reason || "",
        avgMonthlySearches: kw.volume ?? kw.avg_monthly_searches ?? null,
        competition: kw.competition != null ? String(kw.competition) : null,
        suggestedBid: kw.suggested_bid != null ? Number(kw.suggested_bid) : kw.cpc != null ? Number(kw.cpc) : null,
        competitionBand: kw.competition_band || "",
      }));
  };

  // ─── SemRush 关键词获取 ───
  const fetchKeywordsFromSemrush = useCallback(async () => {
    const merchantUrl = preview?.merchant?.merchant_url;
    const country = preview?.campaign?.target_country || "US";
    if (!merchantUrl) { message.error("商家 URL 缺失，无法获取关键词"); return; }
    setKwFetching(true);
    try {
      const res = await fetch("/api/user/ad-creation/semrush", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          merchant_url: merchantUrl,
          merchant_name: preview?.merchant?.merchant_name || "",
          country,
          daily_budget: budget,
          max_cpc: maxCpc,
          bidding_strategy: biddingStrategy,
        }),
      });
      const json = await res.json();
      if (json.code !== 0) {
        setSemrushFailed(true);
        message.error({ content: json.message || "SemRush 自动获取失败，可粘贴 3UE 链接手动获取", duration: 6 });
        return;
      }
      setSemrushFailed(false);
      const kws = json.data?.keywords || [];
      if (kws.length === 0) { message.warning("SemRush 未找到该商家的关键词，请手动输入"); return; }
      const newKws = mergeSemrushKeywords(kws, kwList);
      if (newKws.length > 0) {
        setKwList((prev) => [...prev, ...newKws]);
        message.success(`已从 SemRush 获取 ${newKws.length} 个关键词`);
      } else {
        message.info("SemRush 关键词已全部存在");
      }
    } catch (err: any) {
      setSemrushFailed(true);
      message.error({ content: err?.message || "关键词获取失败，可粘贴 3UE 链接手动获取", duration: 6 });
    } finally {
      setKwFetching(false);
    }
  }, [preview, kwList, message, budget, maxCpc, biddingStrategy]);

  // ─── 通过 3UE 链接获取关键词 ───
  const fetchKeywordsFromUrl = useCallback(async () => {
    if (!semrushUrl.trim()) { message.warning("请粘贴 3UE SemRush 链接"); return; }
    const country = preview?.campaign?.target_country || "US";
    setSemrushUrlFetching(true);
    try {
      const res = await fetch("/api/user/ad-creation/semrush-url", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          url: semrushUrl.trim(),
          merchant_name: preview?.merchant?.merchant_name || "",
          country,
          daily_budget: budget,
          max_cpc: maxCpc,
          bidding_strategy: biddingStrategy,
        }),
      });
      const json = await res.json();
      if (json.code !== 0) { message.error({ content: json.message || "获取失败", duration: 6 }); return; }
      const kws = json.data?.keywords || [];
      if (kws.length === 0) { message.warning("未从该链接获取到关键词，请手动输入"); return; }
      const newKws = mergeSemrushKeywords(kws, kwList);
      if (newKws.length > 0) {
        setKwList((prev) => [...prev, ...newKws]);
        setSemrushFailed(false);
        setSemrushUrl("");
        message.success(`已从链接获取 ${newKws.length} 个关键词`);
      } else {
        message.info("关键词已全部存在");
      }
    } catch (err: any) {
      message.error({ content: err?.message || "获取失败，请手动输入关键词", duration: 6 });
    } finally {
      setSemrushUrlFetching(false);
    }
  }, [semrushUrl, preview, kwList, message, budget, maxCpc, biddingStrategy]);

  // ─── MCC/CID 操作 ───
  const loadCidList = useCallback(async (mccAccountId: string) => {
    if (!mccAccountId) { setCidList([]); return; }
    setCidLoading(true);
    try {
      const res = await fetch(`/api/user/data-center/cids?mcc_account_id=${mccAccountId}`);
      const json = await res.json();
      if (json.code === 0 && Array.isArray(json.data)) {
        setCidList(json.data);
        // 如果当前没有选中的 CID 或选中的不在列表中，自动选第一个可用的
        if (json.data.length > 0) {
          const current = json.data.find((c: any) => c.customer_id === selectedCid);
          if (!current) {
            const available = json.data.find((c: any) => c.is_available === "Y");
            if (available) setSelectedCid(available.customer_id);
          }
        }
      }
    } catch { /* ignore */ }
    finally { setCidLoading(false); }
  }, [selectedCid]);

  // MCC 变更时加载 CID 列表
  useEffect(() => {
    if (selectedMccId) loadCidList(selectedMccId);
  }, [selectedMccId, loadCidList]);

  const handleMccChange = useCallback((mccId: string) => {
    setSelectedMccId(mccId);
    setSelectedCid("");
    setCidList([]);
  }, []);

  const syncCids = useCallback(async () => {
    if (!selectedMccId) { message.warning("请先选择 MCC 账户"); return; }
    setCidSyncing(true);
    try {
      const res = await fetch("/api/user/data-center/cids", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ mcc_account_id: Number(selectedMccId) }),
      });
      const json = await res.json();
      if (json.code === 0) {
        const synced = json.data?.synced || {};
        const cids = json.data?.cids || [];
        setCidList(cids);
        message.success(`CID 同步完成：共 ${synced.total || cids.length} 个 (新增 ${synced.created || 0})`);
        if (cids.length > 0 && !selectedCid) {
          const available = cids.find((c: any) => c.is_available === "Y");
          if (available) setSelectedCid(available.customer_id);
        }
      } else {
        message.error(json.message || "CID 同步失败");
      }
    } catch (err: any) {
      message.error(err?.message || "CID 同步失败");
    } finally {
      setCidSyncing(false);
    }
  }, [selectedMccId, selectedCid, message]);

  // ─── 爬虫生成扩展 ───
  const generateExtension = useCallback(async (type: "sitelinks" | "images" | "callouts" | "promotion" | "price" | "call" | "snippet") => {
    if (type === "sitelinks") setSitelinksLoading(true);
    if (type === "images") setImagesLoading(true);
    if (type === "callouts") setCalloutsLoading(true);
    if (type === "promotion") setPromotionLoading(true);
    if (type === "price") setPriceLoading(true);
    if (type === "call") setCallLoading(true);
    if (type === "snippet") setSnippetLoading(true);
    try {
      const res = await fetch("/api/user/ad-creation/generate-extensions", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ campaign_id: campaignId, types: [type] }),
      });
      const json = await res.json();
      if (json.code !== 0) { message.error(json.message || "生成失败"); return; }
      const data = json.data;
      const merchantLandingUrl = preview?.merchant?.merchant_url || preview?.adCreative?.final_url || "";

      if (data.crawl_failed) setCrawlFailed(true);

      if (type === "sitelinks" && data.sitelinks !== undefined) {
        const items = normalizeSitelinkItems(data.sitelinks).map((item) => ({
          ...item,
          urlStatus: item.url ? "" as const : item.urlStatus,
        }));
        if (items.length > 0) {
          setSitelinks(items);
          message.loading({ content: `已获取 ${items.length} 条链接，正在逐条验证...`, key: "sl-auto-check", duration: 0 });
          const checkResults = await Promise.all(
            items.map(async (item, idx) => {
              if (!item.url || !item.url.startsWith("http")) return { idx, valid: false };
              try {
                const checkRes = await fetch(`/api/user/ad-creation/check-url?url=${encodeURIComponent(item.url)}`);
                const checkJson = await checkRes.json();
                return { idx, valid: checkJson.code === 0 && checkJson.data?.ok };
              } catch { return { idx, valid: false }; }
            }),
          );
          const validItems: SitelinkItem[] = [];
          const invalidUrls: string[] = [];
          for (const r of checkResults) {
            if (r.valid) {
              validItems.push({ ...items[r.idx], urlStatus: "valid" as const });
            } else {
              invalidUrls.push(items[r.idx].title || items[r.idx].url);
            }
          }
          message.destroy("sl-auto-check");
          if (invalidUrls.length > 0) {
            message.warning(`已自动移除 ${invalidUrls.length} 条无效链接（${invalidUrls.join("、")}）`);
          }
          if (validItems.length > 0) {
            setSitelinks(validItems.length >= 2 ? validItems : [...validItems, { title: "", desc1: "", desc2: "", url: "", urlStatus: "" }]);
            message.success(`${validItems.length} 条站内链接已验证通过`);
          } else {
            setSitelinks([{ title: "", desc1: "", desc2: "", url: "", urlStatus: "" }, { title: "", desc1: "", desc2: "", url: "", urlStatus: "" }]);
            message.warning("所有爬取链接均无效，请手动添加");
          }
        } else {
          setSitelinks([{ title: "", desc1: "", desc2: "", url: "", urlStatus: "" }, { title: "", desc1: "", desc2: "", url: "", urlStatus: "" }]);
          message.warning(data.crawl_failed
            ? "无法爬取商家网站，请手动输入链接（输入 URL 后自动获取标题）"
            : "未找到可用链接，请手动添加");
        }
      }
      if (type === "images" && data.images !== undefined) {
        setCrawledImages(data.images);
        setImageUrls([]); // 清空选中，让用户重新选
        if (data.images.length > 0) {
          message.success(`已从商家网站提取 ${data.images.length} 张图片，请勾选需要的图片`);
        } else {
          message.warning(data.crawl_failed
            ? "无法爬取商家网站图片，请手动拖入或粘贴图片 URL"
            : "未找到可用图片，请手动添加");
        }
      }
      if (type === "callouts" && data.callouts) {
        setCallouts(data.callouts.length > 0 ? data.callouts : ["", ""]);
        if (data.callouts.length > 0) message.success(`已生成 ${data.callouts.length} 条宣传信息`);
        else message.warning("未能生成宣传信息，请手动添加");
      }

      // 自动填入促销信息
      if (data.promotion && typeof data.promotion === "object") {
        const p = data.promotion as Record<string, unknown>;
        setEnablePromotion(true);
        setPromotion((prev) => ({
          ...prev,
          promotion_target: String(p.promotion_target || prev.promotion_target || ""),
          discount_type: (p.discount_type === "MONETARY" ? "MONETARY" : "PERCENT") as "MONETARY" | "PERCENT",
          discount_percent: p.discount_percent != null ? Number(p.discount_percent) : prev.discount_percent,
          discount_amount: p.discount_amount != null ? Number(p.discount_amount) : prev.discount_amount,
          promo_code: p.promo_code ? String(p.promo_code) : prev.promo_code,
          occasion: p.occasion ? String(p.occasion) : prev.occasion,
          final_url: String(p.final_url || prev.final_url || merchantLandingUrl),
          currency_code: String(p.currency_code || prev.currency_code || defaultCurrencyCode),
          language_code: String(p.language_code || prev.language_code || defaultLanguageCode),
        }));
        message.success("已自动提取促销信息");
      }

      if (type === "promotion" && (!data.promotion || typeof data.promotion !== "object") && merchantLandingUrl) {
        setEnablePromotion(true);
        setPromotion((prev) => ({
          ...prev,
          final_url: prev.final_url || merchantLandingUrl,
        }));
        message.warning(data.crawl_failed ? "未能完整提取促销信息，已先填入商家落地页，请补充其余字段" : "暂未识别到完整促销信息，已先填入商家落地页");
      }

      // 自动填入价格信息
      if (data.price_items && Array.isArray(data.price_items) && data.price_items.length > 0) {
        setEnablePrice(true);
        const items = (data.price_items as Array<{ header: string; description: string; price: number; currency: string; url: string }>).slice(0, 8);
        setPriceItems(items.map((item) => ({
          header: item.header || "",
          description: item.description || "",
          price_amount: item.price || 0,
          currency_code: item.currency || defaultCurrencyCode,
          final_url: item.url || "",
        })));
        message.success(`已自动提取 ${items.length} 条价格信息`);
      }

      // 自动填入致电信息
      if (data.call && typeof data.call === "object") {
        const c = data.call as Record<string, unknown>;
        if (c.phone_number) {
          setEnableCall(true);
          setCallCountryCode(String(c.country_code || targetCountry || callCountryCode));
          setCallPhoneNumber(String(c.phone_number));
          message.success("已自动提取联系电话");
        }
      }

      // 自动填入结构化摘要
      if (data.structured_snippet && typeof data.structured_snippet === "object") {
        const s = data.structured_snippet as Record<string, unknown>;
        if (s.header && Array.isArray(s.values) && s.values.length >= 3) {
          setEnableSnippet(true);
          setSnippetHeader(String(s.header || defaultSnippetHeader));
          setSnippetValues((s.values as string[]).map(String));
          message.success("已自动生成结构化摘要");
        }
      }
    } catch (err: any) {
      message.error(err?.message || "生成失败，请手动填写");
    } finally {
      if (type === "sitelinks") setSitelinksLoading(false);
      if (type === "images") setImagesLoading(false);
      if (type === "callouts") setCalloutsLoading(false);
      if (type === "promotion") setPromotionLoading(false);
      if (type === "price") setPriceLoading(false);
      if (type === "call") setCallLoading(false);
      if (type === "snippet") setSnippetLoading(false);
    }
  }, [campaignId, message, callCountryCode, defaultCurrencyCode, defaultLanguageCode, defaultSnippetHeader, targetCountry]);

  // ─── 手动输入 URL → 自动获取标题和描述 + 验证 ───
  const fetchAndValidateSitelink = useCallback(async (idx: number) => {
    const url = sitelinks[idx]?.url;
    if (!url) return;
    const merchantDomain = preview?.merchant?.merchant_url || preview?.adCreative?.final_url || "";
    let baseDomain = "";
    try { baseDomain = new URL(merchantDomain).hostname.replace(/^www\./, ""); } catch {}

    if (!url.startsWith("http")) {
      setSitelinks((prev) => { const n = [...prev]; n[idx] = { ...n[idx], urlStatus: "invalid" }; return n; });
      message.error("链接必须以 http:// 或 https:// 开头");
      return;
    }
    try {
      const urlDomain = new URL(url).hostname.replace(/^www\./, "");
      if (baseDomain && !urlDomain.includes(baseDomain) && !baseDomain.includes(urlDomain)) {
        setSitelinks((prev) => { const n = [...prev]; n[idx] = { ...n[idx], urlStatus: "invalid" }; return n; });
        message.error(`链接域名 (${urlDomain}) 与商家域名 (${baseDomain}) 不匹配`);
        return;
      }
    } catch {
      setSitelinks((prev) => { const n = [...prev]; n[idx] = { ...n[idx], urlStatus: "invalid" }; return n; });
      message.error("URL 格式无效");
      return;
    }

    setSitelinks((prev) => { const n = [...prev]; n[idx] = { ...n[idx], urlStatus: "checking" }; return n; });
    try {
      const [checkRes, metaRes] = await Promise.all([
        fetch(`/api/user/ad-creation/check-url?url=${encodeURIComponent(url)}`),
        fetch(`/api/user/ad-creation/fetch-url-meta?url=${encodeURIComponent(url)}`),
      ]);
      const checkData = await checkRes.json();
      const metaData = await metaRes.json();
      const checkOk = checkData?.data?.ok === true;
      const metaOk = metaData.code === 0 && metaData.data?.ok;
      const isSoft404 = metaData?.data?.isSoft404 === true;
      const isValid = checkOk && !isSoft404;

      setSitelinks((prev) => {
        const n = [...prev];
        n[idx] = {
          ...n[idx],
          title: n[idx].title || (metaOk ? metaData.data.title : "") || "",
          desc1: n[idx].desc1 || (metaOk ? metaData.data.description : "") || "",
          urlStatus: isValid ? "valid" : "invalid",
        };
        return n;
      });

      if (isSoft404) {
        message.error("链接页面显示「页面不存在」（软 404）");
      } else if (metaOk && isValid) {
        message.success("已自动获取页面标题和描述");
      } else if (isValid) {
        message.info("链接有效，但无法获取页面信息，请手动填写标题");
      } else {
        message.error(checkData?.data?.reason || "链接不可用");
      }
    } catch {
      setSitelinks((prev) => { const n = [...prev]; n[idx] = { ...n[idx], urlStatus: "valid" }; return n; });
    }
  }, [sitelinks, preview, message]);

  // ─── 图片上传 ───
  const [imageCheckResults, setImageCheckResults] = useState<Record<number, { has_text: boolean; checking: boolean; text?: string }>>({});

  const checkImageForText = useCallback(async (url: string, idx: number) => {
    setImageCheckResults((prev) => ({ ...prev, [idx]: { has_text: false, checking: true } }));
    try {
      const res = await fetch("/api/user/ad-creation/check-image", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ url }),
      });
      const json = await res.json();
      if (json.code === 0) {
        setImageCheckResults((prev) => ({
          ...prev,
          [idx]: { has_text: json.data.has_text, checking: false, text: json.data.text },
        }));
        if (json.data.has_text) {
          message.warning(`图片 ${idx + 1} 检测到文字内容，建议更换为无文字图片`);
        }
      } else {
        setImageCheckResults((prev) => ({ ...prev, [idx]: { has_text: false, checking: false } }));
      }
    } catch {
      setImageCheckResults((prev) => ({ ...prev, [idx]: { has_text: false, checking: false } }));
    }
  }, [message]);

  const handleImageUpload = useCallback(async (file: File) => {
    if (!["image/jpeg", "image/png"].includes(file.type)) {
      message.error("Google Ads 仅支持 JPG 和 PNG 格式图片");
      return false;
    }
    if (file.size > 5 * 1024 * 1024) {
      message.error("图片大小不能超过 5MB（Google Ads 限制）");
      return false;
    }
    const formData = new FormData();
    formData.append("file", file);
    try {
      const res = await fetch("/api/user/ad-creation/upload-image", { method: "POST", body: formData });
      const json = await res.json();
      if (json.code === 0 && json.data?.url) {
        setImageUrls((prev) => {
          const newUrls = [...prev, json.data.url];
          // 自动触发 OCR 检测
          checkImageForText(json.data.url, newUrls.length - 1);
          return newUrls;
        });
        message.success("图片上传成功，正在检测文字...");
      } else {
        message.error(json.message || "上传失败");
      }
    } catch {
      message.error("图片上传失败");
    }
    return false;
  }, [message]);

  const toggleCallouts = useCallback((checked: boolean) => {
    setEnableCallouts(checked);
    if (checked && callouts.length === 0) generateExtension("callouts");
  }, [callouts.length, generateExtension]);

  // ─── 站内链接操作 ───
  const updateSitelink = (idx: number, field: keyof SitelinkItem, val: string) => {
    setSitelinks((prev) => {
      const n = [...prev];
      n[idx] = { ...n[idx], [field]: val };
      if (field === "url") n[idx].urlStatus = "";
      return n;
    });
  };
  const addSitelink = () => {
    if (sitelinks.length < 6) setSitelinks((prev) => [...prev, { title: "", desc1: "", desc2: "", url: "", urlStatus: "" }]);
  };
  const removeSitelink = (idx: number) => setSitelinks((prev) => prev.filter((_, i) => i !== idx));

  const validateAllSitelinks = useCallback(async () => {
    const validIndices = sitelinks
      .map((sl, i) => ({ sl, i }))
      .filter(({ sl }) => sl.url.trim().length > 0 && sl.urlStatus !== "checking");
    if (validIndices.length === 0) { message.warning("没有需要验证的链接"); return; }
    await Promise.all(validIndices.map(({ i }) => fetchAndValidateSitelink(i)));
  }, [sitelinks, fetchAndValidateSitelink, message]);

  const removeInvalidSitelinks = useCallback(() => {
    const invalids = sitelinks.filter((sl) => sl.urlStatus === "invalid");
    if (invalids.length === 0) { message.info("没有无效链接"); return; }
    setSitelinks((prev) => prev.filter((sl) => sl.urlStatus !== "invalid"));
    message.success(`已删除 ${invalids.length} 条无效链接`);
  }, [sitelinks, message]);

  // ─── 图片操作 ───
  const addImageUrl = () => {
    if (newImageUrl.trim() && newImageUrl.startsWith("http")) {
      setImageUrls((prev) => [...prev, newImageUrl.trim()]);
      setNewImageUrl("");
    } else if (newImageUrl.trim()) {
      message.error("请输入有效的图片 URL（以 http 开头）");
    }
  };
  const removeImage = (idx: number) => setImageUrls((prev) => prev.filter((_, i) => i !== idx));
  const toggleImageSelect = (url: string) => {
    setImageUrls((prev) => prev.includes(url) ? prev.filter((u) => u !== url) : [...prev, url]);
  };

  // ─── 宣传信息操作 ───
  const updateCallout = (idx: number, val: string) => {
    setCallouts((prev) => { const n = [...prev]; n[idx] = val; return n; });
  };
  const addCallout = () => { if (callouts.length < 10) setCallouts((prev) => [...prev, ""]); };
  const removeCallout = (idx: number) => setCallouts((prev) => prev.filter((_, i) => i !== idx));

  // ─── 提交 ───
  const handleSubmit = useCallback(async () => {
    const validH = headlines.filter((h) => h.trim().length > 0);
    const validD = descriptions.filter((d) => d.trim().length > 0);
    if (validH.length < 3) { message.error("至少需要 3 条标题"); return; }
    if (validD.length < 2) { message.error("至少需要 2 条描述"); return; }
    const overH = validH.filter((h) => h.length > HEADLINE_MAX);
    if (overH.length > 0) { message.error(`有 ${overH.length} 条标题超过 ${HEADLINE_MAX} 字符限制`); return; }
    const overD = validD.filter((d) => d.length > DESC_MAX);
    if (overD.length > 0) { message.error(`有 ${overD.length} 条描述超过 ${DESC_MAX} 字符限制`); return; }

    // 验证站内链接（自动触发未验证链接的校验）
    const validLinks = sitelinks.filter((s) => s.title.trim() && s.url.trim());
    if (validLinks.length > 0) {
      if (validLinks.length < 2) { message.error("站内链接至少需要 2 条（标题和链接必填）"); return; }
      const uncheckedIndices = validLinks
        .map((s, i) => ({ s, origIdx: sitelinks.indexOf(s) }))
        .filter(({ s }) => s.urlStatus !== "valid" && s.urlStatus !== "invalid" && s.urlStatus !== "checking")
        .map(({ origIdx }) => origIdx);
      if (uncheckedIndices.length > 0) {
        message.loading({ content: `正在验证 ${uncheckedIndices.length} 条未检查的站内链接...`, key: "sl-check", duration: 0 });
        await Promise.all(uncheckedIndices.map((idx) => fetchAndValidateSitelink(idx)));
        message.destroy("sl-check");
        const afterCheck = sitelinks.filter((s) => s.title.trim() && s.url.trim());
        const stillInvalid = afterCheck.filter((s) => s.urlStatus === "invalid");
        if (stillInvalid.length > 0) {
          message.error(`有 ${stillInvalid.length} 条站内链接无效，请修正或删除后再提交`);
          return;
        }
        const stillUnchecked = afterCheck.filter((s) => s.urlStatus !== "valid");
        if (stillUnchecked.length > 0) {
          message.error("部分站内链接仍未通过验证，请重新检查后提交");
          return;
        }
      } else {
        const invalidLinks = validLinks.filter((s) => s.urlStatus === "invalid");
        if (invalidLinks.length > 0) { message.error(`有 ${invalidLinks.length} 条站内链接无效，请修正或删除后再提交`); return; }
      }
      const overTitle = validLinks.filter((s) => s.title.length > SITELINK_TITLE_MAX);
      if (overTitle.length > 0) { message.error(`站内链接标题不能超过 ${SITELINK_TITLE_MAX} 字符`); return; }
    }

    if (enableCallouts) {
      const validC = callouts.filter((c) => c.trim().length > 0);
      if (validC.length < 2) { message.error("宣传信息至少需要 2 条"); return; }
      const overC = validC.filter((c) => c.length > CALLOUT_MAX);
      if (overC.length > 0) { message.error(`宣传信息不能超过 ${CALLOUT_MAX} 字符`); return; }
    }

    setSubmitting(true);
    try {
      if (!selectedCid) { message.error("请选择发布的 CID 账户"); return; }

      const submitBody: Record<string, any> = {
        campaign_id: campaignId,
        headlines: validH,
        descriptions: validD,
        keywords: kwList,
        daily_budget: budget,
        max_cpc_limit: maxCpc,
        bidding_strategy: biddingStrategy,
        network_search: networkSearch,
        network_partners: networkPartners,
        network_display: networkDisplay,
        customer_id: selectedCid,
        mcc_account_id: selectedMccId,
        ad_language: adLanguage || "en",
        eu_political_ad: euPoliticalAd,
      };
      {
        const sl = sitelinks.filter((s) => s.title.trim() && s.url.trim());
        if (sl.length > 0) submitBody.sitelinks = sl.map((s) => ({ title: s.title, description1: s.desc1, description2: s.desc2, finalUrl: s.url }));
      }
      if (imageUrls.length > 0) {
        submitBody.image_urls = imageUrls;
      }
      if (enableCallouts) {
        submitBody.callouts = callouts.filter((c) => c.trim().length > 0);
      }
      if (enablePromotion && promotion.promotion_target.trim()) {
        submitBody.promotion = promotion;
      }
      if (enablePrice && priceItems.length > 0) {
        submitBody.price = { type: priceType, items: priceItems.filter((p) => p.header.trim()) };
      }
      if (enableCall && callPhoneNumber.trim()) {
        submitBody.call = { country_code: callCountryCode, phone_number: callPhoneNumber.trim() };
      }
      if (enableSnippet && snippetValues.some((v) => v.trim())) {
        submitBody.structured_snippet = { header: snippetHeader, values: snippetValues.filter((v) => v.trim()) };
      }

      const res = await mutateApi("/api/user/ad-creation/submit", {
        method: "POST",
        body: submitBody,
      });
      if (res.code === 0) {
        const articleSlug = (res.data as any)?.article_slug;
        const articleStatus = (res.data as any)?.article_status;
        if (articleSlug) {
          const statusMsg = articleStatus === "generating" ? "（文章正在生成中）" : "";
          message.success(`广告已提交到 Google Ads！正在跳转到文章发布页${statusMsg}...`);
          setTimeout(() => router.push(`/user/articles/publish?slug=${articleSlug}`), 1500);
        } else {
          message.success("广告已提交到 Google Ads！");
          setTimeout(() => router.push("/user/data-center"), 1500);
        }
      } else {
        message.error(res.message || "提交失败");
      }
    } catch (err: any) {
      message.error(err?.message || "提交失败");
    } finally {
      setSubmitting(false);
    }
  }, [headlines, descriptions, kwList, budget, maxCpc, biddingStrategy, networkSearch, networkPartners, networkDisplay, campaignId, message, router, sitelinks, imageUrls, enableCallouts, callouts, selectedCid, selectedMccId, adLanguage, euPoliticalAd, fetchAndValidateSitelink, enablePromotion, promotion, enablePrice, priceItems, priceType, enableCall, callPhoneNumber, callCountryCode, enableSnippet, snippetHeader, snippetValues]);

  if (isLoading && !preview) {
    return <div style={{ textAlign: "center", padding: 80 }}><Spin size="large" tip="加载中..." /></div>;
  }
  if (!preview) {
    return <Alert type="error" message="广告系列不存在" showIcon style={{ margin: 24 }} />;
  }

  return (
    <div style={{ padding: "16px 24px", maxWidth: 1200, margin: "0 auto" }}>
      <Space style={{ marginBottom: 16 }}>
        <Button icon={<ArrowLeftOutlined />} onClick={() => router.push("/user/merchants")}>返回商家管理</Button>
        <Title level={4} style={{ margin: 0 }}>
          广告预览 — {preview.merchant?.merchant_name || preview.campaign?.campaign_name}
        </Title>
        {preview.campaign?.google_campaign_id && <Tag color="green">已提交</Tag>}
      </Space>

      {!isReady && (
        <Alert
          type="info" showIcon icon={<LoadingOutlined />}
          message="正在生成广告素材..."
          description="SemRush 竞品数据获取和 AI 文案生成中，请稍候。页面会自动刷新。"
          style={{ marginBottom: 16 }}
          action={<Button size="small" icon={<ReloadOutlined />} onClick={() => mutate()}>刷新</Button>}
        />
      )}

      <Row gutter={16}>
        {/* ─── 左侧：标题 / 描述 / 关键词 / 扩展 ─── */}
        <Col span={16}>
          <Card
            title={<><EditOutlined /> 广告标题 ({headlines.length}/15)</>}
            size="small" style={{ marginBottom: 16 }}
            extra={
              <Button
                size="small" type="link"
                icon={<TranslationOutlined />}
                loading={translating}
                onClick={generateZhTranslation}
              >
                {headlinesZh.length > 0 ? "刷新中文翻译" : "生成中文翻译"}
              </Button>
            }
          >
            {headlines.map((h, i) => (
              <div key={i} style={{ marginBottom: 8 }}>
                <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
                  <Text type="secondary" style={{ width: 24, textAlign: "right" }}>{i + 1}.</Text>
                  <Input
                    value={h} onChange={(e) => updateHeadline(i, e.target.value)}
                    maxLength={HEADLINE_MAX + 5} placeholder={`标题 ${i + 1}`}
                    style={{ flex: 1 }}
                    status={h.length > HEADLINE_MAX ? "error" : undefined}
                    suffix={<Text type={h.length > HEADLINE_MAX ? "danger" : "secondary"} style={{ fontSize: 12 }}>{h.length}/{HEADLINE_MAX}</Text>}
                  />
                  {headlines.length > 3 && (
                    <Button size="small" type="text" danger icon={<DeleteOutlined />} onClick={() => removeHeadline(i)} />
                  )}
                </div>
                {headlinesZh[i] && (
                  <div style={{ marginLeft: 32, marginTop: 2, fontSize: 12, color: "#999", lineHeight: "18px" }}>
                    {headlinesZh[i]}
                  </div>
                )}
              </div>
            ))}
            {headlines.length < 15 && (
              <Space style={{ width: "100%" }}>
                <Button
                  type="primary" size="small" ghost
                  icon={generatingHeadlines ? <LoadingOutlined /> : <ThunderboltOutlined />}
                  loading={generatingHeadlines}
                  onClick={aiGenerateHeadlines}
                  style={{ flex: 1 }}
                >
                  AI 生成标题
                </Button>
                <Button type="dashed" size="small" icon={<PlusOutlined />} onClick={addHeadline}>手动添加</Button>
              </Space>
            )}
          </Card>

          <Card title={<><EditOutlined /> 广告描述 ({descriptions.length}/4)</>} size="small" style={{ marginBottom: 16 }}>
            {descriptions.map((d, i) => (
              <div key={i} style={{ marginBottom: 8 }}>
                <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
                  <Text type="secondary" style={{ width: 24, textAlign: "right" }}>{i + 1}.</Text>
                  <TextArea
                    value={d} onChange={(e) => updateDescription(i, e.target.value)}
                    maxLength={DESC_MAX + 10} placeholder={`描述 ${i + 1}`}
                    autoSize={{ minRows: 1, maxRows: 3 }} style={{ flex: 1 }}
                    status={d.length > DESC_MAX ? "error" : undefined}
                  />
                  <Text type={d.length > DESC_MAX ? "danger" : "secondary"} style={{ fontSize: 12, whiteSpace: "nowrap" }}>{d.length}/{DESC_MAX}</Text>
                  {descriptions.length > 2 && (
                    <Button size="small" type="text" danger icon={<DeleteOutlined />} onClick={() => removeDescription(i)} />
                  )}
                </div>
                {descriptionsZh[i] && (
                  <div style={{ marginLeft: 32, marginTop: 2, fontSize: 12, color: "#999", lineHeight: "18px" }}>
                    {descriptionsZh[i]}
                  </div>
                )}
              </div>
            ))}
            {descriptions.length < 4 && (
              <Space style={{ width: "100%" }}>
                <Button
                  type="primary" size="small" ghost
                  icon={generatingDescriptions ? <LoadingOutlined /> : <ThunderboltOutlined />}
                  loading={generatingDescriptions}
                  onClick={aiGenerateDescriptions}
                  style={{ flex: 1 }}
                >
                  AI 生成描述
                </Button>
                <Button type="dashed" size="small" icon={<PlusOutlined />} onClick={addDescription}>手动添加</Button>
              </Space>
            )}
          </Card>

          <Card
            title={<Space>关键词 ({kwList.length})</Space>}
            size="small" style={{ marginBottom: 16 }}
            extra={
              <Button
                size="small" type="link"
                icon={<ThunderboltOutlined />}
                loading={kwFetching}
                onClick={fetchKeywordsFromSemrush}
              >
                {kwList.length === 0 ? "从 SemRush 获取关键词" : "补充关键词"}
              </Button>
            }
          >
            {kwList.length === 0 && !kwFetching && !semrushFailed && (
              <Alert
                type="info" showIcon
                message="暂无关键词"
                description="点击右上角「从 SemRush 获取关键词」自动获取竞品关键词，系统会结合预算、CPC 和竞争度优选后再展示，也可手动输入添加。"
                style={{ marginBottom: 8 }}
              />
            )}
            {kwFetching && (
              <div style={{ textAlign: "center", padding: "16px 0" }}>
                <Spin tip="正在从 SemRush 获取并优选关键词..." />
              </div>
            )}
            {semrushFailed && !kwFetching && (
              <Alert
                type="warning" showIcon icon={<WarningOutlined />}
                message="SemRush 自动获取失败"
                description={
                  <div>
                    <Text type="secondary" style={{ display: "block", marginBottom: 8 }}>
                      可粘贴 3UE SemRush 链接手动获取关键词，或在下方直接输入关键词
                    </Text>
                    <Space.Compact style={{ width: "100%" }}>
                      <Input
                        value={semrushUrl}
                        onChange={(e) => setSemrushUrl(e.target.value)}
                        placeholder="粘贴 3UE 链接，如 https://sem.3ue.co/analytics/overview/?q=..."
                        onPressEnter={fetchKeywordsFromUrl}
                        disabled={semrushUrlFetching}
                      />
                      <Button
                        type="primary"
                        onClick={fetchKeywordsFromUrl}
                        loading={semrushUrlFetching}
                        icon={<ThunderboltOutlined />}
                      >
                        获取
                      </Button>
                    </Space.Compact>
                  </div>
                }
                style={{ marginBottom: 8 }}
              />
            )}
            <Space direction="vertical" style={{ width: "100%", marginBottom: 8 }} size={8}>
              {kwList.map((kw, i) => (
                <div key={`${kw.text}-${kw.matchType}-${i}`} style={{ display: "flex", alignItems: "flex-start", gap: 8, padding: "8px 10px", border: "1px solid #d9e8ff", borderRadius: 8, background: kw.score != null && kw.score >= 70 ? "#f6ffed" : "#f8fbff" }}>
                  <Select
                    size="small"
                    value={kw.matchType}
                    onChange={(val) => updateKeywordMatchType(i, val)}
                    style={{ width: 88, fontSize: 11, flexShrink: 0 }}
                    popupMatchSelectWidth={false}
                    options={[
                      { value: "BROAD", label: "广泛" },
                      { value: "PHRASE", label: "词组" },
                      { value: "EXACT", label: "完全" },
                    ]}
                  />
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ display: "flex", flexWrap: "wrap", gap: 6, alignItems: "center", marginBottom: 4 }}>
                      <Text strong>{kw.matchType === "EXACT" ? `[${kw.text}]` : kw.matchType === "PHRASE" ? `"${kw.text}"` : kw.text}</Text>
                      {kw.score != null && <Tag color={kw.score >= 70 ? "success" : kw.score >= 50 ? "processing" : "default"} style={{ margin: 0 }}>评分 {kw.score.toFixed(0)}</Tag>}
                      {kw.avgMonthlySearches != null && <Tag style={{ margin: 0 }}>搜索量 {kw.avgMonthlySearches}</Tag>}
                      {kw.suggestedBid != null && <Tag style={{ margin: 0 }}>建议 CPC ${kw.suggestedBid.toFixed(2)}</Tag>}
                      {kw.competitionBand && <Tag color={kw.competitionBand === "LOW" ? "green" : kw.competitionBand === "MEDIUM" ? "gold" : kw.competitionBand === "HIGH" ? "red" : "default"} style={{ margin: 0 }}>{kw.competitionBand}</Tag>}
                    </div>
                    {kw.reason && <Text type="secondary" style={{ fontSize: 12 }}>{kw.reason}</Text>}
                  </div>
                  <Button size="small" type="text" danger icon={<DeleteOutlined />} onClick={() => removeKeyword(i)} />
                </div>
              ))}
            </Space>
            <Space.Compact style={{ width: "100%" }}>
              <Select
                size="middle"
                value={newKwMatchType}
                onChange={setNewKwMatchType}
                style={{ width: 100 }}
                options={[
                  { value: "BROAD", label: "广泛" },
                  { value: "PHRASE", label: "词组" },
                  { value: "EXACT", label: "完全" },
                ]}
              />
              <Input
                value={newKeyword} onChange={(e) => setNewKeyword(e.target.value)}
                placeholder="输入关键词" onPressEnter={addKeyword}
              />
              <Button type="primary" onClick={addKeyword} icon={<PlusOutlined />}>添加</Button>
            </Space.Compact>
          </Card>

          {/* ─── 广告素材与扩展 ─── */}
          <Card title="广告素材与扩展" size="small" style={{ marginBottom: 16 }}>

            {/* 站内链接 — 自动生成 */}
            <div style={{ marginBottom: 16 }}>
              <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                <Space><LinkOutlined /><Text strong>站内链接 (Sitelinks)</Text><Tag color="blue">自动生成</Tag></Space>
                {!sitelinksLoading && sitelinks.length > 0 && (
                  <Button size="small" type="link" icon={<ReloadOutlined />} onClick={() => generateExtension("sitelinks")}>重新爬取</Button>
                )}
              </div>
              <Text type="secondary" style={{ fontSize: 12, display: "block", marginLeft: 24 }}>
                系统自动从商家网站爬取真实链接并生成。如爬取失败，可手动输入 URL，系统会自动获取标题和描述
              </Text>
              {!sitelinksLoading && sitelinks.filter((sl) => sl.title.trim() && sl.url.trim()).length > 0 && sitelinks.filter((sl) => sl.title.trim() && sl.url.trim()).length < 6 && (
                <Alert
                  type="info" showIcon
                  message="广告效力提示（Google 官方）"
                  description="响应式搜索广告要达到「良好」或「极佳」的广告效力，建议在账户/系列/广告组层级合计至少 6 条站内链接。请补满有效链接或点击「添加链接」手动补充。"
                  style={{ marginTop: 8, marginLeft: 24 }}
                />
              )}
              {crawlFailed && !sitelinksLoading && sitelinks.every((sl) => !sl.url) && (
                <Alert
                  type="warning" showIcon icon={<WarningOutlined />}
                  message="商家网站爬取失败（可能有反爬保护且无 sitemap）"
                  description="请手动输入商家网站的页面链接（如：https://www.example.com/sale），输入后点击「获取」自动填充标题和描述"
                  style={{ marginTop: 8, marginLeft: 24 }}
                />
              )}
              <div style={{ marginTop: 12, marginLeft: 24 }}>
                {sitelinksLoading ? (
                    <div style={{ textAlign: "center", padding: "24px 0" }}>
                      <Spin tip="正在爬取商家网站获取站内链接..." />
                    </div>
                  ) : (
                    <>
                      {sitelinks.length > 0 && (
                        <div style={{ display: "flex", gap: 8, marginBottom: 10 }}>
                          <Button
                            size="small" type="primary" ghost
                            icon={<CheckCircleOutlined />}
                            onClick={validateAllSitelinks}
                            loading={sitelinks.some((sl) => sl.urlStatus === "checking")}
                          >
                            一键验证所有链接
                          </Button>
                          {sitelinks.some((sl) => sl.urlStatus === "invalid") && (
                            <Popconfirm
                              title="确定删除所有无效链接？"
                              description={`将删除 ${sitelinks.filter((sl) => sl.urlStatus === "invalid").length} 条验证失败的链接`}
                              onConfirm={removeInvalidSitelinks}
                              okText="确定删除"
                              cancelText="取消"
                              okButtonProps={{ danger: true }}
                            >
                              <Button size="small" danger icon={<DeleteOutlined />}>
                                删除无效链接 ({sitelinks.filter((sl) => sl.urlStatus === "invalid").length})
                              </Button>
                            </Popconfirm>
                          )}
                        </div>
                      )}
                      {sitelinks.map((sl, i) => (
                        <Card key={i} size="small"
                          style={{
                            marginBottom: 8,
                            background: sl.urlStatus === "invalid" ? "#fff2f0" : sl.urlStatus === "valid" ? "#f6ffed" : "#fafafa",
                            borderColor: sl.urlStatus === "invalid" ? "#ffccc7" : sl.urlStatus === "valid" ? "#b7eb8f" : undefined,
                          }}
                          extra={
                            <Space size={4}>
                              {sl.urlStatus === "invalid" && (
                                <Tag color="error" style={{ margin: 0, fontSize: 11 }}>链接无效</Tag>
                              )}
                              {sl.urlStatus === "valid" && (
                                <Tag color="success" style={{ margin: 0, fontSize: 11 }}>已验证</Tag>
                              )}
                              {sitelinks.length > 2 && (
                                <Button size="small" type="text" danger icon={<DeleteOutlined />} onClick={() => removeSitelink(i)} />
                              )}
                            </Space>
                          }
                          title={<Text type="secondary" style={{ fontSize: 12 }}>链接 {i + 1}</Text>}
                        >
                          <Row gutter={[8, 8]}>
                            <Col span={12}>
                              <Input
                                size="small" value={sl.title} placeholder="链接标题（必填）"
                                maxLength={SITELINK_TITLE_MAX + 3}
                                onChange={(e) => updateSitelink(i, "title", e.target.value)}
                                suffix={<Text type={sl.title.length > SITELINK_TITLE_MAX ? "danger" : "secondary"} style={{ fontSize: 11 }}>{sl.title.length}/{SITELINK_TITLE_MAX}</Text>}
                                status={sl.title.length > SITELINK_TITLE_MAX ? "error" : undefined}
                              />
                              {sitelinksZh[i]?.title && (
                                <div style={{ marginTop: 2, fontSize: 12, color: "#999", lineHeight: "16px" }}>{sitelinksZh[i].title}</div>
                              )}
                            </Col>
                            <Col span={12}>
                              <Space.Compact style={{ width: "100%" }}>
                                <Input
                                  size="small" value={sl.url} placeholder="页面链接 https://...（必填）"
                                  onChange={(e) => updateSitelink(i, "url", e.target.value)}
                                  onBlur={() => {
                                    if (sl.url.startsWith("http") && !sl.title && sl.urlStatus !== "checking") {
                                      fetchAndValidateSitelink(i);
                                    }
                                  }}
                                  suffix={
                                    sl.urlStatus === "checking" ? <LoadingOutlined style={{ color: "#1677ff" }} /> :
                                    sl.urlStatus === "valid" ? <CheckCircleOutlined style={{ color: "#52c41a" }} /> :
                                    sl.urlStatus === "invalid" ? <ExclamationCircleOutlined style={{ color: "#ff4d4f" }} /> :
                                    null
                                  }
                                  status={sl.urlStatus === "invalid" ? "error" : undefined}
                                />
                                <Tooltip title="获取页面标题和描述，并验证链接有效性">
                                  <Button
                                    size="small"
                                    type={sl.urlStatus === "invalid" ? "primary" : "default"}
                                    danger={sl.urlStatus === "invalid"}
                                    icon={sl.urlStatus === "checking" ? <LoadingOutlined /> : <LinkOutlined />}
                                    onClick={() => fetchAndValidateSitelink(i)}
                                    disabled={!sl.url.trim() || sl.urlStatus === "checking"}
                                  >
                                    验证
                                  </Button>
                                </Tooltip>
                              </Space.Compact>
                            </Col>
                            <Col span={12}>
                              <Input
                                size="small" value={sl.desc1} placeholder="描述行 1（可选）"
                                maxLength={SITELINK_DESC_MAX + 3}
                                onChange={(e) => updateSitelink(i, "desc1", e.target.value)}
                                suffix={sl.desc1.length > 0 ? <Text type="secondary" style={{ fontSize: 11 }}>{sl.desc1.length}/{SITELINK_DESC_MAX}</Text> : undefined}
                              />
                              {sitelinksZh[i]?.desc1 && (
                                <div style={{ marginTop: 2, fontSize: 12, color: "#999", lineHeight: "16px" }}>{sitelinksZh[i].desc1}</div>
                              )}
                            </Col>
                            <Col span={12}>
                              <Input
                                size="small" value={sl.desc2} placeholder="描述行 2（可选）"
                                maxLength={SITELINK_DESC_MAX + 3}
                                onChange={(e) => updateSitelink(i, "desc2", e.target.value)}
                                suffix={sl.desc2.length > 0 ? <Text type="secondary" style={{ fontSize: 11 }}>{sl.desc2.length}/{SITELINK_DESC_MAX}</Text> : undefined}
                              />
                              {sitelinksZh[i]?.desc2 && (
                                <div style={{ marginTop: 2, fontSize: 12, color: "#999", lineHeight: "16px" }}>{sitelinksZh[i].desc2}</div>
                              )}
                            </Col>
                          </Row>
                          {sl.urlStatus === "invalid" && (
                            <div style={{ marginTop: 8, display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                              <Text type="danger" style={{ fontSize: 12 }}>
                                <ExclamationCircleOutlined /> 此链接验证失败，建议删除或修改为有效链接
                              </Text>
                              <Button size="small" type="link" danger onClick={() => removeSitelink(i)}>
                                删除此链接
                              </Button>
                            </div>
                          )}
                        </Card>
                      ))}
                      {sitelinks.length < 6 && (
                        <Button type="dashed" size="small" icon={<PlusOutlined />} onClick={addSitelink} block>
                          添加站内链接（最多 6 条）
                        </Button>
                      )}
                    </>
                  )}
                </div>
            </div>

            <Divider style={{ margin: "12px 0" }} />

            {/* 商家图片 — 自动生成 */}
            <div style={{ marginBottom: 16 }}>
              <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                <Space><PictureOutlined /><Text strong>商家图片</Text><Tag color="blue">自动生成</Tag></Space>
                {!imagesLoading && (crawledImages.length > 0 || imageUrls.length > 0) && (
                  <Button size="small" type="link" icon={<ReloadOutlined />} onClick={() => generateExtension("images")}>重新提取</Button>
                )}
              </div>
              <Text type="secondary" style={{ fontSize: 12, display: "block", marginLeft: 24 }}>
                系统自动从商家网站爬取产品图片。如爬取失败，可拖入图片或粘贴图片 URL
              </Text>
              <Alert
                type="info" showIcon
                message="图片要求"
                description="1. 图片需与品牌强关联（产品图、品牌场景图等）。2. 图片不要包含文字（上传后自动 OCR 检测）。"
                style={{ marginTop: 8, marginLeft: 24, marginBottom: 0 }}
              />
              {!imagesLoading && imageUrls.length === 0 && crawledImages.length === 0 && (
                <Alert
                  type="warning" showIcon icon={<WarningOutlined />}
                  message="未自动获取到商家图片"
                  description="请将商家产品图片拖入下方区域上传，或手动粘贴图片 URL"
                  style={{ marginTop: 8, marginLeft: 24 }}
                />
              )}
              <div style={{ marginTop: 12, marginLeft: 24 }}>
                {imagesLoading ? (
                    <div style={{ textAlign: "center", padding: "24px 0" }}>
                      <Spin tip="正在从商家网站提取图片..." />
                    </div>
                  ) : (
                    <>
                      {/* 爬取到的图片 — 勾选模式 */}
                      {crawledImages.length > 0 && (
                        <div style={{ marginBottom: 12 }}>
                          <Text type="secondary" style={{ fontSize: 12, marginBottom: 8, display: "block" }}>
                            可选图片 {crawledImages.length} 张，已选 {imageUrls.filter(u => crawledImages.includes(u)).length} 张（点击图片选择/取消）
                          </Text>
                          <Space wrap>
                            {crawledImages.map((url, i) => {
                              const isSelected = imageUrls.includes(url);
                              return (
                              <div
                                key={url + i}
                                onClick={() => toggleImageSelect(url)}
                                style={{ position: "relative", display: "inline-block", cursor: "pointer" }}
                              >
                                <Image
                                  src={url} alt={`crawled-${i}`}
                                  width={80} height={80}
                                  preview={false}
                                  style={{
                                    objectFit: "cover", borderRadius: 6,
                                    border: isSelected ? "3px solid #1890ff" : "1px solid #d9d9d9",
                                    opacity: isSelected ? 1 : 0.5,
                                    transition: "all 0.2s",
                                  }}
                                  fallback={IMAGE_FALLBACK}
                                />
                                {isSelected && (
                                  <div style={{ position: "absolute", top: -4, right: -4, background: "#1890ff", borderRadius: "50%", width: 20, height: 20, display: "flex", alignItems: "center", justifyContent: "center", boxShadow: "0 1px 3px rgba(0,0,0,.3)" }}>
                                    <CheckCircleOutlined style={{ color: "#fff", fontSize: 12 }} />
                                  </div>
                                )}
                              </div>
                              );
                            })}
                          </Space>
                        </div>
                      )}
                      {/* 已选中 + 手动上传的图片 */}
                      {imageUrls.filter(u => !crawledImages.includes(u)).length > 0 && (
                        <div style={{ marginBottom: 8 }}>
                          <Text type="secondary" style={{ fontSize: 12, marginBottom: 4, display: "block" }}>
                            已选手动图片 {imageUrls.filter(u => !crawledImages.includes(u)).length} 张
                          </Text>
                          <Space wrap>
                            {imageUrls.filter(u => !crawledImages.includes(u)).map((url, i) => {
                              const checkResult = imageCheckResults[imageUrls.indexOf(url)];
                              return (
                              <div key={`manual-${url}-${i}`} style={{ position: "relative", display: "inline-block" }}>
                                <Image
                                  src={url} alt={`manual-${i}`}
                                  width={80} height={80}
                                  style={{
                                    objectFit: "cover", borderRadius: 6,
                                    border: checkResult?.has_text ? "2px solid #ff4d4f" : "3px solid #1890ff",
                                    opacity: 1,
                                  }}
                                  fallback={IMAGE_FALLBACK}
                                />
                                <div style={{ position: "absolute", top: -4, right: -4, background: "#1890ff", borderRadius: "50%", width: 20, height: 20, display: "flex", alignItems: "center", justifyContent: "center", boxShadow: "0 1px 3px rgba(0,0,0,.3)" }}>
                                  <CheckCircleOutlined style={{ color: "#fff", fontSize: 12 }} />
                                </div>
                                {checkResult?.has_text && (
                                  <Tooltip title={`检测到文字: ${checkResult.text || ""}`}>
                                    <div style={{ position: "absolute", bottom: 2, left: 2, background: "#ff4d4f", borderRadius: 4, padding: "1px 4px" }}>
                                      <Text style={{ color: "#fff", fontSize: 10 }}>含文字</Text>
                                    </div>
                                  </Tooltip>
                                )}
                                <Button
                                  size="small" type="text" danger icon={<DeleteOutlined />}
                                  style={{ position: "absolute", top: -4, left: -4, background: "#fff", borderRadius: "50%", boxShadow: "0 1px 3px rgba(0,0,0,.2)", width: 20, height: 20, padding: 0, fontSize: 10 }}
                                  onClick={() => removeImage(imageUrls.indexOf(url))}
                                />
                              </div>
                              );
                            })}
                          </Space>
                        </div>
                      )}
                      <Upload.Dragger
                        accept="image/jpeg,image/png"
                        multiple
                        showUploadList={false}
                        beforeUpload={(file) => { handleImageUpload(file); return false; }}
                        style={{ marginBottom: 8 }}
                      >
                        <p className="ant-upload-drag-icon"><InboxOutlined /></p>
                        <p className="ant-upload-text">点击或拖入商家产品图片</p>
                        <p className="ant-upload-hint">支持 JPG、PNG，最大 5MB（Google Ads 要求最低 300×300 像素）</p>
                      </Upload.Dragger>
                      <Space.Compact style={{ width: "100%" }}>
                        <Input
                          size="small" value={newImageUrl}
                          onChange={(e) => setNewImageUrl(e.target.value)}
                          placeholder="或粘贴图片 URL（https://...）"
                          onPressEnter={addImageUrl}
                        />
                        <Button size="small" type="primary" onClick={addImageUrl} icon={<PlusOutlined />}>添加 URL</Button>
                      </Space.Compact>
                    </>
                  )}
                </div>
            </div>

            <Divider style={{ margin: "12px 0" }} />

            {/* 宣传信息 */}
            <div>
              <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                <Checkbox checked={enableCallouts} onChange={(e) => toggleCallouts(e.target.checked)}>
                  <Space><SoundOutlined /><Text strong>宣传信息 (Callouts)</Text></Space>
                </Checkbox>
                {enableCallouts && !calloutsLoading && callouts.length > 0 && (
                  <Button size="small" type="link" icon={<ReloadOutlined />} onClick={() => generateExtension("callouts")}>重新生成</Button>
                )}
              </div>
              <Text type="secondary" style={{ fontSize: 12, display: "block", marginLeft: 24 }}>
                勾选后 AI 自动生成商家卖点，如"免费配送""24小时客服"
              </Text>
              {enableCallouts && (
                <div style={{ marginTop: 12, marginLeft: 24 }}>
                  {calloutsLoading ? (
                    <div style={{ textAlign: "center", padding: "24px 0" }}>
                      <Spin tip="正在生成宣传信息..." />
                    </div>
                  ) : (
                    <>
                      {callouts.map((c, i) => (
                        <div key={i} style={{ marginBottom: 6 }}>
                          <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
                            <Input
                              size="small" value={c} placeholder={`宣传语 ${i + 1}，如"免费配送"`}
                              maxLength={CALLOUT_MAX + 3}
                              onChange={(e) => updateCallout(i, e.target.value)}
                              style={{ flex: 1 }}
                              suffix={<Text type={c.length > CALLOUT_MAX ? "danger" : "secondary"} style={{ fontSize: 11 }}>{c.length}/{CALLOUT_MAX}</Text>}
                              status={c.length > CALLOUT_MAX ? "error" : undefined}
                            />
                            {callouts.length > 2 && (
                              <Button size="small" type="text" danger icon={<DeleteOutlined />} onClick={() => removeCallout(i)} />
                            )}
                          </div>
                          {calloutsZh[i] && (
                            <div style={{ marginLeft: 4, marginTop: 2, fontSize: 12, color: "#999", lineHeight: "18px" }}>
                              {calloutsZh[i]}
                            </div>
                          )}
                        </div>
                      ))}
                      {callouts.length < 10 && (
                        <Button type="dashed" size="small" icon={<PlusOutlined />} onClick={addCallout} block>添加宣传信息（最多 10 条）</Button>
                      )}
                    </>
                  )}
                </div>
              )}
            </div>

            <Divider style={{ margin: "12px 0" }} />

            {/* 促销扩展 */}
            <div style={{ marginBottom: 16 }}>
              <Checkbox checked={enablePromotion} onChange={(e) => {
                setEnablePromotion(e.target.checked);
                if (e.target.checked && !promotion.promotion_target) generateExtension("promotion");
              }}>
                <Space><TagOutlined /><Text strong>促销 (Promotion)</Text></Space>
              </Checkbox>
              <Text type="secondary" style={{ fontSize: 12, display: "block", marginLeft: 24 }}>勾选后自动从商家网站提取促销信息（折扣、优惠码等）</Text>
              {enablePromotion && (
                <div style={{ marginTop: 12, marginLeft: 24 }}>
                  {promotionLoading ? (
                    <div style={{ textAlign: "center", padding: "24px 0" }}>
                      <Spin tip="正在从商家网站提取促销信息..." />
                    </div>
                  ) : (
                  <Row gutter={[8, 8]}>
                    <Col span={12}>
                      <Text type="secondary" style={{ fontSize: 12 }}>促销内容（必填）</Text>
                      <Input size="small" value={promotion.promotion_target} placeholder="如：All Inclusive Deals" onChange={(e) => setPromotion((p) => ({ ...p, promotion_target: e.target.value }))} />
                    </Col>
                    <Col span={12}>
                      <Text type="secondary" style={{ fontSize: 12 }}>落地页 URL</Text>
                      <Input size="small" value={promotion.final_url} placeholder="https://..." onChange={(e) => setPromotion((p) => ({ ...p, final_url: e.target.value }))} />
                    </Col>
                    <Col span={8}>
                      <Text type="secondary" style={{ fontSize: 12 }}>折扣类型</Text>
                      <Select size="small" value={promotion.discount_type} onChange={(v) => setPromotion((p) => ({ ...p, discount_type: v }))} style={{ width: "100%" }}
                        options={[{ value: "PERCENT", label: "百分比折扣" }, { value: "MONETARY", label: "金额折扣" }]} />
                    </Col>
                    <Col span={8}>
                      {promotion.discount_type === "PERCENT" ? (
                        <><Text type="secondary" style={{ fontSize: 12 }}>折扣百分比</Text>
                        <InputNumber size="small" value={promotion.discount_percent} onChange={(v) => setPromotion((p) => ({ ...p, discount_percent: v || 0 }))} min={1} max={99} style={{ width: "100%" }} suffix="%" /></>
                      ) : (
                        <><Text type="secondary" style={{ fontSize: 12 }}>折扣金额</Text>
                        <InputNumber size="small" value={promotion.discount_amount} onChange={(v) => setPromotion((p) => ({ ...p, discount_amount: v || 0 }))} min={1} style={{ width: "100%" }} prefix={promotion.currency_code || defaultCurrencyCode} /></>
                      )}
                    </Col>
                    <Col span={8}>
                      <Text type="secondary" style={{ fontSize: 12 }}>货币</Text>
                      <Select size="small" value={promotion.currency_code} onChange={(v) => setPromotion((p) => ({ ...p, currency_code: v }))} style={{ width: "100%" }}
                        options={currencyOptions} />
                    </Col>
                    <Col span={8}>
                      <Text type="secondary" style={{ fontSize: 12 }}>促销代码（可选）</Text>
                      <Input size="small" value={promotion.promo_code} placeholder="如：SAVE20" onChange={(e) => setPromotion((p) => ({ ...p, promo_code: e.target.value }))} />
                    </Col>
                    <Col span={8}>
                      <Text type="secondary" style={{ fontSize: 12 }}>语言</Text>
                      <Select size="small" value={promotion.language_code} onChange={(v) => setPromotion((p) => ({ ...p, language_code: v }))} style={{ width: "100%" }}
                        options={GOOGLE_ADS_LANGUAGES.map((item) => ({ value: item.code, label: item.name }))} />
                    </Col>
                    <Col span={8}>
                      <Text type="secondary" style={{ fontSize: 12 }}>促销场合（可选）</Text>
                      <Select size="small" value={promotion.occasion || undefined} onChange={(v) => setPromotion((p) => ({ ...p, occasion: v }))} allowClear placeholder="选择场合" style={{ width: "100%" }}
                        options={[
                          { value: "NEW_YEARS", label: "新年" }, { value: "VALENTINES_DAY", label: "情人节" },
                          { value: "EASTER", label: "复活节" }, { value: "MOTHERS_DAY", label: "母亲节" },
                          { value: "FATHERS_DAY", label: "父亲节" }, { value: "LABOR_DAY", label: "劳动节" },
                          { value: "BACK_TO_SCHOOL", label: "返校季" }, { value: "HALLOWEEN", label: "万圣节" },
                          { value: "BLACK_FRIDAY", label: "黑五" }, { value: "CYBER_MONDAY", label: "网一" },
                          { value: "CHRISTMAS", label: "圣诞节" }, { value: "BOXING_DAY", label: "节礼日" },
                          { value: "INDEPENDENCE_DAY", label: "独立日" }, { value: "SINGLES_DAY", label: "双十一" },
                          { value: "YEAR_END_GIFT", label: "年终礼" },
                        ]} />
                    </Col>
                  </Row>
                  )}
                </div>
              )}
            </div>

            <Divider style={{ margin: "12px 0" }} />

            {/* 价格扩展 */}
            <div style={{ marginBottom: 16 }}>
              <Checkbox checked={enablePrice} onChange={(e) => {
                setEnablePrice(e.target.checked);
                if (e.target.checked && priceItems.length === 0) {
                  generateExtension("price");
                  setPriceItems([
                    { header: "", description: "", price_amount: 0, currency_code: defaultCurrencyCode, final_url: "" },
                    { header: "", description: "", price_amount: 0, currency_code: defaultCurrencyCode, final_url: "" },
                    { header: "", description: "", price_amount: 0, currency_code: defaultCurrencyCode, final_url: "" },
                  ]);
                }
              }}>
                <Space><DollarOutlined /><Text strong>价格 (Price)</Text></Space>
              </Checkbox>
              <Text type="secondary" style={{ fontSize: 12, display: "block", marginLeft: 24 }}>勾选后自动从商家网站提取产品价格信息</Text>
              {enablePrice && (
                <div style={{ marginTop: 12, marginLeft: 24 }}>
                  {priceLoading ? (
                    <div style={{ textAlign: "center", padding: "24px 0" }}>
                      <Spin tip="正在从商家网站提取价格信息..." />
                    </div>
                  ) : (
                  <>
                  <div style={{ marginBottom: 8 }}>
                    <Text type="secondary" style={{ fontSize: 12 }}>价格类型</Text>
                    <Select size="small" value={priceType} onChange={setPriceType} style={{ width: "100%", marginTop: 4 }}
                      options={[
                        { value: "BRANDS", label: "品牌" }, { value: "EVENTS", label: "活动" },
                        { value: "LOCATIONS", label: "地点" }, { value: "NEIGHBORHOODS", label: "区域" },
                        { value: "PRODUCT_CATEGORIES", label: "产品类别" }, { value: "PRODUCT_TIERS", label: "产品层级" },
                        { value: "SERVICES", label: "服务" }, { value: "SERVICE_CATEGORIES", label: "服务类别" },
                        { value: "SERVICE_TIERS", label: "服务层级" },
                      ]} />
                  </div>
                  {priceItems.map((item, i) => (
                    <Card key={i} size="small" style={{ marginBottom: 8, background: "#fafafa" }}
                      title={<Text type="secondary" style={{ fontSize: 12 }}>价格项 {i + 1}</Text>}
                      extra={priceItems.length > 3 && <Button size="small" type="text" danger icon={<DeleteOutlined />} onClick={() => setPriceItems((prev) => prev.filter((_, idx) => idx !== i))} />}
                    >
                      <Row gutter={[8, 8]}>
                        <Col span={12}>
                          <Input size="small" value={item.header} placeholder="标题（必填，≤25字符）" maxLength={28}
                            onChange={(e) => setPriceItems((prev) => { const n = [...prev]; n[i] = { ...n[i], header: e.target.value }; return n; })} />
                        </Col>
                        <Col span={12}>
                          <Input size="small" value={item.description} placeholder="描述（≤25字符）" maxLength={28}
                            onChange={(e) => setPriceItems((prev) => { const n = [...prev]; n[i] = { ...n[i], description: e.target.value }; return n; })} />
                        </Col>
                        <Col span={8}>
                          <InputNumber size="small" value={item.price_amount} min={0} step={0.01} style={{ width: "100%" }} prefix={item.currency_code || defaultCurrencyCode}
                            onChange={(v) => setPriceItems((prev) => { const n = [...prev]; n[i] = { ...n[i], price_amount: v || 0 }; return n; })} />
                        </Col>
                        <Col span={8}>
                          <Select size="small" value={item.currency_code} style={{ width: "100%" }}
                            onChange={(v) => setPriceItems((prev) => { const n = [...prev]; n[i] = { ...n[i], currency_code: v }; return n; })}
                            options={currencyOptions} />
                        </Col>
                        <Col span={8}>
                          <Input size="small" value={item.final_url} placeholder="链接 URL"
                            onChange={(e) => setPriceItems((prev) => { const n = [...prev]; n[i] = { ...n[i], final_url: e.target.value }; return n; })} />
                        </Col>
                      </Row>
                    </Card>
                  ))}
                  {priceItems.length < 8 && (
                    <Button type="dashed" size="small" icon={<PlusOutlined />} block
                      onClick={() => setPriceItems((prev) => [...prev, { header: "", description: "", price_amount: 0, currency_code: defaultCurrencyCode, final_url: "" }])}>
                      添加价格项（最多 8 项）
                    </Button>
                  )}
                  </>
                  )}
                </div>
              )}
            </div>

            <Divider style={{ margin: "12px 0" }} />

            {/* 致电扩展 */}
            <div style={{ marginBottom: 16 }}>
              <Checkbox checked={enableCall} onChange={(e) => {
                setEnableCall(e.target.checked);
                if (e.target.checked && !callPhoneNumber) generateExtension("call");
              }}>
                <Space><PhoneOutlined /><Text strong>致电 (Call)</Text></Space>
              </Checkbox>
              <Text type="secondary" style={{ fontSize: 12, display: "block", marginLeft: 24 }}>勾选后自动从商家网站提取联系电话，用户可直接拨打</Text>
              {enableCall && (
                <div style={{ marginTop: 12, marginLeft: 24 }}>
                  {callLoading ? (
                    <div style={{ textAlign: "center", padding: "24px 0" }}>
                      <Spin tip="正在从商家网站提取联系电话..." />
                    </div>
                  ) : (
                  <Row gutter={8}>
                    <Col span={8}>
                      <Text type="secondary" style={{ fontSize: 12 }}>国家代码</Text>
                      <Select size="small" value={callCountryCode} onChange={setCallCountryCode} style={{ width: "100%", marginTop: 4 }}
                        options={[
                          { value: "US", label: "US (+1)" }, { value: "GB", label: "GB (+44)" },
                          { value: "CA", label: "CA (+1)" }, { value: "AU", label: "AU (+61)" },
                          { value: "DE", label: "DE (+49)" }, { value: "FR", label: "FR (+33)" },
                          { value: "JP", label: "JP (+81)" }, { value: "BR", label: "BR (+55)" },
                        ]} />
                    </Col>
                    <Col span={16}>
                      <Text type="secondary" style={{ fontSize: 12 }}>电话号码</Text>
                      <Input size="small" value={callPhoneNumber} placeholder="如：+1-800-123-4567"
                        onChange={(e) => setCallPhoneNumber(e.target.value)} style={{ marginTop: 4 }} />
                    </Col>
                  </Row>
                  )}
                </div>
              )}
            </div>

            <Divider style={{ margin: "12px 0" }} />

            {/* 结构化摘要 */}
            <div>
              <Checkbox checked={enableSnippet} onChange={(e) => {
                setEnableSnippet(e.target.checked);
                if (e.target.checked && snippetValues.every((v) => !v.trim())) generateExtension("snippet");
              }}>
                <Space><UnorderedListOutlined /><Text strong>结构化摘要 (Structured Snippet)</Text></Space>
              </Checkbox>
              <Text type="secondary" style={{ fontSize: 12, display: "block", marginLeft: 24 }}>勾选后自动从商家网站提取产品/服务属性列表</Text>
              {enableSnippet && (
                <div style={{ marginTop: 12, marginLeft: 24 }}>
                  {snippetLoading ? (
                    <div style={{ textAlign: "center", padding: "24px 0" }}>
                      <Spin tip="正在从商家网站提取结构化摘要..." />
                    </div>
                  ) : (
                  <>
                  <div style={{ marginBottom: 8 }}>
                    <Text type="secondary" style={{ fontSize: 12 }}>标题类型</Text>
                    <Select size="small" value={snippetHeader} onChange={setSnippetHeader} style={{ width: "100%", marginTop: 4 }}
                      options={[
                        { value: "Brands", label: "品牌 (Brands)" }, { value: "Courses", label: "课程 (Courses)" },
                        { value: "Degree programs", label: "学位 (Degree programs)" }, { value: "Destinations", label: "目的地 (Destinations)" },
                        { value: "Featured hotels", label: "精选酒店 (Featured hotels)" }, { value: "Insurance coverage", label: "保险 (Insurance coverage)" },
                        { value: "Models", label: "型号 (Models)" }, { value: "Neighborhoods", label: "区域 (Neighborhoods)" },
                        { value: "Service catalog", label: "服务目录 (Service catalog)" }, { value: "Shows", label: "节目 (Shows)" },
                        { value: "Styles", label: "风格 (Styles)" }, { value: "Types", label: "类型 (Types)" },
                        { value: "Amenities", label: "设施 (Amenities)" },
                      ]} />
                  </div>
                  {snippetValues.map((v, i) => (
                    <div key={i} style={{ display: "flex", gap: 8, marginBottom: 6, alignItems: "center" }}>
                      <Input size="small" value={v} placeholder={`值 ${i + 1}（≤25字符）`} maxLength={28}
                        onChange={(e) => setSnippetValues((prev) => { const n = [...prev]; n[i] = e.target.value; return n; })}
                        style={{ flex: 1 }} />
                      {snippetValues.length > 3 && (
                        <Button size="small" type="text" danger icon={<DeleteOutlined />}
                          onClick={() => setSnippetValues((prev) => prev.filter((_, idx) => idx !== i))} />
                      )}
                    </div>
                  ))}
                  {snippetValues.length < 10 && (
                    <Button type="dashed" size="small" icon={<PlusOutlined />} block
                      onClick={() => setSnippetValues((prev) => [...prev, ""])}>
                      添加值（最少 3 个，最多 10 个）
                    </Button>
                  )}
                  </>
                  )}
                </div>
              )}
            </div>
          </Card>
        </Col>

        {/* ─── 右侧：广告设置 ─── */}
        <Col span={8}>
          <Card title="发布账户 (CID)" size="small" style={{ marginBottom: 16 }}>
            <div style={{ marginBottom: 12 }}>
              <Text type="secondary">MCC 账户</Text>
              <Select
                value={selectedMccId || undefined}
                onChange={handleMccChange}
                placeholder="选择 MCC 账户"
                style={{ width: "100%", marginTop: 4 }}
                options={(preview.mccAccounts || []).map((m: any) => ({
                  value: String(m.id),
                  label: `${m.mcc_name || m.mcc_id} (${m.mcc_id})`,
                }))}
                notFoundContent="暂无 MCC 账户，请先在系统设置中配置"
              />
            </div>
            <div>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                <Text type="secondary">CID 客户账户</Text>
                {selectedMccId && (
                  <Button
                    size="small" type="link"
                    icon={<ReloadOutlined />}
                    loading={cidSyncing}
                    onClick={syncCids}
                  >
                    {cidList.length === 0 ? "从 MCC 同步 CID" : "重新同步"}
                  </Button>
                )}
              </div>
              <Select
                value={selectedCid || undefined}
                onChange={setSelectedCid}
                placeholder={cidLoading ? "加载中..." : cidSyncing ? "同步中..." : "选择 CID"}
                loading={cidLoading || cidSyncing}
                style={{ width: "100%", marginTop: 4 }}
                showSearch
                optionFilterProp="label"
                options={cidList.map((c) => ({
                  value: c.customer_id,
                  label: `${formatCid(c.customer_id)}${c.customer_name ? ` - ${c.customer_name}` : ""}`,
                  disabled: c.is_available !== "Y",
                }))}
                optionRender={(option) => {
                  const cid = cidList.find((c) => c.customer_id === option.value);
                  return (
                    <Space>
                      <Text>{option.label}</Text>
                      {cid?.is_available === "Y"
                        ? <Tag color="green" style={{ fontSize: 10, lineHeight: "16px", margin: 0 }}>可用</Tag>
                        : <Tag color="red" style={{ fontSize: 10, lineHeight: "16px", margin: 0 }}>已占用</Tag>}
                    </Space>
                  );
                }}
                notFoundContent={
                  selectedMccId
                    ? <div style={{ textAlign: "center", padding: 8 }}>
                        <Text type="secondary">该 MCC 下暂无 CID</Text>
                        <br />
                        <Button size="small" type="link" loading={cidSyncing} onClick={syncCids}>
                          点击从 Google Ads 同步
                        </Button>
                      </div>
                    : "请先选择 MCC 账户"
                }
              />
            </div>
            {selectedCid && (
              <div style={{ marginTop: 8, padding: "6px 8px", background: "#f6ffed", borderRadius: 4, border: "1px solid #b7eb8f" }}>
                <Text style={{ fontSize: 12 }}>将发布到 CID: <Text strong copyable style={{ fontSize: 12 }}>{formatCid(selectedCid)}</Text></Text>
              </div>
            )}
          </Card>

          <Card title={<><ThunderboltOutlined /> 广告设置</>} size="small" style={{ marginBottom: 16 }}>
            <div style={{ marginBottom: 12 }}>
              <Text type="secondary">每日预算 ({defaultCurrencyCode})</Text>
              <InputNumber value={budget} onChange={(v) => setBudget(v || 2)} min={0.5} step={0.5} style={{ width: "100%", marginTop: 4 }} prefix="$" />
            </div>
            <div style={{ marginBottom: 12 }}>
              <Text type="secondary">出价策略</Text>
              <Select value={biddingStrategy} onChange={setBiddingStrategy} style={{ width: "100%", marginTop: 4 }}
                options={BIDDING_STRATEGIES.map((b: any) => ({ value: b.value || b, label: b.label || b }))}
              />
            </div>
            <div style={{ marginBottom: 12 }}>
              <Text type="secondary">最高 CPC ({defaultCurrencyCode})</Text>
              <InputNumber value={maxCpc} onChange={(v) => setMaxCpc(v || 0.3)} min={0.01} step={0.05} style={{ width: "100%", marginTop: 4 }} prefix="$" />
            </div>
            <Divider style={{ margin: "8px 0" }}>广告语言</Divider>
            <div style={{ marginBottom: 12 }}>
              <Select
                value={adLanguage || undefined}
                onChange={setAdLanguage}
                placeholder="选择广告语言"
                style={{ width: "100%" }}
                showSearch
                optionFilterProp="label"
                options={GOOGLE_ADS_LANGUAGES.map((l) => ({
                  value: l.code,
                  label: `${l.name} (${l.code})`,
                }))}
              />
              <Text type="secondary" style={{ fontSize: 11, display: "block", marginTop: 4 }}>
                Google Ads 广告系列的语言定向，决定广告向哪些语言用户展示
              </Text>
            </div>
            <Divider style={{ margin: "8px 0" }}>投放网络</Divider>
            <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
              <Space><Switch checked={networkSearch} onChange={setNetworkSearch} size="small" /><Text>搜索网络</Text></Space>
              <Space><Switch checked={networkPartners} onChange={setNetworkPartners} size="small" /><Text>搜索合作伙伴</Text></Space>
              <Space><Switch checked={networkDisplay} onChange={setNetworkDisplay} size="small" /><Text>展示网络</Text></Space>
            </div>
            <Divider style={{ margin: "8px 0" }}>EU 政治广告</Divider>
            <Space>
              <Switch
                checked={euPoliticalAd === 1}
                onChange={(checked) => setEuPoliticalAd(checked ? 1 : 0)}
                size="small"
                checkedChildren="含"
                unCheckedChildren="不含"
              />
              <Tooltip title="如果您的广告涉及欧盟政治内容，需要开启此选项。大多数商家广告应关闭。">
                <Text type="secondary" style={{ fontSize: 12, cursor: "help" }}>包含 EU 政治广告</Text>
              </Tooltip>
            </Space>
          </Card>

          <Card title="商家信息" size="small" style={{ marginBottom: 16 }}>
            <div><Text type="secondary">商家：</Text><Text strong>{preview.merchant?.merchant_name}</Text></div>
            <div><Text type="secondary">平台：</Text><Tag>{preview.merchant?.platform}</Tag></div>
            <div><Text type="secondary">国家：</Text><Tag color="blue">{preview.campaign?.target_country}</Tag></div>
            <div><Text type="secondary">广告语言：</Text><Tag color="orange">{GOOGLE_ADS_LANGUAGES.find((l) => l.code === adLanguage)?.name || adLanguage || "English"}</Tag></div>
            {preview.adCreative?.final_url && (
              <div style={{ marginTop: 4 }}><Text type="secondary">落地页：</Text><Text copyable style={{ fontSize: 12 }}>{preview.adCreative.final_url}</Text></div>
            )}
          </Card>

          <Popconfirm
            title="确认提交广告到 Google Ads？"
            description="提交后将在 Google Ads 中创建广告系列、广告组和广告。"
            onConfirm={handleSubmit}
            okText="确认提交"
            cancelText="取消"
            disabled={!isReady || submitting || !!preview.campaign?.google_campaign_id}
          >
            <Button
              type="primary" size="large" block
              icon={submitting ? <LoadingOutlined /> : <RocketOutlined />}
              loading={submitting}
              disabled={!isReady || !!preview.campaign?.google_campaign_id}
            >
              {preview.campaign?.google_campaign_id ? "已提交到 Google Ads" : submitting ? "提交中..." : "提交到 Google Ads"}
            </Button>
          </Popconfirm>
        </Col>
      </Row>
    </div>
  );
}
