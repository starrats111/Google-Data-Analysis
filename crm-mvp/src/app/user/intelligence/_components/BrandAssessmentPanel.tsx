"use client";

/**
 * 品牌评估面板（广告情报页的第二个标签）。
 *
 * D-233：kyads 有一个独立的 `/brand-assessment` 页 + 历史页。CRM 里不新开侧边栏入口——
 * 07 定的是并入「广告情报」：ATC 那个标签看的是某个广告主在投什么，这个标签看的是某个
 * 域名在某国的品牌盘子（谁在竞价它的品牌词、品牌方自己投没投），两件事同源，放一起。
 *
 * 评估结果按 (域名, 国家) 全公司共享且 7 天 TTL，所以历史列表是全员可见的——
 * 同一个域名不会被两个员工各买一遍数据。
 */

import { useCallback, useEffect, useMemo, useState } from "react";
import {
  Alert,
  Button,
  Card,
  Col,
  Descriptions,
  Empty,
  Input,
  Row,
  Select,
  Space,
  Switch,
  Table,
  Tag,
  Typography,
  message,
} from "antd";
import { ExperimentOutlined, ReloadOutlined } from "@ant-design/icons";
import { COUNTRY_OPTIONS as COUNTRY_SELECT_OPTIONS, countryFilterOption, countryFilterSort } from "@/lib/countries";

const { Text, Paragraph } = Typography;

// D-288：原先这里硬编码 15 国，与领取弹窗 / 文章发布页的清单各不相同。
// 现统一取 lib/countries.ts 的全量清单，输入代码或中英文名都能搜到。
const COUNTRY_OPTIONS = COUNTRY_SELECT_OPTIONS;

const STATUS_META: Record<string, { color: string; text: string }> = {
  pending: { color: "default", text: "排队中" },
  running: { color: "processing", text: "评估中" },
  ok: { color: "success", text: "完成" },
  partial: { color: "warning", text: "部分成功" },
  failed: { color: "error", text: "失败" },
  cost_aborted: { color: "error", text: "超日预算已中止" },
};

interface JobRow {
  id: string;
  domain: string;
  countries: string[];
  status: string;
  actual_cost_usd: string | number;
  error_message: string | null;
  created_at: string;
  finished_at: string | null;
}

interface ResultRow {
  id: string;
  country: string;
  brand_token: string | null;
  brand_level: unknown;
  brand_own_ads: unknown;
  non_brand_ads: unknown;
  source: string;
}

async function callApi<T>(url: string, init?: { method?: string; body?: unknown }) {
  const res = await fetch(url, {
    method: init?.method || "GET",
    ...(init?.body
      ? { headers: { "Content-Type": "application/json" }, body: JSON.stringify(init.body) }
      : {}),
  });
  return res.json() as Promise<{ code: number; message: string; data: T }>;
}

function countAds(value: unknown): number {
  return Array.isArray(value) ? value.length : 0;
}

