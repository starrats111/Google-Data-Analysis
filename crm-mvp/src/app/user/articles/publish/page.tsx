"use client";

import { useState, useEffect, useCallback, useMemo, useRef } from "react";
import { useSearchParams } from "next/navigation";
import {
  Card, Steps, Form, Select, Button, Typography, Space, App, Spin, Image,
  Checkbox, DatePicker, Row, Col, Tag, Result, Input, Upload,
} from "antd";
import type { UploadFile, RcFile } from "antd/es/upload";
import {
  ShopOutlined, GlobalOutlined, CameraOutlined, FileTextOutlined,
  CalendarOutlined, SendOutlined, CheckCircleOutlined, LoadingOutlined, SaveOutlined,
  InboxOutlined, LinkOutlined,
} from "@ant-design/icons";
import { sanitizeHtml, proxifyImgSrcs } from "@/lib/sanitize";
import PublishSiteSelect from "@/components/PublishSiteSelect";
import dayjs from "dayjs";
import utc from "dayjs/plugin/utc";
import timezone from "dayjs/plugin/timezone";

dayjs.extend(utc);
dayjs.extend(timezone);
const TZ = "Asia/Shanghai";

const { Title, Text, Paragraph } = Typography;

interface Merchant {
  id: string; merchant_name: string; platform: string; merchant_id: string;
  merchant_url: string | null; target_country: string | null;
  supported_regions: string[] | { code: string }[] | null;
  platform_connection_id?: string | null;
  ad_status?: string;
}

interface PlatformConnection {
  id: string; platform: string; account_name: string;
  publish_site_id: string | null;
}

interface Site {
  id: string; site_name: string; domain: string; verified: number; status: string;
  is_deleted?: number;
}

interface CrawlResult {
  images: string[];
  title: string;
  description: string;
  selling_points: string[];
}

interface ArticlePreview {
  id: string;
  title: string;
  content: string;
  slug: string;
}

