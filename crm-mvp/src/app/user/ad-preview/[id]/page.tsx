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
} from "@ant-design/icons";
import { useApiWithParams, mutateApi } from "@/lib/swr";
import { BIDDING_STRATEGIES } from "@/lib/constants";

const { Title, Text } = Typography;
const { TextArea } = Input;

const HEADLINE_MAX = 30;
const DESC_MAX = 90;
const SITELINK_TITLE_MAX = 25;
const SITELINK_DESC_MAX = 35;
const CALLOUT_MAX = 25;

function formatCid(cid: string): string {
  const digits = cid.replace(/\D/g, "");
  if (digits.length === 10) return `${digits.slice(0, 3)}-${digits.slice(3, 6)}-${digits.slice(6)}`;
  return cid;
}

// 国家 → Google Ads 语言代码
const COUNTRY_TO_GOOGLE_LANG: Record<string, string> = {
  US: "en", UK: "en", CA: "en", AU: "en", IE: "en", SG: "en", NZ: "en", PH: "en", IN: "en",
  DE: "de", AT: "de", CH: "de",
  FR: "fr", BE: "fr",
  ES: "es", MX: "es", AR: "es", CL: "es", CO: "es",
  IT: "it", PT: "pt", BR: "pt", NL: "nl",
  JP: "ja", KR: "ko", CN: "zh_CN", TW: "zh_TW", HK: "zh_TW",
  RU: "ru", PL: "pl", SE: "sv", NO: "no", DK: "da", FI: "fi", CZ: "cs",
  TR: "tr", TH: "th", VN: "vi", ID: "id", MY: "ms",
  SA: "ar", AE: "ar", IL: "iw", GR: "el", RO: "ro", HU: "hu", BG: "bg",
};

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

interface AdPreviewData {
  campaign: any;
  adGroup: any;
  adCreative: any;
  keywords: { id: string; keyword_text: string; match_type: string }[];
  adSettings: any;
  merchant: any;
  mccAccounts?: { id: string | number; [key: string]: any }[];
  isReady: boolean;
}