export default function BrandAssessmentPanel() {
  const [domain, setDomain] = useState("");
  const [countries, setCountries] = useState<string[]>(["US"]);
  const [forceRefresh, setForceRefresh] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [jobs, setJobs] = useState<JobRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [openJobId, setOpenJobId] = useState<string | null>(null);
  const [results, setResults] = useState<ResultRow[]>([]);

  const loadJobs = useCallback(async () => {
    const r = await callApi<{ items: JobRow[] }>("/api/user/rival-intel/brand-assessment?limit=30");
    if (r.code === 0) setJobs(r.data.items || []);
    setLoading(false);
  }, []);

  useEffect(() => {
    void loadJobs();
  }, [loadJobs]);

  // 有任务在排队/执行就轮询，跑完自动停
  const hasActive = useMemo(
    () => jobs.some((j) => j.status === "pending" || j.status === "running"),
    [jobs],
  );
  useEffect(() => {
    if (!hasActive) return;
    const timer = setInterval(() => void loadJobs(), 5000);
    return () => clearInterval(timer);
  }, [hasActive, loadJobs]);

  const submit = useCallback(async () => {
    if (!domain.trim()) {
      message.warning("请填写域名");
      return;
    }
    setSubmitting(true);
    try {
      const r = await callApi("/api/user/rival-intel/brand-assessment", {
        method: "POST",
        body: { domain: domain.trim(), countries, force_refresh: forceRefresh },
      });
      if (r.code !== 0) {
        message.error(r.message || "提交失败");
        return;
      }
      message.success("已提交，后台执行中");
      void loadJobs();
    } finally {
      setSubmitting(false);
    }
  }, [domain, countries, forceRefresh, loadJobs]);

  const openJob = useCallback(async (id: string) => {
    setOpenJobId(id);
    const r = await callApi<{ results: ResultRow[] }>(
      `/api/user/rival-intel/brand-assessment/${id}`,
    );
    if (r.code === 0) setResults(r.data.results || []);
    else message.error(r.message || "读取结果失败");
  }, []);

  return (
    <Space direction="vertical" size={16} style={{ width: "100%" }}>
      <Alert
        type="info"
        showIcon
        message="品牌评估：看清一个域名在目标国的品牌盘子"
        description="抓该域名在 Google 搜索结果里的品牌词广告位——品牌方自己投了没有、有哪些同行在抢它的品牌词、创意怎么写的。竞品情报引擎上广告时直接读这份结果，所以先评估过的商家，上广告会更快也更省。结果按（域名，国家）全公司共享，7 天内不重复付费。"
      />

      <Card size="small" title={<><ExperimentOutlined /> 发起评估</>}>
        <Row gutter={12} align="middle">
          <Col xs={24} sm={8}>
            <Input
              placeholder="域名或落地页，如 nvidia.com"
              value={domain}
              onChange={(e) => setDomain(e.target.value)}
              onPressEnter={submit}
            />
          </Col>
          <Col xs={24} sm={8}>
            <Select
              mode="multiple"
              value={countries}
              onChange={setCountries}
              options={COUNTRY_OPTIONS}
              showSearch
              filterOption={countryFilterOption}
              filterSort={countryFilterSort}
              placeholder="投放国家（可多选，输入代码或名称）"
              style={{ width: "100%" }}
              maxTagCount={4}
            />
          </Col>
          <Col xs={24} sm={8}>
            <Space>
              <Switch
                size="small"
                checked={forceRefresh}
                onChange={setForceRefresh}
                checkedChildren="强制刷新"
                unCheckedChildren="用缓存"
              />
              <Button type="primary" loading={submitting} onClick={submit}>
                开始评估
              </Button>
            </Space>
          </Col>
        </Row>
        <Text type="secondary" style={{ fontSize: 12, display: "block", marginTop: 8 }}>
          每个国家约消耗 $0.07（SerpApi 四个接口 + 一次 LLM 评估）。开「强制刷新」会跳过 7 天缓存重新付费，仅在竞品明显换了打法时用。
        </Text>
      </Card>

      <Card
        size="small"
        title="评估历史（全员共享）"
        extra={
          <Button size="small" icon={<ReloadOutlined />} onClick={() => void loadJobs()}>
            刷新
          </Button>
        }
      >
        <Table<JobRow>
          dataSource={jobs}
          rowKey="id"
          size="small"
          loading={loading}
          pagination={{ pageSize: 10, size: "small" }}
          onRow={(row) => ({ onClick: () => void openJob(row.id), style: { cursor: "pointer" } })}
          columns={[
            { title: "域名", dataIndex: "domain", width: 200 },
            {
              title: "国家",
              dataIndex: "countries",
              width: 160,
              render: (v: string[]) => (
                <Space size={2} wrap>
                  {(Array.isArray(v) ? v : []).map((c) => (
                    <Tag key={c} style={{ marginInlineEnd: 0 }}>{c}</Tag>
                  ))}
                </Space>
              ),
            },
            {
              title: "状态",
              dataIndex: "status",
              width: 120,
              render: (v: string, row) => {
                const meta = STATUS_META[v] || { color: "default", text: v };
                return (
                  <Space size={4}>
                    <Tag color={meta.color}>{meta.text}</Tag>
                    {row.error_message && (
                      <Text type="secondary" style={{ fontSize: 11 }} ellipsis>
                        {row.error_message}
                      </Text>
                    )}
                  </Space>
                );
              },
            },
            {
              title: "花费",
              dataIndex: "actual_cost_usd",
              width: 90,
              align: "right",
              render: (v: string | number) => `$${Number(v || 0).toFixed(3)}`,
            },
            {
              title: "发起时间",
              dataIndex: "created_at",
              width: 150,
              render: (v: string) => (v ? new Date(v).toLocaleString("zh-CN") : "-"),
            },
          ]}
        />
      </Card>

      {openJobId && (
        <Card size="small" title={`评估结果 · 任务 #${openJobId}`}>
          {results.length === 0 ? (
            <Empty description="该任务还没有产出结果（可能仍在执行，或全部国家失败）" />
          ) : (
            <Space direction="vertical" size={12} style={{ width: "100%" }}>
              {results.map((r) => (
                <Card key={r.id} size="small" type="inner" title={
                  <Space>
                    <Tag color="blue">{r.country}</Tag>
                    <Text strong>{r.brand_token || "未识别品牌词"}</Text>
                    {r.source === "cache_hit" && <Tag>缓存命中</Tag>}
                  </Space>
                }>
                  <Descriptions size="small" column={3}>
                    <Descriptions.Item label="品牌方自投广告">
                      {countAds(r.brand_own_ads)} 条
                    </Descriptions.Item>
                    <Descriptions.Item label="同行抢投广告">
                      {countAds(r.non_brand_ads)} 条
                    </Descriptions.Item>
                    <Descriptions.Item label="品牌力评估">
                      {r.brand_level ? "已生成" : "无"}
                    </Descriptions.Item>
                  </Descriptions>
                  {r.brand_level ? (
                    <Paragraph style={{ marginBottom: 0, fontSize: 12 }}>
                      <pre style={{ margin: 0, whiteSpace: "pre-wrap", fontSize: 11, color: "#666" }}>
                        {JSON.stringify(r.brand_level, null, 2)}
                      </pre>
                    </Paragraph>
                  ) : null}
                </Card>
              ))}
            </Space>
          )}
        </Card>
      )}
    </Space>
  );
}