export default function ArticlePublishPage() {
  const { message } = App.useApp();
  const searchParams = useSearchParams();
  const articleSlugFromUrl = searchParams.get("slug");
  const [step, setStep] = useState(0);
  // 已领取商家（用于默认显示）
  const [merchants, setMerchants] = useState<Merchant[]>([]);
  // 已知商家 map（claimed + 搜索结果），用于 onChange 时查找完整对象
  const [allMerchants, setAllMerchants] = useState<Merchant[]>([]);
  // 远端搜索状态
  const [searchValue, setSearchValue] = useState("");
  const [searchOptions, setSearchOptions] = useState<{ value: string; label: string }[]>([]);
  const [searching, setSearching] = useState(false);
  const searchTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // 已有已发布文章的 user_merchant_id 集合（用于默认视图过滤）
  const [publishedMerchantIds, setPublishedMerchantIds] = useState<Set<string>>(new Set());
  const [sites, setSites] = useState<Site[]>([]);
  const [platformConns, setPlatformConns] = useState<PlatformConnection[]>([]);
  const [loadingArticle, setLoadingArticle] = useState(false);
  const [boundSiteName, setBoundSiteName] = useState("");

  // Step 0: 选择商家
  const [selectedMerchant, setSelectedMerchant] = useState<Merchant | null>(null);
  // Step 0 B 块：按 URL 创建（C-020）
  const [urlFormUrl, setUrlFormUrl] = useState("");
  const [urlFormMid, setUrlFormMid] = useState("");
  const [urlFormName, setUrlFormName] = useState("");
  const [urlFormTracking, setUrlFormTracking] = useState("");
  const [urlFormConnId, setUrlFormConnId] = useState("");
  const [urlFormCountry, setUrlFormCountry] = useState("");
  const [urlFormSiteId, setUrlFormSiteId] = useState("");
  const [urlSubmitting, setUrlSubmitting] = useState(false);
  const isUrlBlockFilled = !!(urlFormUrl && urlFormConnId && urlFormCountry && urlFormSiteId);
  const activeBlock: "platform" | "url" | null = selectedMerchant
    ? "platform"
    : (isUrlBlockFilled ? "url" : null);
  // 无搜索词时：只展示 ENABLED 且未发布文章的已领取商家
  // 有搜索词时：展示远端搜索返回的结果（filterOption=false，由服务端过滤）
  const selectOptions = useMemo(() => {
    if (searchValue) return searchOptions;
    return merchants
      .filter((m) => m.ad_status === "ENABLED" && !publishedMerchantIds.has(m.id))
      .map((m) => ({
        value: m.id,
        label: `${m.merchant_name} [${m.platform}] (MID: ${m.merchant_id})`,
      }));
  }, [searchValue, searchOptions, merchants, publishedMerchantIds]);

  // 远端搜索：防抖 350ms，同时查 claimed + available 并去重
  const handleMerchantSearch = useCallback((kw: string) => {
    setSearchValue(kw);
    if (searchTimerRef.current) clearTimeout(searchTimerRef.current);
    if (!kw.trim()) {
      setSearchOptions([]);
      setSearching(false);
      return;
    }
    setSearching(true);
    searchTimerRef.current = setTimeout(async () => {
      try {
        const [r1, r2] = await Promise.all([
          fetch(`/api/user/merchants?tab=claimed&search=${encodeURIComponent(kw)}&pageSize=50`).then((r) => r.json()),
          fetch(`/api/user/merchants?tab=available&search=${encodeURIComponent(kw)}&pageSize=50`).then((r) => r.json()),
        ]);
        const list: Merchant[] = [
          ...(r1.code === 0 ? r1.data.merchants || [] : []),
          ...(r2.code === 0 ? r2.data.merchants || [] : []),
        ];
        const seen = new Set<string>();
        const deduped = list.filter((m) => {
          const k = String(m.id);
          if (seen.has(k)) return false;
          seen.add(k);
          return true;
        });
        setSearchOptions(deduped.map((m) => ({
          value: m.id,
          label: `${m.merchant_name} [${m.platform}] (MID: ${m.merchant_id})`,
        })));
        // 把搜索结果合并进 allMerchants，供 onChange 查找完整对象
        setAllMerchants((prev) => {
          const existingIds = new Set(prev.map((m) => m.id));
          return [...prev, ...deduped.filter((m) => !existingIds.has(m.id))];
        });
      } catch {
        // ignore
      } finally {
        setSearching(false);
      }
    }, 350);
  }, []);
  // Step 1: 确认国家
  const [country, setCountry] = useState("US");
  const [language, setLanguage] = useState("en");
  // Step 2: 爬取中
  const [crawling, setCrawling] = useState(false);
  const [crawlResult, setCrawlResult] = useState<CrawlResult | null>(null);
  const [crawlFailed, setCrawlFailed] = useState(false);
  const [manualUrl, setManualUrl] = useState("");
  // Step 3: 确认图片
  const [selectedImages, setSelectedImages] = useState<string[]>([]);
  const [uploadedImages, setUploadedImages] = useState<string[]>([]);
  const [uploading, setUploading] = useState(false);
  // Step 4: 生成文章预览
  const [generating, setGenerating] = useState(false);
  const [articlePreview, setArticlePreview] = useState<ArticlePreview | null>(null);
  // Step 5: 确认时间 & 发布
  const [publishTime, setPublishTime] = useState(dayjs().tz(TZ));
  const [selectedSite, setSelectedSite] = useState<string>("");
  // 当商家平台有多个连接时，让用户选择具体用哪个连接（对应哪个发布站点）
  const [multipleConns, setMultipleConns] = useState<PlatformConnection[]>([]);
  const [selectedConnId, setSelectedConnId] = useState<string>("");
  const [publishing, setPublishing] = useState(false);
  const [savingDraft, setSavingDraft] = useState(false);
  const [publishResult, setPublishResult] = useState<{ url: string } | null>(null);

  useEffect(() => {
    // 获取已领取的商家（用于默认列表）
    fetch("/api/user/merchants?tab=claimed&pageSize=500")
      .then((r) => r.json())
      .then((res) => {
        if (res.code === 0) {
          const claimed = res.data.merchants || [];
          setMerchants(claimed);
          setAllMerchants(claimed);
        }
      }).catch(() => {});
    // 获取已发布文章的商家 ID（仅 published 状态，用于默认视图过滤）
    fetch("/api/user/articles?pageSize=500")
      .then((r) => r.json())
      .then((res) => {
        if (res.code === 0) {
          const ids = new Set<string>();
          for (const a of res.data.articles || []) {
            if (a.user_merchant_id && a.status === "published") ids.add(String(a.user_merchant_id));
          }
          setPublishedMerchantIds(ids);
        }
      }).catch(() => {});
    // 获取站点
    fetch("/api/user/publish-sites")
      .then((r) => r.json())
      .then((res) => {
        if (res.code === 0) setSites(res.data || []);
      }).catch(() => {});
    // 获取平台连接（含绑定站点）
    fetch("/api/user/settings/platforms")
      .then((r) => r.json())
      .then((res) => {
        if (res.code === 0) setPlatformConns(res.data || []);
      }).catch(() => {});
  }, []);

  // 选择商家后，自动根据平台连接匹配绑定站点；若有多个连接则让用户手动选择
  useEffect(() => {
    if (!selectedMerchant || platformConns.length === 0 || sites.length === 0) return;
    const matched = platformConns.filter((c) => c.platform === selectedMerchant.platform && c.publish_site_id);
    if (matched.length === 1) {
      // 只有一个连接，直接自动选中
      const siteId = String(matched[0].publish_site_id);
      setSelectedSite(siteId);
      const site = sites.find((s) => String(s.id) === siteId);
      setBoundSiteName(site ? `${site.site_name} (${site.domain})` : "");
      setMultipleConns([]);
      setSelectedConnId("");
    } else if (matched.length > 1) {
      // 多个连接，清空自动选择，让用户在 Step 0 中手动选择
      setMultipleConns(matched);
      setSelectedSite("");
      setBoundSiteName("");
      setSelectedConnId("");
    } else {
      setSelectedSite("");
      setBoundSiteName("");
      setMultipleConns([]);
      setSelectedConnId("");
    }
  }, [selectedMerchant, platformConns, sites]);

  // 从广告提交页跳转过来时，通过 slug 加载已生成的文章
  useEffect(() => {
    if (!articleSlugFromUrl) return;
    setLoadingArticle(true);

    const pollArticle = async (retries = 0) => {
      try {
        const res = await fetch(`/api/user/articles?slug=${encodeURIComponent(articleSlugFromUrl)}&page=1&pageSize=1`).then((r) => r.json());
        const articles = res.data?.articles || [];
        const article = articles[0];

        if (article && article.status === "failed") {
          setLoadingArticle(false);
          message.error("文章生成失败，请检查 AI 配置后重试");
        } else if (article && article.status !== "generating") {
          if (!article.content) {
            setLoadingArticle(false);
            message.error("文章内容为空，AI 生成可能异常，请重试");
            return;
          }

          let finalContent = article.content;
          const articleImages: string[] = Array.isArray(article.images) ? article.images.filter((u: unknown) => typeof u === "string" && (u as string).trim()) : [];
          if (articleImages.length > 0) {
            setSelectedImages(articleImages);
            try {
              const { rebuildArticleContentWithLayout, buildDefaultArticleImageLayout } = await import("@/lib/article-image-layout");
              const layout = buildDefaultArticleImageLayout(finalContent, articleImages);
              finalContent = rebuildArticleContentWithLayout(finalContent, layout, article.title || "Article");
            } catch { /* 布局重建失败时保留原始 content */ }
          }

          setArticlePreview({
            id: article.id,
            title: article.title || "无标题",
            content: finalContent,
            slug: article.slug || "",
          });
          if (article.publish_site_id) {
            setSelectedSite(String(article.publish_site_id));
            fetch("/api/user/publish-sites").then((r) => r.json()).then((sRes) => {
              const allSites = sRes.data || [];
              const s = allSites.find((s: any) => String(s.id) === String(article.publish_site_id));
              if (s) setBoundSiteName(`${s.site_name} (${s.domain})`);
            }).catch(() => {});
          }
          setStep(4);
          setLoadingArticle(false);
        } else if (article && article.status === "generating" && retries < 40) {
          setTimeout(() => pollArticle(retries + 1), 3000);
        } else if (!article && retries < 5) {
          setTimeout(() => pollArticle(retries + 1), 2000);
        } else {
          setLoadingArticle(false);
          if (article?.status === "generating") {
            message.info("文章仍在生成中，请稍后在文章列表中查看");
          }
        }
      } catch {
        if (retries < 40) {
          setTimeout(() => pollArticle(retries + 1), 3000);
        } else {
          setLoadingArticle(false);
        }
      }
    };

    pollArticle();
  }, [articleSlugFromUrl, message]);

  // Step 2: 开始爬取商家信息
  const handleCrawl = useCallback(async (overrideUrl?: string) => {
    if (!selectedMerchant) return;
    setCrawling(true);
    setCrawlFailed(false);
    try {
      const crawlTargetUrl = overrideUrl || manualUrl || selectedMerchant.merchant_url;
      const res = await fetch("/api/user/articles/crawl", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          merchant_id: selectedMerchant.id,
          merchant_url: crawlTargetUrl,
          merchant_name: selectedMerchant.merchant_name,
          country,
        }),
        signal: AbortSignal.timeout(65000),
      });

      let data: { code?: number; data?: CrawlResult; message?: string };
      try {
        data = await res.json();
      } catch {
        // 服务端返回了非 JSON 响应
        setCrawlFailed(true);
        setCrawlResult(null);
        message.warning("爬取服务响应异常，可手动输入 URL 重试或直接上传图片");
        return;
      }

      if (data.code === 0 && data.data?.images?.length > 0) {
        setCrawlResult(data.data);
        setSelectedImages(data.data.images?.slice(0, 5) || []);
        setStep(3);
      } else {
        setCrawlFailed(true);
        setCrawlResult(data.data || null);
        message.warning("未爬取到图片，可手动输入 URL 重试或直接上传图片");
      }
    } catch (err) {
      setCrawlFailed(true);
      const isTimeout = err instanceof Error && (err.name === "TimeoutError" || err.name === "AbortError");
      message.error(isTimeout ? "爬取超时，请手动输入产品页 URL 重试或直接上传图片" : "爬取请求失败");
    } finally {
      setCrawling(false);
    }
  }, [selectedMerchant, country, manualUrl, message]);

  const handleSkipCrawl = useCallback(() => {
    setCrawlResult({ images: [], title: selectedMerchant?.merchant_name || "", description: "", selling_points: [] });
    setStep(3);
  }, [selectedMerchant]);

  const handleImageUpload = useCallback(async (file: RcFile) => {
    if (file.size > 10 * 1024 * 1024) { message.error("图片不能超过 10MB"); return false; }
    setUploading(true);
    try {
      const formData = new FormData();
      formData.append("file", file);
      const res = await fetch("/api/user/ad-creation/upload-image", { method: "POST", body: formData }).then(r => r.json());
      if (res.code === 0 && res.data?.url) {
        const imgUrl = res.data.url;
        setUploadedImages(prev => [...prev, imgUrl]);
        setSelectedImages(prev => [...prev, imgUrl]);
        message.success("图片上传成功");
      } else {
        message.error(res.message || "上传失败");
      }
    } catch { message.error("上传请求失败"); }
    finally { setUploading(false); }
    return false;
  }, [message]);

  // Step 4: 生成文章
  const handleGenerate = useCallback(async () => {
    if (!selectedMerchant || !crawlResult) return;
    setGenerating(true);
    try {
      const res = await fetch("/api/user/articles", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          user_merchant_id: selectedMerchant.id,
          language,
          country,
          images: selectedImages,
          crawl_data: crawlResult,
          article_type: "review",
          article_length: "medium",
        }),
      }).then((r) => r.json());

      if (res.code === 0 && res.data?.id) {
        const articleId = res.data.id;
        let retries = 0;
        const poll = async () => {
          try {
            const check = await fetch(`/api/user/articles?id=${articleId}&page=1&pageSize=1`).then((r) => r.json());
            const article = check.data?.articles?.[0];
            if (article && article.status === "failed") {
              message.error("文章生成失败，请检查 AI 配置后重试");
              setGenerating(false);
            } else if (article && article.status !== "generating") {
              if (!article.content) {
                message.error("文章内容为空，AI 生成可能异常，请重试");
                setGenerating(false);
              } else {
                setArticlePreview({
                  id: article.id,
                  title: article.title || "无标题",
                  content: article.content,
                  slug: article.slug || "",
                });
                setStep(4);
                setGenerating(false);
              }
            } else if (retries < 60) {
              retries++;
              setTimeout(poll, 3000);
            } else {
              message.warning("文章生成超时，请在文章列表中查看");
              setGenerating(false);
            }
          } catch {
            if (retries < 60) {
              retries++;
              setTimeout(poll, 3000);
            } else {
              message.warning("文章状态查询失败，请刷新页面查看");
              setGenerating(false);
            }
          }
        };
        setTimeout(poll, 5000);
      } else {
        message.error(res.message || "生成失败");
        setGenerating(false);
      }
    } catch {
      message.error("请求失败");
      setGenerating(false);
    }
  }, [selectedMerchant, crawlResult, selectedImages, language, country, message]);

  // 存入草稿
  const handleSaveDraft = useCallback(async () => {
    if (!articlePreview) return;
    setSavingDraft(true);
    try {
      const res = await fetch("/api/user/articles", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          id: articlePreview.id,
          title: articlePreview.title,
          content: articlePreview.content,
          status: "draft",
          publish_site_id: selectedSite || undefined,
        }),
      }).then((r) => r.json());
      if (res.code === 0) {
        message.success("已存入草稿，可在文章管理中查看");
      } else {
        message.error(res.message || "保存失败");
      }
    } catch {
      message.error("保存请求失败");
    } finally {
      setSavingDraft(false);
    }
  }, [articlePreview, selectedSite, message]);

  // Step 5: 发布
  const handlePublish = useCallback(async () => {
    if (!articlePreview || !selectedSite) {
      message.warning("请选择发布站点");
      return;
    }
    if (!articlePreview.title || !articlePreview.content) {
      message.error("文章标题或内容为空，无法发布");
      return;
    }
    setPublishing(true);
    try {
      // 发布前先将最终预览内容保存到数据库，确保发布器读到的是带正确图片的 HTML
      await fetch("/api/user/articles", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          id: articlePreview.id,
          title: articlePreview.title,
          content: articlePreview.content,
          status: publishTime.isAfter(dayjs().tz(TZ)) ? "preview" : undefined,
          publish_site_id: selectedSite || undefined,
        }),
      });

      const res = await fetch("/api/user/articles/publish-to-site", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          article_id: articlePreview.id,
          site_id: selectedSite,
        }),
      }).then((r) => r.json());

      if (res.code === 0) {
        setPublishResult({ url: res.data?.url || "" });
        setStep(5);
        message.success("发布成功！");
      } else {
        message.error(res.message || "发布失败");
      }
    } catch {
      message.error("发布请求失败");
    } finally {
      setPublishing(false);
    }
  }, [articlePreview, selectedSite, publishTime, message]);

  const activeSites = sites.filter((s) => s.status === "active" && s.verified === 1);

  const COUNTRY_LANG: Record<string, string> = {
    US: "en", GB: "en", UK: "en", CA: "en", AU: "en", NZ: "en", IE: "en", SG: "en",
    DE: "de", AT: "de", CH: "de",
    FR: "fr", BE: "fr",
    ES: "es", MX: "es", AR: "es", CL: "es", CO: "es",
    IT: "it", PT: "pt", BR: "pt", NL: "nl",
    JP: "ja", KR: "ko",
    SE: "sv", NO: "no", DK: "da", FI: "fi", PL: "pl", CZ: "cs",
    TR: "tr", TH: "th", VN: "vi", ID: "id",
    RU: "ru", IN: "en", PH: "en",
  };
  const LANG_NAME: Record<string, string> = {
    en: "English", de: "Deutsch", fr: "Français", es: "Español",
    it: "Italiano", pt: "Português", nl: "Nederlands", ja: "日本語",
    ko: "한국어", sv: "Svenska", no: "Norsk", da: "Dansk", fi: "Suomi",
    pl: "Polski", cs: "Čeština", tr: "Türkçe", th: "ไทย", vi: "Tiếng Việt",
    id: "Bahasa Indonesia", ru: "Русский",
  };
  const getLang = (c: string) => COUNTRY_LANG[c.toUpperCase()] || "en";

  const countryOptions = [
    { value: "US", label: "美国 (US)" },
    { value: "GB", label: "英国 (GB)" },
    { value: "AU", label: "澳洲 (AU)" },
    { value: "CA", label: "加拿大 (CA)" },
    { value: "NZ", label: "新西兰 (NZ)" },
    { value: "DE", label: "德国 (DE)" },
    { value: "FR", label: "法国 (FR)" },
    { value: "ES", label: "西班牙 (ES)" },
    { value: "IT", label: "意大利 (IT)" },
    { value: "NL", label: "荷兰 (NL)" },
    { value: "JP", label: "日本 (JP)" },
    { value: "KR", label: "韩国 (KR)" },
    { value: "BR", label: "巴西 (BR)" },
    { value: "MX", label: "墨西哥 (MX)" },
    { value: "SE", label: "瑞典 (SE)" },
    { value: "NO", label: "挪威 (NO)" },
    { value: "DK", label: "丹麦 (DK)" },
    { value: "FI", label: "芬兰 (FI)" },
    { value: "PL", label: "波兰 (PL)" },
    { value: "AT", label: "奥地利 (AT)" },
    { value: "CH", label: "瑞士 (CH)" },
    { value: "BE", label: "比利时 (BE)" },
    { value: "IE", label: "爱尔兰 (IE)" },
    { value: "PT", label: "葡萄牙 (PT)" },
    { value: "SG", label: "新加坡 (SG)" },
    { value: "IN", label: "印度 (IN)" },
  ];

  // 从广告页跳转过来时显示加载状态
  if (loadingArticle) {
    return (
      <div>
        <Title level={4}><FileTextOutlined /> 文章发布</Title>
        <Card style={{ textAlign: "center", padding: 48 }}>
          <Spin size="large" tip="正在加载已生成的文章...">
            <div style={{ minHeight: 200 }} />
          </Spin>
          <Text type="secondary" style={{ display: "block", marginTop: 16 }}>
            广告已成功提交到 Google Ads，正在准备文章发布...
          </Text>
        </Card>
      </div>
    );
  }

  return (
    <div>
      <Title level={4}><FileTextOutlined /> {articleSlugFromUrl ? "文章发布" : "快速发布文章"}</Title>

      <Steps
        current={step}
        size="small"
        style={{ marginBottom: 24 }}
        items={[
          { title: "选择商家", icon: <ShopOutlined /> },
          { title: "确认国家", icon: <GlobalOutlined /> },
          { title: "爬取数据", icon: crawling ? <LoadingOutlined /> : <CameraOutlined /> },
          { title: "确认图片", icon: <CameraOutlined /> },
          { title: "预览文章", icon: <FileTextOutlined /> },
          { title: "发布", icon: <SendOutlined /> },
        ]}
      />

      {/* Step 0: 选择商家（A 块）+ 按 URL 创建（B 块，C-020） */}
      {step === 0 && (
        <Card>
          <Form layout="vertical" style={{ maxWidth: 600 }}>
            <Form.Item label="选择推广商家" required={activeBlock !== "url"}>
              <Select
                placeholder="默认显示已启用商家，输入商家名或MID可搜索所有商家"
                showSearch
                allowClear
                disabled={activeBlock === "url"}
                filterOption={false}
                loading={searching}
                onSearch={handleMerchantSearch}
                onClear={() => { setSearchValue(""); setSearchOptions([]); }}
                style={{ width: "100%" }}
                value={selectedMerchant?.id}
                onChange={(v) => {
                  const m = allMerchants.find((m) => m.id === v);
                  setSelectedMerchant(m || null);
                  if (m?.target_country) {
                    setCountry(m.target_country);
                    setLanguage(getLang(m.target_country));
                  }
                }}
                options={selectOptions}
              />
            </Form.Item>
            {selectedMerchant && (
              <div style={{ marginBottom: 16, padding: 12, background: "#f6f8fa", borderRadius: 8 }}>
                <Space direction="vertical" size={4}>
                  <Text strong>{selectedMerchant.merchant_name}</Text>
                  <Space>
                    <Tag color="blue">{selectedMerchant.platform}</Tag>
                    <Text type="secondary">MID: {selectedMerchant.merchant_id}</Text>
                  </Space>
                  {selectedMerchant.merchant_url && (
                    <Text type="secondary" style={{ fontSize: 12 }}>{selectedMerchant.merchant_url}</Text>
                  )}
                </Space>
              </div>
            )}
            {/* 同一平台有多个账号连接时，需要用户选择发布到哪个站点 */}
            {multipleConns.length > 1 && activeBlock !== "url" && (
              <Form.Item
                label={<><GlobalOutlined style={{ marginRight: 4 }} />选择发布站点账号</>}
                required
                help={`该商家属于 ${selectedMerchant?.platform} 平台，您有多个账号连接，请确认要发布到哪个站点`}
              >
                <Select
                  placeholder="请选择发布站点"
                  value={selectedConnId || undefined}
                  onChange={(connId) => {
                    setSelectedConnId(connId);
                    const conn = multipleConns.find((c) => c.id === connId);
                    if (conn?.publish_site_id) {
                      const siteId = String(conn.publish_site_id);
                      setSelectedSite(siteId);
                      const site = sites.find((s) => String(s.id) === siteId);
                      setBoundSiteName(site ? `${site.site_name} (${site.domain})` : "");
                    }
                  }}
                  options={multipleConns.map((c) => {
                    const site = sites.find((s) => String(s.id) === String(c.publish_site_id));
                    return {
                      value: c.id,
                      label: `${c.account_name} → ${site ? `${site.site_name} (${site.domain})` : `站点 #${c.publish_site_id}`}`,
                    };
                  })}
                  style={{ width: "100%" }}
                />
              </Form.Item>
            )}

            {/* C-020 B 块：按 URL 创建（与 A 块互斥） */}
            <div style={{ margin: "16px 0", borderTop: "1px dashed #d9d9d9", position: "relative" }}>
              <span style={{ position: "absolute", top: -10, left: 20, background: "#fff", padding: "0 12px", color: "#999", fontSize: 12 }}>或者</span>
            </div>
            <Card
              size="small"
              title={<Space><LinkOutlined />按 URL 创建</Space>}
              style={{ marginBottom: 16, opacity: activeBlock === "platform" ? 0.55 : 1 }}
              styles={{ body: activeBlock === "platform" ? { pointerEvents: "none" as const } : undefined }}
            >
              <Text type="secondary" style={{ fontSize: 12, display: "block", marginBottom: 12 }}>
                平台已下架或与 CRM 不同步时，可直接输入商家 URL 创建。4 项带 * 为必填；A 块已选商家则此块置灰。
              </Text>
              <Form.Item label="商家 URL" required style={{ marginBottom: 12 }}>
                <Input placeholder="https://shop.example.com/..." value={urlFormUrl} onChange={(e) => setUrlFormUrl(e.target.value)} allowClear />
              </Form.Item>
              <Form.Item label="平台账号" required style={{ marginBottom: 12 }}>
                <Select
                  placeholder="选择用于发起这次投放的平台账号"
                  value={urlFormConnId || undefined}
                  onChange={(v) => setUrlFormConnId(v || "")}
                  options={platformConns.map((c) => ({
                    value: c.id,
                    label: `${c.platform} · ${c.account_name}`,
                  }))}
                  allowClear
                />
              </Form.Item>
              <Form.Item label="目标国家" required style={{ marginBottom: 12 }}>
                <Select
                  placeholder="选择国家"
                  showSearch
                  optionFilterProp="label"
                  value={urlFormCountry || undefined}
                  onChange={(v) => setUrlFormCountry(v || "")}
                  options={countryOptions}
                  allowClear
                />
              </Form.Item>
              <Form.Item label="发布站点" required style={{ marginBottom: 12 }}>
                <PublishSiteSelect
                  value={urlFormSiteId || undefined}
                  onChange={(v) => setUrlFormSiteId((v as string) || "")}
                  sites={sites.map((s) => ({
                    ...s,
                    id: String(s.id),
                    is_deleted: s.is_deleted ?? 0,
                  }))}
                  placeholder="搜索站点名或域名"
                />
              </Form.Item>
              <Form.Item label="商家名称（选填）" style={{ marginBottom: 12 }}>
                <Input placeholder="留空则用 URL 域名（去 www.）" value={urlFormName} onChange={(e) => setUrlFormName(e.target.value)} />
              </Form.Item>
              <Form.Item label="商家 MID（选填）" style={{ marginBottom: 12 }}>
                <Input placeholder="平台有就填，没有留空" value={urlFormMid} onChange={(e) => setUrlFormMid(e.target.value)} />
              </Form.Item>
              <Form.Item label="联盟链接（选填）" style={{ marginBottom: 0 }}>
                <Input placeholder="联盟后台的 tracking 链接" value={urlFormTracking} onChange={(e) => setUrlFormTracking(e.target.value)} />
              </Form.Item>
            </Card>

            <Button
              type="primary"
              loading={urlSubmitting}
              disabled={
                activeBlock === null ||
                (activeBlock === "platform" && multipleConns.length > 1 && !selectedConnId)
              }
              onClick={async () => {
                if (activeBlock === "platform") {
                  setStep(1);
                  return;
                }
                if (activeBlock !== "url") return;
                setUrlSubmitting(true);
                try {
                  const r = await fetch("/api/user/articles/by-url", {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({
                      merchant_url: urlFormUrl.trim(),
                      platform_connection_id: urlFormConnId,
                      country: urlFormCountry,
                      publish_site_id: urlFormSiteId,
                      merchant_id: urlFormMid.trim(),
                      merchant_name: urlFormName.trim(),
                      tracking_link: urlFormTracking.trim(),
                    }),
                  }).then((r) => r.json());
                  if (r.code !== 0) {
                    message.error(r.message || "创建失败");
                    return;
                  }
                  const data = r.data || {};
                  const conn = platformConns.find((c) => c.id === urlFormConnId);
                  const fallbackName = urlFormName.trim() || (() => {
                    try { return new URL(urlFormUrl).hostname.replace(/^www\./i, ""); } catch { return urlFormUrl; }
                  })();
                  setSelectedMerchant({
                    id: data.user_merchant_id,
                    merchant_name: fallbackName,
                    platform: conn?.platform || "",
                    merchant_id: urlFormMid.trim(),
                    merchant_url: urlFormUrl.trim(),
                    target_country: urlFormCountry,
                    supported_regions: null,
                    platform_connection_id: urlFormConnId || null,
                    ad_status: "NOT_SUBMITTED",
                  });
                  setCountry(urlFormCountry);
                  setLanguage(getLang(urlFormCountry));
                  setSelectedSite(urlFormSiteId);
                  setSelectedConnId(urlFormConnId);
                  const site = sites.find((s) => String(s.id) === urlFormSiteId);
                  setBoundSiteName(site ? `${site.site_name} (${site.domain})` : "");
                  if (data.reused) {
                    message.info("已复用已有商家记录");
                  } else {
                    const statusMap: Record<string, string> = { offline: "已下架", url_only: "无平台数据", active: "平台镜像" };
                    message.success(`已创建 URL 直投商家（${statusMap[data.listing_status] || data.listing_status}）`);
                  }
                  setStep(1);
                } catch (e) {
                  message.error("创建失败，请检查网络");
                } finally {
                  setUrlSubmitting(false);
                }
              }}
            >
              下一步
            </Button>
          </Form>
        </Card>
      )}

      {/* Step 1: 确认国家 */}
      {step === 1 && (
        <Card>
          <Form layout="vertical" style={{ maxWidth: 600 }}>
            <Form.Item label="目标国家" required>
              <Select
                value={country}
                showSearch
                optionFilterProp="label"
                onChange={(v) => {
                  setCountry(v);
                  setLanguage(getLang(v));
                }}
                options={countryOptions}
              />
            </Form.Item>
            <div style={{ marginBottom: 16, padding: "8px 12px", background: "#f6f8fa", borderRadius: 6 }}>
              <Text type="secondary">文章语言：</Text>
              <Text strong>{LANG_NAME[getLang(country)] || "English"}</Text>
            </div>
            <Space>
              <Button onClick={() => setStep(0)}>上一步</Button>
              <Button type="primary" onClick={() => { setStep(2); handleCrawl(); }}>
                开始爬取
              </Button>
            </Space>
          </Form>
        </Card>
      )}

      {/* Step 2: 爬取中 */}
      {step === 2 && (
        <Card style={{ textAlign: "center", padding: 48 }}>
          <Spin size="large" tip="正在爬取商家信息和图片..." spinning={crawling}>
            <div style={{ minHeight: 200 }}>
              {!crawling && !crawlFailed && crawlResult && (
                <Result status="success" title="爬取完成" subTitle={`获取到 ${crawlResult.images?.length || 0} 张图片`} />
              )}
              {!crawling && crawlFailed && (
                <Result
                  status="warning"
                  title="爬取未获取到图片"
                  subTitle="该商家可能有企业级反爬保护，您可以手动输入产品页 URL 重试，或跳过爬取直接上传图片"
                  extra={
                    <Space direction="vertical" size={16} style={{ width: "100%", maxWidth: 500 }}>
                      <Input.Search
                        placeholder="输入商家产品页 URL，如 https://www.bofrost.de/produkte/"
                        enterButton="用此 URL 重试爬取"
                        size="large"
                        prefix={<LinkOutlined />}
                        value={manualUrl}
                        onChange={(e) => setManualUrl(e.target.value)}
                        onSearch={(v) => { if (v) handleCrawl(v); }}
                      />
                      <Space>
                        <Button onClick={() => setStep(1)}>上一步</Button>
                        <Button type="primary" onClick={handleSkipCrawl}>
                          跳过爬取，直接上传图片
                        </Button>
                      </Space>
                    </Space>
                  }
                />
              )}
              {!crawling && !crawlFailed && !crawlResult && (
                <Result status="warning" title="爬取未开始" extra={<Button type="primary" onClick={() => handleCrawl()}>重新爬取</Button>} />
              )}
            </div>
          </Spin>
        </Card>
      )}

      {/* Step 3: 确认图片 */}
      {step === 3 && crawlResult && (
        <Card>
          <Title level={5}>选择文章配图（已选 {selectedImages.length} 张）</Title>
          <Text type="secondary" style={{ display: "block", marginBottom: 16 }}>
            从爬取结果中选择图片，或拖动上传本地图片
          </Text>

          {/* 拖动上传区域 */}
          <div style={{ marginBottom: 24 }}>
            <Upload.Dragger
              accept="image/jpeg,image/png,image/webp,image/gif"
              multiple
              showUploadList={false}
              beforeUpload={handleImageUpload}
              disabled={uploading}
            >
              <p className="ant-upload-drag-icon"><InboxOutlined /></p>
              <p className="ant-upload-text">{uploading ? "上传中..." : "拖动图片到此处，或点击选择文件"}</p>
              <p className="ant-upload-hint">支持 JPG/PNG/WebP/GIF，单张不超过 10MB</p>
            </Upload.Dragger>
          </div>

          {/* 已上传的图片 */}
          {uploadedImages.length > 0 && (
            <>
              <Text strong style={{ display: "block", marginBottom: 8 }}>已上传的图片：</Text>
              <Row gutter={[12, 12]} style={{ marginBottom: 16 }}>
                {uploadedImages.map((img, i) => (
                  <Col key={`up-${i}`} xs={12} sm={8} md={6} lg={4}>
                    <div
                      style={{
                        border: selectedImages.includes(img) ? "2px solid #52c41a" : "2px solid #f0f0f0",
                        borderRadius: 8, padding: 4, cursor: "pointer", position: "relative",
                      }}
                      onClick={() => {
                        setSelectedImages((prev) =>
                          prev.includes(img) ? prev.filter((u) => u !== img) : [...prev, img]
                        );
                      }}
                    >
                      <Image src={img} alt={`uploaded-${i}`} width="100%" height={120} style={{ objectFit: "cover", borderRadius: 6 }} preview={false} />
                      {selectedImages.includes(img) && (
                        <CheckCircleOutlined style={{ position: "absolute", top: 8, right: 8, fontSize: 20, color: "#52c41a" }} />
                      )}
                      <Tag color="green" style={{ position: "absolute", bottom: 8, left: 8, fontSize: 10 }}>已上传</Tag>
                    </div>
                  </Col>
                ))}
              </Row>
            </>
          )}

          {/* 爬取到的图片 */}
          {(crawlResult.images || []).length > 0 && (
            <>
              <Text strong style={{ display: "block", marginBottom: 8 }}>爬取到的图片：</Text>
              <Row gutter={[12, 12]} style={{ marginBottom: 24 }}>
                {(crawlResult.images || []).map((img, i) => (
                  <Col key={i} xs={12} sm={8} md={6} lg={4}>
                    <div
                      style={{
                        border: selectedImages.includes(img) ? "2px solid #1677ff" : "2px solid #f0f0f0",
                        borderRadius: 8, padding: 4, cursor: "pointer", position: "relative",
                      }}
                      onClick={() => {
                        setSelectedImages((prev) =>
                          prev.includes(img) ? prev.filter((u) => u !== img) : [...prev, img]
                        );
                      }}
                    >
                      <Image src={img} alt={`img-${i}`} width="100%" height={120} style={{ objectFit: "cover", borderRadius: 6 }} preview={false} />
                      {selectedImages.includes(img) && (
                        <CheckCircleOutlined style={{ position: "absolute", top: 8, right: 8, fontSize: 20, color: "#1677ff" }} />
                      )}
                    </div>
                  </Col>
                ))}
              </Row>
            </>
          )}

          {(crawlResult.images || []).length === 0 && uploadedImages.length === 0 && (
            <Text type="secondary" style={{ display: "block", marginBottom: 16 }}>未爬取到图片，请上传商家产品图片用于文章配图</Text>
          )}

          <Space>
            <Button onClick={() => setStep(1)}>上一步</Button>
            <Button type="primary" loading={generating} onClick={handleGenerate} disabled={selectedImages.length === 0 && uploadedImages.length === 0}>
              {generating ? "生成中..." : "生成文章"}
            </Button>
          </Space>
        </Card>
      )}

      {/* Step 4: 文章预览 */}
      {step === 4 && articlePreview && (
        <Card>
          <Title level={5}>文章预览</Title>
          <div style={{
            border: "1px solid #e8e8e8", borderRadius: 8, padding: 24, marginBottom: 24,
            maxHeight: 500, overflowY: "auto", background: "#fafafa",
          }}>
            <Title level={3}>{articlePreview.title}</Title>
            <div dangerouslySetInnerHTML={{ __html: proxifyImgSrcs(sanitizeHtml(articlePreview.content)) }} />
          </div>

          <Form layout="vertical" style={{ maxWidth: 600 }}>
            {boundSiteName ? (
              <Form.Item label="发布站点">
                <div style={{ padding: "8px 12px", background: "#f6ffed", border: "1px solid #b7eb8f", borderRadius: 6 }}>
                  <CheckCircleOutlined style={{ color: "#52c41a", marginRight: 8 }} />
                  <Text strong>{boundSiteName}</Text>
                  <Text type="secondary" style={{ marginLeft: 8, fontSize: 12 }}>（平台绑定站点）</Text>
                </div>
              </Form.Item>
            ) : (
              <Form.Item label="发布站点" required>
                <PublishSiteSelect
                  placeholder="选择发布站点（建议在个人设置中为平台绑定站点）"
                  value={selectedSite || undefined}
                  onChange={(v) => setSelectedSite(v as string)}
                  sites={sites.map((s) => ({
                    ...s,
                    id: String(s.id),
                    is_deleted: s.is_deleted ?? 0,
                  }))}
                />
              </Form.Item>
            )}
            <Form.Item label="发布时间">
              <DatePicker
                showTime
                value={publishTime}
                onChange={(v) => v && setPublishTime(v)}
                style={{ width: "100%" }}
              />
            </Form.Item>
          </Form>

          <Space>
            <Button onClick={() => setStep(3)}>上一步</Button>
            <Button icon={<SaveOutlined />} loading={savingDraft} onClick={handleSaveDraft}>
              存入草稿
            </Button>
            <Button type="primary" icon={<SendOutlined />} loading={publishing} onClick={handlePublish}>
              确认发布
            </Button>
          </Space>
        </Card>
      )}

      {/* Step 5: 发布成功 */}
      {step === 5 && (
        <Card>
          <Result
            status="success"
            title="文章发布成功！"
            subTitle={publishResult?.url ? `文章地址: ${publishResult.url}` : "文章已发布到站点"}
            extra={[
              publishResult?.url && (
                <Button key="view" type="primary" onClick={() => window.open(publishResult.url, "_blank")}>
                  查看文章
                </Button>
              ),
              <Button key="list" onClick={() => window.location.href = "/user/articles"}>
                文章列表
              </Button>,
              <Button key="new" onClick={() => {
                setStep(0);
                setSelectedMerchant(null);
                setCrawlResult(null);
                setArticlePreview(null);
                setPublishResult(null);
                setSelectedImages([]);
              }}>
                继续发布
              </Button>,
            ].filter(Boolean)}
          />
        </Card>
      )}

      {/* 生成中遮罩 */}
      {generating && step === 3 && (
        <div style={{
          position: "fixed", top: 0, left: 0, right: 0, bottom: 0,
          background: "rgba(255,255,255,0.8)", zIndex: 1000,
          display: "flex", alignItems: "center", justifyContent: "center",
        }}>
          <Spin size="large" tip="AI 正在生成文章，请稍候...">
            <div style={{ width: 300, height: 100 }} />
          </Spin>
        </div>
      )}
    </div>
  );
}