export default function AdPreviewPage() {
  const params = useParams();
  const router = useRouter();
  const { message } = App.useApp();
  const campaignId = params.id as string;

  // 核心编辑状态
  const [headlines, setHeadlines] = useState<string[]>([]);
  const [descriptions, setDescriptions] = useState<string[]>([]);
  const [kwList, setKwList] = useState<{ text: string; matchType: string }[]>([]);
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

  // 可选扩展模块
  const [enableSitelinks, setEnableSitelinks] = useState(false);
  const [sitelinks, setSitelinks] = useState<SitelinkItem[]>([]);
  const [sitelinksLoading, setSitelinksLoading] = useState(false);
  const [enableImages, setEnableImages] = useState(false);
  const [imageUrls, setImageUrls] = useState<string[]>([]);
  const [newImageUrl, setNewImageUrl] = useState("");
  const [imagesLoading, setImagesLoading] = useState(false);
  const [enableCallouts, setEnableCallouts] = useState(false);
  const [callouts, setCallouts] = useState<string[]>([]);
  const [calloutsLoading, setCalloutsLoading] = useState(false);
  const [crawlFailed, setCrawlFailed] = useState(false);

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

  // 轮询获取数据 — 就绪后停止
  const { data: preview, isLoading, mutate } = useApiWithParams<AdPreviewData>(
    "/api/user/ad-creation/status",
    { campaign_id: campaignId },
    { refreshInterval: initialized ? 0 : 5000 },
  );
  const isReady = preview?.isReady ?? false;

  // 数据就绪后初始化编辑状态
  useEffect(() => {
    if (!preview || initialized || !isReady) return;
    const h = preview.adCreative?.headlines || [];
    const d = preview.adCreative?.descriptions || [];
    setHeadlines(h.length > 0 ? h : Array(15).fill(""));
    setDescriptions(d.length > 0 ? d : Array(4).fill(""));
    setHeadlinesZh(preview.adCreative?.headlines_zh || []);
    setDescriptionsZh(preview.adCreative?.descriptions_zh || []);
    setKwList((preview.keywords || []).map((k: any) => ({ text: k.keyword_text, matchType: k.match_type })));
    const c = preview.campaign;
    const s = preview.adSettings;
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
      setAdLanguage(COUNTRY_TO_GOOGLE_LANG[country] || "en");
    }
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
    const existingSitelinks = preview.adCreative?.sitelinks as SitelinkItem[] | null;
    if (existingSitelinks?.length) {
      setEnableSitelinks(true);
      setSitelinks(existingSitelinks.map((s: any) => ({
        title: s.title || "", desc1: s.desc1 || s.description1 || "",
        desc2: s.desc2 || s.description2 || "", url: s.url || s.finalUrl || "",
        urlStatus: s.url ? "valid" : "",
      })));
    }
    const existingCallouts = preview.adCreative?.callouts as string[] | null;
    if (existingCallouts?.length) {
      setEnableCallouts(true);
      setCallouts(existingCallouts);
    }
    setInitialized(true);
  }, [preview, isReady, initialized]);

  // ─── 生成中文翻译（仅参考，不影响广告内容） ───
  const generateZhTranslation = useCallback(async () => {
    const validH = headlines.filter((h) => h.trim().length > 0);
    const validD = descriptions.filter((d) => d.trim().length > 0);
    const validC = enableCallouts ? callouts.filter((c) => c.trim().length > 0) : [];
    const validS = enableSitelinks ? sitelinks.filter((s) => s.title.trim().length > 0).map((s) => ({
      title: s.title, desc1: s.desc1, desc2: s.desc2,
    })) : [];
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
  }, [headlines, descriptions, callouts, enableCallouts, sitelinks, enableSitelinks, preview, message]);

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
  }, [headlines, preview, message]);

  // ─── AI 生成更多描述 ───
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
  }, [descriptions, preview, message]);

  // ─── 关键词操作 ───
  const addKeyword = () => {
    if (newKeyword.trim()) {
      setKwList((prev) => [...prev, { text: newKeyword.trim(), matchType: "PHRASE" }]);
      setNewKeyword("");
    }
  };
  const removeKeyword = (idx: number) => setKwList((prev) => prev.filter((_, i) => i !== idx));

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
        body: JSON.stringify({ merchant_url: merchantUrl, country }),
      });
      const json = await res.json();
      if (json.code !== 0) { message.error(json.message || "SemRush 查询失败"); return; }
      const kws = json.data?.keywords || [];
      if (kws.length === 0) { message.warning("SemRush 未找到该商家的关键词"); return; }
      const existing = new Set(kwList.map((k) => k.text.toLowerCase()));
      const newKws = kws
        .filter((kw: any) => !existing.has((kw.phrase || "").toLowerCase()))
        .map((kw: any) => ({ text: kw.phrase, matchType: "PHRASE" }));
      if (newKws.length > 0) {
        setKwList((prev) => [...prev, ...newKws]);
        message.success(`已从 SemRush 获取 ${newKws.length} 个关键词`);
      } else {
        message.info("SemRush 关键词已全部存在");
      }
    } catch (err: any) {
      message.error(err?.message || "关键词获取失败");
    } finally {
      setKwFetching(false);
    }
  }, [preview, kwList, message]);

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
  const generateExtension = useCallback(async (type: "sitelinks" | "images" | "callouts") => {
    if (type === "sitelinks") setSitelinksLoading(true);
    if (type === "images") setImagesLoading(true);
    if (type === "callouts") setCalloutsLoading(true);
    try {
      const res = await fetch("/api/user/ad-creation/generate-extensions", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ campaign_id: campaignId, types: [type] }),
      });
      const json = await res.json();
      if (json.code !== 0) { message.error(json.message || "生成失败"); return; }
      const data = json.data;

      if (data.crawl_failed) setCrawlFailed(true);

      if (type === "sitelinks" && data.sitelinks !== undefined) {
        const items: SitelinkItem[] = data.sitelinks.map((s: any) => ({
          title: s.title || "", desc1: s.desc1 || "", desc2: s.desc2 || "",
          url: s.url || "", urlStatus: s.url ? "" as const : "" as const,
        }));
        if (items.length > 0) {
          setSitelinks(items);
          message.success(`已从商家网站获取 ${items.length} 条真实链接，请验证`);
        } else {
          setSitelinks([{ title: "", desc1: "", desc2: "", url: "", urlStatus: "" }, { title: "", desc1: "", desc2: "", url: "", urlStatus: "" }]);
          message.warning(data.crawl_failed
            ? "无法爬取商家网站，请手动输入链接（输入 URL 后自动获取标题）"
            : "未找到可用链接，请手动添加");
        }
      }
      if (type === "images" && data.images !== undefined) {
        setImageUrls(data.images);
        if (data.images.length > 0) {
          message.success(`已从商家网站提取 ${data.images.length} 张真实图片`);
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
    } catch (err: any) {
      message.error(err?.message || "生成失败，请手动填写");
    } finally {
      if (type === "sitelinks") setSitelinksLoading(false);
      if (type === "images") setImagesLoading(false);
      if (type === "callouts") setCalloutsLoading(false);
    }
  }, [campaignId, message]);

  // ─── 手动输入 URL → 自动获取标题和描述 + 验证 ───
  const fetchUrlMeta = useCallback(async (idx: number) => {
    const url = sitelinks[idx]?.url;
    if (!url || !url.startsWith("http")) return;
    setSitelinks((prev) => { const n = [...prev]; n[idx] = { ...n[idx], urlStatus: "checking" }; return n; });
    try {
      // 同时获取元数据和验证链接
      const [metaRes, checkRes] = await Promise.all([
        fetch(`/api/user/ad-creation/fetch-url-meta?url=${encodeURIComponent(url)}`),
        fetch(`/api/user/ad-creation/check-url?url=${encodeURIComponent(url)}`),
      ]);
      const metaJson = await metaRes.json();
      const checkJson = await checkRes.json();

      const isValid = checkJson?.data?.ok === true;
      const metaOk = metaJson.code === 0 && metaJson.data?.ok;

      setSitelinks((prev) => {
        const n = [...prev];
        n[idx] = {
          ...n[idx],
          title: n[idx].title || (metaOk ? metaJson.data.title : "") || "",
          desc1: n[idx].desc1 || (metaOk ? metaJson.data.description : "") || "",
          urlStatus: isValid ? "valid" : "invalid",
        };
        return n;
      });

      if (metaOk) {
        message.success("已自动获取页面标题和描述");
      } else if (isValid) {
        message.info("链接有效，但无法获取页面信息，请手动填写标题");
      } else {
        message.error(checkJson?.data?.reason || "链接不可用");
      }
    } catch {
      setSitelinks((prev) => { const n = [...prev]; n[idx] = { ...n[idx], urlStatus: "valid" }; return n; });
    }
  }, [sitelinks, message]);

  // ─── 图片上传 ───
  const handleImageUpload = useCallback(async (file: File) => {
    const formData = new FormData();
    formData.append("file", file);
    try {
      const res = await fetch("/api/user/ad-creation/upload-image", { method: "POST", body: formData });
      const json = await res.json();
      if (json.code === 0 && json.data?.url) {
        setImageUrls((prev) => [...prev, json.data.url]);
        message.success("图片上传成功");
      } else {
        message.error(json.message || "上传失败");
      }
    } catch {
      message.error("图片上传失败");
    }
    return false;
  }, [message]);

  // 勾选时自动触发 AI 生成
  const toggleSitelinks = useCallback((checked: boolean) => {
    setEnableSitelinks(checked);
    if (checked && sitelinks.length === 0) generateExtension("sitelinks");
  }, [sitelinks.length, generateExtension]);

  const toggleImages = useCallback((checked: boolean) => {
    setEnableImages(checked);
    if (checked && imageUrls.length === 0) generateExtension("images");
  }, [imageUrls.length, generateExtension]);

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

  const validateSitelinkUrl = useCallback(async (idx: number) => {
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
      const res = await fetch(`/api/user/ad-creation/check-url?url=${encodeURIComponent(url)}`);
      const data = await res.json();
      const isValid = data?.data?.ok === true;
      setSitelinks((prev) => {
        const n = [...prev];
        n[idx] = { ...n[idx], urlStatus: isValid ? "valid" : "invalid" };
        return n;
      });
      if (!isValid) message.error(data?.data?.reason || "链接不可用（404 或无法访问）");
    } catch {
      setSitelinks((prev) => { const n = [...prev]; n[idx] = { ...n[idx], urlStatus: "valid" }; return n; });
    }
  }, [sitelinks, preview, message]);

  const validateAllSitelinks = useCallback(async () => {
    const validIndices = sitelinks
      .map((sl, i) => ({ sl, i }))
      .filter(({ sl }) => sl.url.trim().length > 0 && sl.urlStatus !== "checking");
    if (validIndices.length === 0) { message.warning("没有需要验证的链接"); return; }
    await Promise.all(validIndices.map(({ i }) => validateSitelinkUrl(i)));
  }, [sitelinks, validateSitelinkUrl, message]);

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

    // 验证站内链接
    if (enableSitelinks) {
      const validLinks = sitelinks.filter((s) => s.title.trim() && s.url.trim());
      if (validLinks.length < 2) { message.error("站内链接至少需要 2 条（标题和链接必填）"); return; }
      const invalidLinks = validLinks.filter((s) => s.urlStatus === "invalid");
      if (invalidLinks.length > 0) { message.error("有站内链接验证失败，请修正后提交"); return; }
      const unchecked = validLinks.filter((s) => s.urlStatus !== "valid");
      if (unchecked.length > 0) { message.error("请先验证所有站内链接"); return; }
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
      if (enableSitelinks) {
        submitBody.sitelinks = sitelinks
          .filter((s) => s.title.trim() && s.url.trim())
          .map((s) => ({ title: s.title, description1: s.desc1, description2: s.desc2, finalUrl: s.url }));
      }
      if (enableImages && imageUrls.length > 0) {
        submitBody.image_urls = imageUrls;
      }
      if (enableCallouts) {
        submitBody.callouts = callouts.filter((c) => c.trim().length > 0);
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
  }, [headlines, descriptions, kwList, budget, maxCpc, biddingStrategy, networkSearch, networkPartners, networkDisplay, campaignId, message, router, enableSitelinks, sitelinks, enableImages, imageUrls, enableCallouts, callouts, selectedCid, selectedMccId, adLanguage, euPoliticalAd]);

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
            {kwList.length === 0 && !kwFetching && (
              <Alert
                type="info" showIcon
                message="暂无关键词"
                description="点击右上角「从 SemRush 获取关键词」自动获取竞品关键词，或手动输入添加。"
                style={{ marginBottom: 8 }}
              />
            )}
            {kwFetching && (
              <div style={{ textAlign: "center", padding: "16px 0" }}>
                <Spin tip="正在从 SemRush 获取竞品关键词..." />
              </div>
            )}
            <Space wrap style={{ marginBottom: 8 }}>
              {kwList.map((kw, i) => (
                <Tag key={`${kw.text}-${kw.matchType}-${i}`} closable onClose={(e: React.MouseEvent) => { e.preventDefault(); removeKeyword(i); }} color="blue">
                  <Tooltip title={kw.matchType}>
                    {kw.matchType === "EXACT" ? `[${kw.text}]` : kw.matchType === "PHRASE" ? `"${kw.text}"` : kw.text}
                  </Tooltip>
                </Tag>
              ))}
            </Space>
            <Space.Compact style={{ width: "100%" }}>
              <Input
                value={newKeyword} onChange={(e) => setNewKeyword(e.target.value)}
                placeholder="输入关键词" onPressEnter={addKeyword}
              />
              <Button type="primary" onClick={addKeyword} icon={<PlusOutlined />}>添加</Button>
            </Space.Compact>
          </Card>

          {/* ─── 广告扩展（可选） ─── */}
          <Card title="广告扩展（可选）" size="small" style={{ marginBottom: 16 }}>

            {/* 站内链接 */}
            <div style={{ marginBottom: 16 }}>
              <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                <Checkbox checked={enableSitelinks} onChange={(e) => toggleSitelinks(e.target.checked)}>
                  <Space><LinkOutlined /><Text strong>站内链接 (Sitelinks)</Text></Space>
                </Checkbox>
                {enableSitelinks && !sitelinksLoading && sitelinks.length > 0 && (
                  <Button size="small" type="link" icon={<ReloadOutlined />} onClick={() => generateExtension("sitelinks")}>重新爬取</Button>
                )}
              </div>
              <Text type="secondary" style={{ fontSize: 12, display: "block", marginLeft: 24 }}>
                勾选后自动爬取商家网站获取真实链接。如爬取失败，可手动输入 URL，系统会自动获取标题和描述
              </Text>
              {crawlFailed && enableSitelinks && !sitelinksLoading && sitelinks.every((sl) => !sl.url) && (
                <Alert
                  type="warning" showIcon icon={<WarningOutlined />}
                  message="商家网站爬取失败（可能有反爬保护且无 sitemap）"
                  description="请手动输入商家网站的页面链接（如：https://www.example.com/sale），输入后点击「获取」自动填充标题和描述"
                  style={{ marginTop: 8, marginLeft: 24 }}
                />
              )}
              {enableSitelinks && (
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
                                      fetchUrlMeta(i);
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
                                    onClick={() => sl.title ? validateSitelinkUrl(i) : fetchUrlMeta(i)}
                                    disabled={!sl.url.trim() || sl.urlStatus === "checking"}
                                  >
                                    {sl.title ? "验证" : "获取"}
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
              )}
            </div>

            <Divider style={{ margin: "12px 0" }} />

            {/* 商家图片 */}
            <div style={{ marginBottom: 16 }}>
              <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                <Checkbox checked={enableImages} onChange={(e) => toggleImages(e.target.checked)}>
                  <Space><PictureOutlined /><Text strong>商家图片</Text></Space>
                </Checkbox>
                {enableImages && !imagesLoading && imageUrls.length > 0 && (
                  <Button size="small" type="link" icon={<ReloadOutlined />} onClick={() => generateExtension("images")}>重新提取</Button>
                )}
              </div>
              <Text type="secondary" style={{ fontSize: 12, display: "block", marginLeft: 24 }}>
                勾选后自动从商家网站爬取产品图片。如爬取失败，可拖入图片或粘贴图片 URL
              </Text>
              {enableImages && !imagesLoading && imageUrls.length === 0 && (
                <Alert
                  type="warning" showIcon icon={<WarningOutlined />}
                  message="未自动获取到商家图片"
                  description="请将商家产品图片拖入下方区域上传，或手动粘贴图片 URL"
                  style={{ marginTop: 8, marginLeft: 24 }}
                />
              )}
              {enableImages && (
                <div style={{ marginTop: 12, marginLeft: 24 }}>
                  {imagesLoading ? (
                    <div style={{ textAlign: "center", padding: "24px 0" }}>
                      <Spin tip="正在从商家网站提取图片..." />
                    </div>
                  ) : (
                    <>
                      {imageUrls.length > 0 && (
                        <Space wrap style={{ marginBottom: 8 }}>
                          {imageUrls.map((url, i) => (
                            <div key={url + i} style={{ position: "relative", display: "inline-block" }}>
                              <Image
                                src={url} alt={`img-${i}`}
                                width={80} height={80}
                                style={{ objectFit: "cover", borderRadius: 6, border: "1px solid #d9d9d9" }}
                                fallback="data:image/svg+xml;base64,PHN2ZyB3aWR0aD0iODAiIGhlaWdodD0iODAiIHhtbG5zPSJodHRwOi8vd3d3LnczLm9yZy8yMDAwL3N2ZyI+PHJlY3Qgd2lkdGg9IjgwIiBoZWlnaHQ9IjgwIiBmaWxsPSIjZjVmNWY1Ii8+PHRleHQgeD0iNDAiIHk9IjQ0IiB0ZXh0LWFuY2hvcj0ibWlkZGxlIiBmaWxsPSIjYmZiZmJmIiBmb250LXNpemU9IjEyIj7ml6Dms5XliqDovb08L3RleHQ+PC9zdmc+"
                              />
                              <Button
                                size="small" type="text" danger icon={<DeleteOutlined />}
                                style={{ position: "absolute", top: -4, right: -4, background: "#fff", borderRadius: "50%", boxShadow: "0 1px 3px rgba(0,0,0,.2)", width: 20, height: 20, padding: 0, fontSize: 10 }}
                                onClick={() => removeImage(i)}
                              />
                            </div>
                          ))}
                        </Space>
                      )}
                      <Upload.Dragger
                        accept="image/jpeg,image/png,image/webp,image/gif"
                        multiple
                        showUploadList={false}
                        beforeUpload={(file) => { handleImageUpload(file); return false; }}
                        style={{ marginBottom: 8 }}
                      >
                        <p className="ant-upload-drag-icon"><InboxOutlined /></p>
                        <p className="ant-upload-text">点击或拖入商家产品图片</p>
                        <p className="ant-upload-hint">支持 JPG、PNG、WebP、GIF，最大 10MB</p>
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
              )}
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
              <Text type="secondary">每日预算 (USD)</Text>
              <InputNumber value={budget} onChange={(v) => setBudget(v || 2)} min={0.5} step={0.5} style={{ width: "100%", marginTop: 4 }} prefix="$" />
            </div>
            <div style={{ marginBottom: 12 }}>
              <Text type="secondary">出价策略</Text>
              <Select value={biddingStrategy} onChange={setBiddingStrategy} style={{ width: "100%", marginTop: 4 }}
                options={BIDDING_STRATEGIES.map((b: any) => ({ value: b.value || b, label: b.label || b }))}
              />
            </div>
            <div style={{ marginBottom: 12 }}>
              <Text type="secondary">最高 CPC (USD)</Text>
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
