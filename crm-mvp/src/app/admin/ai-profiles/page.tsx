"use client";

/**
 * D-046.A / C-109 IntelliCenter — Admin 商家智能画像列表页
 *
 * 路径：/admin/ai-profiles
 * 数据：GET /api/admin/ai-profiles?page=1&pageSize=50&industry=&risk=&source=&search=&user_id=
 * 编辑：点行 → AIProfileForm Modal (scope='admin') 编辑后回写
 *
 * 设计：07 拍板 U1=A + R5=B admin 可改全部 12 字段
 */
import { useState, useEffect, useCallback, useMemo } from "react";
import {
  App,
  Button,
  Card,
  Col,
  Input,
  Row,
  Select,
  Space,
  Statistic,
  Table,
  Tag,
  Tooltip,
  Typography,
} from "antd";
import { ReloadOutlined, RobotOutlined, SearchOutlined } from "@ant-design/icons";
import type { ColumnsType } from "antd/es/table";
import AppPageHeader from "@/components/AppPageHeader";
import AIProfileForm from "@/components/AIProfileForm";
import {
  COMPLIANCE_RISK_LABELS_CN,
  COMPLIANCE_RISK_LEVELS,
  INDUSTRY_CATEGORIES,
  INDUSTRY_LABELS_CN,
  PROFILE_SOURCE_LABELS_CN,
  PROFILE_SOURCES,
  type ComplianceRiskLevel,
  type IndustryCategory,
  type ProfileSource,
} from "@/lib/intellicenter/merchant-profile/types";

const { Text } = Typography;

interface ProfileRow {
  id: string;
  merchant_name: string;
  platform: string;
  merchant_id: string;
  merchant_url: string | null;
  user_id: string;
  username: string | null;
  industry_category: string | null;
  industry_subcategory: string | null;
  compliance_risk_level: ComplianceRiskLevel;
  trademark_authorization_status: string;
  profile_source: ProfileSource;
  profile_updated_at: string | null;
}

interface ApiResult {
  summary: {
    total: number;
    by_source: { key: string; count: number }[];
    by_risk: { key: string; count: number }[];
    by_industry: { key: string; count: number }[];
  };
  pagination: { page: number; pageSize: number; total: number };
  rows: ProfileRow[];
}

const RISK_COLOR: Record<ComplianceRiskLevel, string> = {
  low: "green",
  medium: "blue",
  high: "orange",
  blocked: "red",
};

const SOURCE_COLOR: Record<ProfileSource, string> = {
  none: "default",
  ai_backfill: "blue",
  manual: "green",
  feedback: "purple",
  ai_failed: "red",
};

