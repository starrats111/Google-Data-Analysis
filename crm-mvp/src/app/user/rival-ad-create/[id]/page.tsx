"use client";

/**
 * 竞品情报引擎 — 上广告向导。
 *
 * D-233：对应 kyads 的 ad-create 四步页（generate-tab / draft-preview-card / publish-tab），
 * 但在 CRM 里做了两处收敛：
 *
 *   1. 第一步不再让员工填域名、贴联盟链接、选生成模式。领取商家时就已经按商家的
 *      merchant_url 起好草稿并进后台生成，这里只展示参数，员工进来就看进度。
 *   2. 第四步不做命名预览和序号选择。发布交给 CRM 的 submit 流水线，六段名与序号池
 *      两个引擎共用一套，前端没有可选项——避免出现「向导里显示一个名字、实际发出去
 *      另一个」的错位。
 */

import { useCallback, useEffect, useMemo, useState } from "react";
import { useParams, useRouter } from "next/navigation";
import {
  Alert,
  Button,
  Card,
  Col,
  Descriptions,
  Input,
  Modal,
  Row,
  Space,
  Spin,
  Steps,
  Tag,
  Typography,
  message,
} from "antd";
import {
  CheckCircleOutlined,
  ClockCircleOutlined,
  CloseCircleOutlined,
  LoadingOutlined,
  MinusCircleOutlined,
  ReloadOutlined,
  RocketOutlined,
} from "@ant-design/icons";

const { Text, Title } = Typography;
const { TextArea } = Input;

const STAGE_LABELS: { key: string; label: string }[] = [
  { key: "fetch_rival_ads", label: "竞品在投创意" },
  { key: "extract_brand_keywords", label: "品牌核心词" },
  { key: "discover_sitelink_urls", label: "站内链接" },
  { key: "ai_generate_assets", label: "AI 生成文案" },
  { key: "build_preview", label: "组装预览" },
];

const HEADLINE_MAX = 30;
const DESCRIPTION_MAX = 90;

type CompletedEntry = string | { stage: string; skipped?: boolean };

interface DraftDto {
  id: string;
  campaign_id: string | null;
  domain: string;
  country_code: string;
  language_code: string | null;
  landing_page_url: string | null;
  status: string;
  current_stage: string | null;
  completed_stages: CompletedEntry[];
  failed_stage: string | null;
  error_message: string | null;
  retryable: boolean;
  generation_mode: string;
  core_brand_keywords: string[] | null;
  headlines: { text: string }[];
  descriptions: { text: string }[];
  negative_keywords: string[];
  gap_report: { breaksRsaMinimum?: boolean; suggestionReason?: string } | null;
}

async function callApi<T>(
  url: string,
  init?: { method?: string; body?: unknown },
): Promise<{ code: number; message: string; data: T }> {
  const res = await fetch(url, {
    method: init?.method || "GET",
    ...(init?.body ? { headers: { "Content-Type": "application/json" }, body: JSON.stringify(init.body) } : {}),
  });
  return res.json();
}

export default function RivalAdCreatePage() {
  const params = useParams<{ id: string }>();
  const router = useRouter();
  const draftId = params?.id;

  const [draft, setDraft] = useState<DraftDto | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [publishing, setPublishing] = useState(false);
  const [retrying, setRetrying] = useState(false);
  const [headlines, setHeadlines] = useState<string[]>([]);
  const [descriptions, setDescriptions] = useState<string[]>([]);
  const [negatives, setNegatives] = useState("");
  const [brandKeywords, setBrandKeywords] = useState("");
  const [customerId, setCustomerId] = useState("");
  const [dirty, setDirty] = useState(false);
  // RIVAL-PUB-02：点「确认发布」先进入可编辑最终确认层，再次确认才真正发布
  const [confirmOpen, setConfirmOpen] = useState(false);

  const load = useCallback(async () => {
    if (!draftId) return;
    const r = await callApi<DraftDto>(`/api/user/rival-intel/drafts/${draftId}`);
    if (r.code !== 0) {
      message.error(r.message || "读取草稿失败");
      setLoading(false);
      return;
    }
    setDraft(r.data);
    setLoading(false);
    // 员工正在改文案时不要被轮询回填覆盖
    setDirty((isDirty) => {
      if (!isDirty) {
        setHeadlines(r.data.headlines.map((h) => h.text));
        setDescriptions(r.data.descriptions.map((d) => d.text));
        setNegatives((r.data.negative_keywords || []).join("\n"));
        setBrandKeywords((r.data.core_brand_keywords || []).join("\n"));
      }
      return isDirty;
    });
  }, [draftId]);

  useEffect(() => {
    void load();
  }, [load]);

  // 生成中才轮询：后台 runner 在推进阶段，这里只是看进度
  const generating = draft?.status === "draft_generating";
  useEffect(() => {
    if (!generating) return;
    const timer = setInterval(() => void load(), 2500);
    return () => clearInterval(timer);
  }, [generating, load]);

  const stepItems = useMemo(() => {
    const finished = new Set<string>();
    const skipped = new Set<string>();
    for (const entry of draft?.completed_stages || []) {
      if (typeof entry === "string") finished.add(entry);
      else if (entry?.skipped === true) skipped.add(entry.stage);
      else if (entry?.stage) finished.add(entry.stage);
    }

    return STAGE_LABELS.map((stage) => {
      if (draft?.failed_stage === stage.key) {
        return { title: stage.label, status: "error" as const, icon: <CloseCircleOutlined /> };
      }
      if (skipped.has(stage.key)) {
        return {
          title: <span style={{ color: "#bfbfbf" }}>{stage.label} · 已跳过</span>,
          status: "finish" as const,
          icon: <MinusCircleOutlined style={{ color: "#bfbfbf" }} />,
        };
      }
      if (finished.has(stage.key)) {
        return { title: stage.label, status: "finish" as const, icon: <CheckCircleOutlined /> };
      }
      if (draft?.current_stage === stage.key) {
        return { title: stage.label, status: "process" as const, icon: <LoadingOutlined /> };
      }
      return { title: stage.label, status: "wait" as const, icon: <ClockCircleOutlined /> };
    });
  }, [draft]);

  // 把编辑区当前内容整体落库（标题/描述/品牌核心词/否定词）；确认发布前也走这里自动保存
  const saveAssets = useCallback(async (opts?: { silent?: boolean }): Promise<boolean> => {
    if (!draftId) return false;
    setSaving(true);
    try {
      const r = await callApi<DraftDto>(`/api/user/rival-intel/drafts/${draftId}`, {
        method: "PATCH",
        body: {
          headlines: headlines.map((t) => t.trim()).filter(Boolean),
          descriptions: descriptions.map((t) => t.trim()).filter(Boolean),
          coreBrandKeywords: brandKeywords
            .split("\n")
            .map((s) => s.trim())
            .filter(Boolean),
          negativeKeywords: negatives
            .split("\n")
            .map((s) => s.trim())
            .filter(Boolean),
        },
      });
      if (r.code !== 0) {
        message.error(r.message || "保存失败");
        return false;
      }
      setDirty(false);
      setDraft(r.data);
      if (!opts?.silent) message.success("已保存");
      return true;
    } finally {
      setSaving(false);
    }
  }, [draftId, headlines, descriptions, brandKeywords, negatives]);

  const retry = useCallback(async () => {
    if (!draftId) return;
    setRetrying(true);
    try {
      const r = await callApi(`/api/user/rival-intel/drafts/${draftId}/retry`, { method: "POST" });
      if (r.code !== 0) message.error(r.message || "重试失败");
      else {
        message.success("已重新入队");
        void load();
      }
    } finally {
      setRetrying(false);
    }
  }, [draftId, load]);

  // RIVAL-PUB-02：确认层里点最终确认——先把全部修改自动落库，成功后才真正发布
  const confirmPublish = useCallback(async () => {
    if (!draftId) return;
    setPublishing(true);
    try {
      const saved = await saveAssets({ silent: true });
      if (!saved) return;
      const r = await callApi<{ campaign_id: string }>(
        `/api/user/rival-intel/drafts/${draftId}/publish`,
        { method: "POST", body: customerId.trim() ? { customer_id: customerId.trim() } : {} },
      );
      if (r.code !== 0) {
        message.error(r.message || "发布失败");
        return;
      }
      setConfirmOpen(false);
      message.success("已提交，正在后台发布到 Google Ads");
      // 发布进度、命名、CID 都在 CRM 的广告预览页看，不在这里重复实现一套
      setTimeout(() => router.push(`/user/ad-preview/${r.data.campaign_id}`), 800);
    } finally {
      setPublishing(false);
    }
  }, [draftId, customerId, router, saveAssets]);

  if (loading) {
    return (
      <div style={{ padding: 48, textAlign: "center" }}>
        <Spin tip="读取草稿…" />
      </div>
    );
  }

  if (!draft) {
    return <Alert type="error" message="草稿不存在或无权访问" showIcon />;
  }

  const ready = draft.status === "draft_ready";
  const failed = draft.status === "draft_failed" || !!draft.failed_stage;
  const brandKeywordList = brandKeywords.split("\n").map((s) => s.trim()).filter(Boolean);

  return (
    <Space direction="vertical" size={16} style={{ width: "100%" }}>
      <Card size="small">
        <Row gutter={16} align="middle">
          <Col flex="auto">
            <Title level={5} style={{ margin: 0 }}>
              竞品情报引擎 · 上广告
              <Tag color="purple" style={{ marginLeft: 8 }}>
                {draft.generation_mode === "filter" ? "筛选竞品文案" : "照竞品打法生成"}
              </Tag>
            </Title>
            <Text type="secondary" style={{ fontSize: 12 }}>
              域名与落地页由商家自动带入，生成在后台跑，关掉页面也不会中断
            </Text>
          </Col>
        </Row>
        <Descriptions size="small" column={4} style={{ marginTop: 12 }}>
          <Descriptions.Item label="目标域名">{draft.domain}</Descriptions.Item>
          <Descriptions.Item label="投放国家">{draft.country_code}</Descriptions.Item>
          <Descriptions.Item label="文案语言">
            {draft.language_code || "自动（按国家）"}
          </Descriptions.Item>
          <Descriptions.Item label="广告系列">
            {draft.campaign_id ? `#${draft.campaign_id}` : "未关联"}
          </Descriptions.Item>
          <Descriptions.Item label="落地页" span={4}>
            <Text style={{ fontSize: 12 }} copyable={!!draft.landing_page_url}>
              {draft.landing_page_url || "-"}
            </Text>
          </Descriptions.Item>
        </Descriptions>
      </Card>

      <Card size="small" title="生成进度">
        <Steps size="small" items={stepItems} />
        {failed && (
          <Alert
            type="error"
            showIcon
            style={{ marginTop: 12 }}
            message={`「${STAGE_LABELS.find((s) => s.key === draft.failed_stage)?.label || draft.failed_stage}」阶段失败`}
            description={draft.error_message || "未知错误"}
            action={
              <Button size="small" icon={<ReloadOutlined />} loading={retrying} onClick={retry}>
                从失败处重试
              </Button>
            }
          />
        )}
        {generating && (
          <Text type="secondary" style={{ fontSize: 12, display: "block", marginTop: 12 }}>
            <LoadingOutlined /> 后台生成中，页面每 2.5 秒刷新一次进度
          </Text>
        )}
      </Card>

      {ready && (
        <>
          {draft.gap_report?.breaksRsaMinimum && (
            <Alert
              type="warning"
              showIcon
              message="竞品文案不足，未凑满 RSA 下限（3 标题 / 2 描述）"
              description={draft.gap_report.suggestionReason || "请手动补齐后再发布"}
            />
          )}

          <Card
            size="small"
            title="文案预览与编辑"
            extra={
              <Button size="small" type="primary" loading={saving} disabled={!dirty} onClick={() => void saveAssets()}>
                保存修改
              </Button>
            }
          >
            <Row gutter={16}>
              <Col xs={24} md={12}>
                <Text strong style={{ fontSize: 13 }}>
                  标题（{headlines.length} 条 · 每条 ≤ {HEADLINE_MAX} 字符）
                </Text>
                <Space direction="vertical" size={6} style={{ width: "100%", marginTop: 8 }}>
                  {headlines.map((text, idx) => (
                    <Input
                      key={idx}
                      value={text}
                      maxLength={HEADLINE_MAX}
                      showCount
                      size="small"
                      onChange={(e) => {
                        const next = [...headlines];
                        next[idx] = e.target.value;
                        setHeadlines(next);
                        setDirty(true);
                      }}
                    />
                  ))}
                </Space>
              </Col>
              <Col xs={24} md={12}>
                <Text strong style={{ fontSize: 13 }}>
                  描述（{descriptions.length} 条 · 每条 ≤ {DESCRIPTION_MAX} 字符）
                </Text>
                <Space direction="vertical" size={6} style={{ width: "100%", marginTop: 8 }}>
                  {descriptions.map((text, idx) => (
                    <TextArea
                      key={idx}
                      value={text}
                      maxLength={DESCRIPTION_MAX}
                      showCount
                      autoSize={{ minRows: 2, maxRows: 3 }}
                      onChange={(e) => {
                        const next = [...descriptions];
                        next[idx] = e.target.value;
                        setDescriptions(next);
                        setDirty(true);
                      }}
                    />
                  ))}
                </Space>
              </Col>
            </Row>

            <Row gutter={16} style={{ marginTop: 16 }}>
              <Col xs={24} md={12}>
                <Text strong style={{ fontSize: 13 }}>
                  品牌核心词（发布时按 PHRASE 匹配投放，可在发布确认步骤修改）
                </Text>
                <div style={{ marginTop: 8 }}>
                  {brandKeywordList.length > 0 ? (
                    <Space size={4} wrap>
                      {brandKeywordList.map((kw) => (
                        <Tag key={kw} color="blue">
                          {kw}
                        </Tag>
                      ))}
                    </Space>
                  ) : (
                    <Text type="secondary" style={{ fontSize: 12 }}>
                      未识别到品牌词
                    </Text>
                  )}
                </div>
              </Col>
              <Col xs={24} md={12}>
                <Text strong style={{ fontSize: 13 }}>
                  否定关键词（一行一个）
                </Text>
                <TextArea
                  value={negatives}
                  autoSize={{ minRows: 3, maxRows: 8 }}
                  style={{ marginTop: 8 }}
                  onChange={(e) => {
                    setNegatives(e.target.value);
                    setDirty(true);
                  }}
                />
              </Col>
            </Row>
          </Card>

          <Card size="small" title="发布到 Google Ads">
            <Space direction="vertical" size={12} style={{ width: "100%" }}>
              <Alert
                type="info"
                showIcon
                message="广告系列名、序号、CID 由 CRM 统一分配"
                description="点「确认发布」先进入最终确认步骤：标题、描述、投放关键词、否定关键词都可以再修改，再次确认才会真正发布到 Google Ads。"
              />
              <Button
                type="primary"
                icon={<RocketOutlined />}
                onClick={() => setConfirmOpen(true)}
              >
                确认发布
              </Button>
            </Space>
          </Card>

          <Modal
            title="发布前最终确认"
            open={confirmOpen}
            width={960}
            style={{ top: 24 }}
            onCancel={() => setConfirmOpen(false)}
            maskClosable={false}
            footer={[
              <Button key="back" disabled={publishing} onClick={() => setConfirmOpen(false)}>
                返回修改
              </Button>,
              <Button
                key="publish"
                type="primary"
                icon={<RocketOutlined />}
                loading={publishing}
                disabled={brandKeywordList.length === 0}
                onClick={() => void confirmPublish()}
              >
                确认发布到 Google Ads
              </Button>,
            ]}
          >
            <Space direction="vertical" size={16} style={{ width: "100%" }}>
              <Alert
                type="warning"
                showIcon
                message="这是发布前的最后一步"
                description="下面的内容都可以直接修改，点「确认发布到 Google Ads」时会自动保存全部修改并真正发布；点「返回修改」不会发布。"
              />
              <Row gutter={16}>
                <Col xs={24} md={12}>
                  <Text strong style={{ fontSize: 13 }}>
                    标题（{headlines.length} 条 · 每条 ≤ {HEADLINE_MAX} 字符）
                  </Text>
                  <Space direction="vertical" size={6} style={{ width: "100%", marginTop: 8 }}>
                    {headlines.map((text, idx) => (
                      <Input
                        key={idx}
                        value={text}
                        maxLength={HEADLINE_MAX}
                        showCount
                        size="small"
                        onChange={(e) => {
                          const next = [...headlines];
                          next[idx] = e.target.value;
                          setHeadlines(next);
                          setDirty(true);
                        }}
                      />
                    ))}
                  </Space>
                </Col>
                <Col xs={24} md={12}>
                  <Text strong style={{ fontSize: 13 }}>
                    描述（{descriptions.length} 条 · 每条 ≤ {DESCRIPTION_MAX} 字符）
                  </Text>
                  <Space direction="vertical" size={6} style={{ width: "100%", marginTop: 8 }}>
                    {descriptions.map((text, idx) => (
                      <TextArea
                        key={idx}
                        value={text}
                        maxLength={DESCRIPTION_MAX}
                        showCount
                        autoSize={{ minRows: 2, maxRows: 3 }}
                        onChange={(e) => {
                          const next = [...descriptions];
                          next[idx] = e.target.value;
                          setDescriptions(next);
                          setDirty(true);
                        }}
                      />
                    ))}
                  </Space>
                </Col>
              </Row>
              <Row gutter={16}>
                <Col xs={24} md={12}>
                  <Text strong style={{ fontSize: 13 }}>
                    投放关键词 · 品牌核心词（一行一个，按 PHRASE 匹配投放）
                  </Text>
                  <TextArea
                    value={brandKeywords}
                    autoSize={{ minRows: 3, maxRows: 8 }}
                    style={{ marginTop: 8 }}
                    placeholder="至少填一个，否则无法发布"
                    onChange={(e) => {
                      setBrandKeywords(e.target.value);
                      setDirty(true);
                    }}
                  />
                  {brandKeywordList.length === 0 && (
                    <Text type="danger" style={{ fontSize: 12 }}>
                      没有投放关键词无法发布，请至少填一个
                    </Text>
                  )}
                </Col>
                <Col xs={24} md={12}>
                  <Text strong style={{ fontSize: 13 }}>
                    否定关键词（一行一个）
                  </Text>
                  <TextArea
                    value={negatives}
                    autoSize={{ minRows: 3, maxRows: 8 }}
                    style={{ marginTop: 8 }}
                    onChange={(e) => {
                      setNegatives(e.target.value);
                      setDirty(true);
                    }}
                  />
                </Col>
              </Row>
              <div>
                <Text strong style={{ fontSize: 13 }}>
                  发布账号
                </Text>
                <div style={{ marginTop: 8 }}>
                  <Input
                    placeholder="指定 CID（可留空，由系统按可用性挑）"
                    value={customerId}
                    onChange={(e) => setCustomerId(e.target.value)}
                    style={{ width: 320 }}
                    size="small"
                  />
                </div>
              </div>
            </Space>
          </Modal>
        </>
      )}
    </Space>
  );
}