export default function AdminAIProfilesPage() {
  const { message } = App.useApp();
  const [data, setData] = useState<ApiResult | null>(null);
  const [loading, setLoading] = useState(false);
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(50);
  const [industry, setIndustry] = useState<string>("");
  const [risk, setRisk] = useState<string>("");
  const [source, setSource] = useState<string>("");
  const [search, setSearch] = useState<string>("");
  const [searchInput, setSearchInput] = useState<string>("");
  const [editModal, setEditModal] = useState<{
    open: boolean;
    merchantId: string;
  }>({ open: false, merchantId: "" });

  const fetchData = useCallback(async () => {
    setLoading(true);
    try {
      const params = new URLSearchParams();
      params.set("page", String(page));
      params.set("pageSize", String(pageSize));
      if (industry) params.set("industry", industry);
      if (risk) params.set("risk", risk);
      if (source) params.set("source", source);
      if (search) params.set("search", search);

      const res = await fetch(`/api/admin/ai-profiles?${params.toString()}`);
      const j: { code: number; data?: ApiResult; message?: string } =
        await res.json();
      if (j.code !== 0 || !j.data) {
        message.error(j.message || "加载失败");
        return;
      }
      setData(j.data);
    } catch (e) {
      message.error(`加载失败：${String(e)}`);
    } finally {
      setLoading(false);
    }
  }, [page, pageSize, industry, risk, source, search, message]);

  useEffect(() => {
    fetchData();
  }, [fetchData]);

  const handleSearch = () => {
    setPage(1);
    setSearch(searchInput.trim());
  };

  const onEdit = useCallback((merchantId: string) => {
    setEditModal({ open: true, merchantId });
  }, []);

  const onCloseEdit = useCallback(() => {
    setEditModal((p) => ({ ...p, open: false }));
  }, []);

  const onSavedEdit = useCallback(() => {
    setEditModal((p) => ({ ...p, open: false }));
    fetchData();
  }, [fetchData]);

  const columns: ColumnsType<ProfileRow> = useMemo(
    () => [
      {
        title: "商家",
        dataIndex: "merchant_name",
        width: 240,
        render: (v: string, rec) => (
          <Space direction="vertical" size={2}>
            <Text strong>{v || "—"}</Text>
            <Text type="secondary" style={{ fontSize: 12 }}>
              {rec.platform} / {rec.merchant_id}
            </Text>
            {rec.merchant_url && (
              <a
                href={rec.merchant_url}
                target="_blank"
                rel="noreferrer"
                style={{ fontSize: 12 }}
              >
                {rec.merchant_url.replace(/^https?:\/\//, "").slice(0, 40)}
              </a>
            )}
          </Space>
        ),
      },
      {
        title: "归属用户",
        dataIndex: "username",
        width: 110,
        render: (v: string | null, rec) => (
          <Space direction="vertical" size={0}>
            <Text>{v || "—"}</Text>
            <Text type="secondary" style={{ fontSize: 11 }}>
              uid {rec.user_id}
            </Text>
          </Space>
        ),
      },
      {
        title: "行业大类",
        dataIndex: "industry_category",
        width: 160,
        render: (v: string | null, rec) => (
          <Space direction="vertical" size={0}>
            {v ? (
              <Tag color="blue">
                {INDUSTRY_LABELS_CN[v as IndustryCategory] || v}
              </Tag>
            ) : (
              <Text type="secondary">—</Text>
            )}
            {rec.industry_subcategory && (
              <Text type="secondary" style={{ fontSize: 11 }}>
                {rec.industry_subcategory}
              </Text>
            )}
          </Space>
        ),
      },
      {
        title: "合规风险",
        dataIndex: "compliance_risk_level",
        width: 100,
        align: "center" as const,
        render: (v: ComplianceRiskLevel) => (
          <Tag color={RISK_COLOR[v] || "default"}>
            {COMPLIANCE_RISK_LABELS_CN[v] || v}
          </Tag>
        ),
      },
      {
        title: "商标授权",
        dataIndex: "trademark_authorization_status",
        width: 110,
        align: "center" as const,
        render: (v: string) => {
          const colorMap: Record<string, string> = {
            unauthorized: "default",
            pending: "blue",
            authorized: "green",
            own_brand: "purple",
          };
          const labelMap: Record<string, string> = {
            unauthorized: "未授权",
            pending: "申请中",
            authorized: "已授权",
            own_brand: "自有品牌",
          };
          return <Tag color={colorMap[v] || "default"}>{labelMap[v] || v}</Tag>;
        },
      },
      {
        title: "画像来源",
        dataIndex: "profile_source",
        width: 110,
        align: "center" as const,
        render: (v: ProfileSource) => (
          <Tag color={SOURCE_COLOR[v] || "default"}>
            {PROFILE_SOURCE_LABELS_CN[v] || v}
          </Tag>
        ),
      },
      {
        title: "最后更新",
        dataIndex: "profile_updated_at",
        width: 140,
        render: (v: string | null) => {
          if (!v) return <Text type="secondary">—</Text>;
          return (
            <Tooltip title={new Date(v).toLocaleString()}>
              <Text style={{ fontSize: 12 }}>
                {new Date(v).toLocaleDateString()}
              </Text>
            </Tooltip>
          );
        },
      },
      {
        title: "操作",
        width: 120,
        render: (_: unknown, rec) => (
          <Button
            size="small"
            icon={<RobotOutlined />}
            onClick={() => onEdit(rec.id)}
          >
            编辑画像
          </Button>
        ),
      },
    ],
    [onEdit],
  );

  const summary = data?.summary;

  return (
    <div style={{ padding: 24 }}>
      <AppPageHeader
        title="AI 商家智能画像"
        subTitle="D-046.A IntelliCenter — 商家行业/合规/业务画像管理"
        extra={
          <Button icon={<ReloadOutlined />} onClick={fetchData} loading={loading}>
            刷新
          </Button>
        }
      />

      {summary && (
        <Row gutter={16} style={{ marginBottom: 16 }}>
          <Col span={6}>
            <Card size="small">
              <Statistic title="商家总数（当前筛选）" value={summary.total} />
            </Card>
          </Col>
          <Col span={6}>
            <Card size="small">
              <Statistic
                title="已分类（来源非 none）"
                value={summary.by_source
                  .filter((s) => s.key !== "none")
                  .reduce((a, b) => a + b.count, 0)}
                suffix={`/ ${summary.total}`}
              />
            </Card>
          </Col>
          <Col span={6}>
            <Card size="small">
              <Statistic
                title="高风险商家"
                value={
                  summary.by_risk.find((r) => r.key === "high")?.count || 0
                }
                valueStyle={{ color: "#fa8c16" }}
              />
            </Card>
          </Col>
          <Col span={6}>
            <Card size="small">
              <Statistic
                title="拦截商家"
                value={
                  summary.by_risk.find((r) => r.key === "blocked")?.count || 0
                }
                valueStyle={{ color: "#f5222d" }}
              />
            </Card>
          </Col>
        </Row>
      )}

      <Card size="small" style={{ marginBottom: 16 }}>
        <Space wrap>
          <Select
            placeholder="行业大类"
            allowClear
            style={{ width: 200 }}
            value={industry || undefined}
            onChange={(v) => {
              setPage(1);
              setIndustry(v || "");
            }}
            options={INDUSTRY_CATEGORIES.map((c) => ({
              value: c,
              label: `${INDUSTRY_LABELS_CN[c]} (${c})`,
            }))}
          />
          <Select
            placeholder="合规风险"
            allowClear
            style={{ width: 120 }}
            value={risk || undefined}
            onChange={(v) => {
              setPage(1);
              setRisk(v || "");
            }}
            options={COMPLIANCE_RISK_LEVELS.map((c) => ({
              value: c,
              label: COMPLIANCE_RISK_LABELS_CN[c],
            }))}
          />
          <Select
            placeholder="画像来源"
            allowClear
            style={{ width: 140 }}
            value={source || undefined}
            onChange={(v) => {
              setPage(1);
              setSource(v || "");
            }}
            options={PROFILE_SOURCES.map((c) => ({
              value: c,
              label: PROFILE_SOURCE_LABELS_CN[c],
            }))}
          />
          <Input
            placeholder="搜索商家名 / URL / MID"
            value={searchInput}
            onChange={(e) => setSearchInput(e.target.value)}
            onPressEnter={handleSearch}
            style={{ width: 240 }}
            prefix={<SearchOutlined />}
            allowClear
          />
          <Button type="primary" onClick={handleSearch}>
            搜索
          </Button>
        </Space>
      </Card>

      <Table<ProfileRow>
        rowKey="id"
        columns={columns}
        dataSource={data?.rows || []}
        loading={loading}
        size="small"
        pagination={{
          current: page,
          pageSize,
          total: data?.pagination.total || 0,
          onChange: (p, ps) => {
            setPage(p);
            setPageSize(ps);
          },
          showSizeChanger: true,
          showTotal: (t) => `共 ${t} 个商家`,
        }}
      />

      <AIProfileForm
        merchantId={editModal.merchantId}
        scope="admin"
        open={editModal.open}
        onClose={onCloseEdit}
        onSaved={onSavedEdit}
      />
    </div>
  );
}
