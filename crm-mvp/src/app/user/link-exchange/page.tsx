"use client";

import { notFound } from "next/navigation";
import { useState, useEffect, useCallback, useRef } from "react";
import {
  Table, Tag, Button, Input, Space, Typography, Card, Row, Col,
  Tooltip, App, Badge, Popconfirm, Statistic,
} from "antd";
import type { ColumnsType } from "antd/es/table";
import {
  CheckCircleOutlined, CloseCircleOutlined, QuestionCircleOutlined,
  SyncOutlined, ThunderboltOutlined, LinkOutlined, EditOutlined,
  CheckOutlined, CloseOutlined, ReloadOutlined, FileTextOutlined,
} from "@ant-design/icons";

const { Text, Title } = Typography;

interface CampaignRow {
  campaignId: string;
  googleCampaignId: string | null;
  campaignName: string | null;
  platform: string;
  mid: string;
  matched: boolean;
  merchantId: string | null;
  merchantName: string | null;
  trackingLink: string | null;
  refererUrl: string | null;
  refererSource: "manual" | "article" | "none";
  linkStatus: "unchecked" | "valid" | "invalid";
  linkCheckedAt: string | null;
  linkCheckReason: string | null;
  taskStatus: string | null;
  taskTargetCount: number | null;
  taskDoneCount: number | null;
  taskCreatedAt: string | null;
  taskFinishedAt: string | null;
  suffixEnabled: boolean;
  lastApplyAt: string | null;
}

interface PageData {
  rows: CampaignRow[];
  defaultClickCount: number;
  taskSummary: { pending: number; running: number };
  total: number;
  matched: number;
}

function LinkStatusTag({ status, reason }: { status: string; reason?: string | null }) {
  if (status === "valid") return <Tag icon={<CheckCircleOutlined />} color="success">有效</Tag>;
  if (status === "invalid") return (
    <Tooltip title={reason ?? "链接无效"}>
      <Tag icon={<CloseCircleOutlined />} color="error">无效</Tag>
    </Tooltip>
  );
  return <Tag icon={<QuestionCircleOutlined />} color="default">未验证</Tag>;
}

function TaskStatusBadge({ status, done, target }: { status: string | null; done: number | null; target: number | null }) {
  if (!status) return <Text type="secondary" style={{ fontSize: 12 }}>—</Text>;
  if (status === "done") return <Badge status="success" text={<Text style={{ fontSize: 12 }}>完成 {done}/{target}</Text>} />;
  if (status === "running") return <Badge status="processing" text={<Text style={{ fontSize: 12 }}>进行中 {done}/{target}</Text>} />;
  if (status === "pending") return <Badge status="warning" text={<Text style={{ fontSize: 12 }}>等待中 0/{target}</Text>} />;
  if (status === "failed") return <Badge status="error" text={<Text style={{ fontSize: 12 }}>失败</Text>} />;
  return <Text style={{ fontSize: 12 }}>{status}</Text>;
}

export default function LinkExchangePage() {
  // 仅限本地开发使用，生产环境不可访问
  if (process.env.NODE_ENV === "production") {
    notFound();
  }

  const { message } = App.useApp();
  const [data, setData] = useState<PageData | null>(null);
  const [loading, setLoading] = useState(true);
  const [starting, setStarting] = useState(false);
  const [clickCount, setClickCount] = useState<number>(10);
  const [editingReferer, setEditingReferer] = useState<string | null>(null);
  const [refererDraft, setRefererDraft] = useState("");
  const [savingReferer, setSavingReferer] = useState(false);
  const pollTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const autoValidatedRef = useRef(false); // 防止重复自动验证

  // 自动验证：对所有有 tracking_link 的商家进行 HTTP 检测
  const autoValidate = useCallback(async (rows: CampaignRow[]) => {
    const merchantIds = rows
      .filter((r) => r.matched && r.merchantId && r.trackingLink)
      .map((r) => r.merchantId as string);

    if (merchantIds.length === 0) return;

    const msgKey = "auto-validate";
    message.loading({ content: `正在验证 ${merchantIds.length} 个商家链接…`, key: msgKey, duration: 0 });

    try {
      const res = await fetch("/api/user/link-exchange/validate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ merchantIds }),
      }).then((r) => r.json());

      if (res.code === 0) {
        const { valid, invalid } = res.data.stats;
        if (invalid > 0) {
          message.warning({ content: `链接验证完成：${valid} 个正常，${invalid} 个失效（已标红）`, key: msgKey, duration: 5 });
        } else {
          message.success({ content: `${valid} 个商家链接全部正常`, key: msgKey, duration: 4 });
        }
      } else {
        message.destroy(msgKey);
      }
    } catch {
      message.destroy(msgKey);
    }
  }, [message]);

  const fetchData = useCallback(async (triggerAutoValidate = false) => {
    try {
      const res = await fetch("/api/user/link-exchange").then((r) => r.json());
      if (res.code === 0) {
        setData(res.data);
        setClickCount(res.data.defaultClickCount ?? 10);

        // 首次加载 or 外部请求时自动验证
        if (triggerAutoValidate || !autoValidatedRef.current) {
          autoValidatedRef.current = true;
          // 异步触发，不阻塞页面渲染
          setTimeout(() => autoValidate(res.data.rows), 800);
        }
      }
    } finally {
      setLoading(false);
    }
  }, [autoValidate]);

  useEffect(() => {
    fetchData(false);
  }, [fetchData]);

  // 有任务进行中时每 5 秒轮询（不触发重复验证）
  useEffect(() => {
    const hasActive =
      data && (data.taskSummary.pending > 0 || data.taskSummary.running > 0);
    if (hasActive) {
      if (!pollTimerRef.current) {
        pollTimerRef.current = setInterval(() => fetchData(false), 5000);
      }
    } else {
      if (pollTimerRef.current) {
        clearInterval(pollTimerRef.current);
        pollTimerRef.current = null;
      }
    }
    return () => {
      if (pollTimerRef.current) clearInterval(pollTimerRef.current);
    };
  }, [data, fetchData]);

  // 手动刷新（重新验证）
  const handleRefresh = () => {
    autoValidatedRef.current = false;
    setLoading(true);
    fetchData(true);
  };

  // 开始刷点击
  const handleStart = async () => {
    if (!Number.isInteger(clickCount) || clickCount < 1) {
      message.warning("请输入有效的点击次数（≥1）");
      return;
    }
    setStarting(true);
    try {
      const res = await fetch("/api/user/link-exchange/start", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ clickCount }),
      }).then((r) => r.json());
      if (res.code === 0) {
        message.success(res.data.message);
        fetchData(false);
      } else {
        message.error(res.message ?? "启动失败");
      }
    } finally {
      setStarting(false);
    }
  };

  // 保存来路 URL
  const handleSaveReferer = async (merchantId: string) => {
    setSavingReferer(true);
    try {
      const res = await fetch("/api/user/settings/merchant-referer", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ merchantId, refererUrl: refererDraft.trim() || null }),
      }).then((r) => r.json());
      if (res.code === 0) {
        message.success("来路已保存");
        setEditingReferer(null);
        fetchData(false);
      } else {
        message.error(res.message ?? "保存失败");
      }
    } finally {
      setSavingReferer(false);
    }
  };

  const rows = data?.rows ?? [];
  const taskSummary = data?.taskSummary;
  const hasActiveTasks = (taskSummary?.pending ?? 0) > 0 || (taskSummary?.running ?? 0) > 0;
  const matchedCount = data?.matched ?? 0;
  const totalCount = data?.total ?? 0;
  const unmatchedCount = totalCount - matchedCount;

  const columns: ColumnsType<CampaignRow> = [
    {
      title: "广告系列",
      dataIndex: "campaignName",
      key: "campaignName",
      width: 220,
      ellipsis: true,
      render: (name: string | null, row) => (
        <Tooltip title={name}>
          <Space size={4}>
            {!row.matched && <Tag color="red" style={{ margin: 0, fontSize: 11 }}>未匹配</Tag>}
            <Text style={{ fontSize: 13 }}>{name ?? row.googleCampaignId ?? "—"}</Text>
          </Space>
        </Tooltip>
      ),
    },
    {
      title: "平台 / MID",
      key: "platform",
      width: 110,
      render: (_: unknown, row) =>
        row.platform ? (
          <Space size={2} direction="vertical" style={{ gap: 0 }}>
            <Tag color="blue" style={{ margin: 0 }}>{row.platform}</Tag>
            <Text type="secondary" style={{ fontSize: 11 }}>{row.mid}</Text>
          </Space>
        ) : (
          <Text type="secondary" style={{ fontSize: 12 }}>未解析</Text>
        ),
    },
    {
      title: "来路 URL",
      key: "referer",
      width: 230,
      render: (_: unknown, row) => {
        if (!row.matched) return <Text type="secondary" style={{ fontSize: 12 }}>—</Text>;
        const isEditing = editingReferer === row.merchantId;

        if (isEditing) {
          return (
            <Space size={4}>
              <Input
                size="small"
                value={refererDraft}
                onChange={(e) => setRefererDraft(e.target.value)}
                placeholder="https://..."
                style={{ width: 155, fontSize: 12 }}
              />
              <Button size="small" type="primary" icon={<CheckOutlined />} loading={savingReferer}
                onClick={() => handleSaveReferer(row.merchantId!)} />
              <Button size="small" icon={<CloseOutlined />} onClick={() => setEditingReferer(null)} />
            </Space>
          );
        }

        return (
          <Space size={4}>
            {row.refererUrl ? (
              <Tooltip title={row.refererUrl}>
                <Space size={3}>
                  {row.refererSource === "article" && (
                    <Tooltip title="来自文章链接（自动检测）">
                      <FileTextOutlined style={{ color: "#52c41a", fontSize: 12 }} />
                    </Tooltip>
                  )}
                  <Text style={{ fontSize: 12, maxWidth: 170 }} ellipsis>{row.refererUrl}</Text>
                </Space>
              </Tooltip>
            ) : (
              <Text type="secondary" style={{ fontSize: 12 }}>未配置</Text>
            )}
            <Button size="small" type="link" icon={<EditOutlined />} style={{ padding: 0 }}
              onClick={() => { setEditingReferer(row.merchantId); setRefererDraft(row.refererUrl ?? ""); }} />
          </Space>
        );
      },
    },
    {
      title: "商家追踪链接",
      key: "trackingLink",
      width: 190,
      render: (_: unknown, row) => {
        if (!row.trackingLink) return <Text type="secondary" style={{ fontSize: 12 }}>—</Text>;
        return (
          <Tooltip title={row.trackingLink}>
            <Button size="small" type="link" icon={<LinkOutlined />} style={{ padding: 0, fontSize: 12 }}
              onClick={() => { navigator.clipboard.writeText(row.trackingLink!); message.success("已复制"); }}>
              {row.merchantName ?? "复制链接"}
            </Button>
          </Tooltip>
        );
      },
    },
    {
      title: "链接状态",
      key: "linkStatus",
      width: 90,
      align: "center",
      render: (_: unknown, row) =>
        row.matched ? <LinkStatusTag status={row.linkStatus} reason={row.linkCheckReason} />
          : <Text type="secondary" style={{ fontSize: 12 }}>—</Text>,
    },
    {
      title: "点击任务",
      key: "taskStatus",
      width: 130,
      align: "center",
      render: (_: unknown, row) => (
        <TaskStatusBadge status={row.taskStatus} done={row.taskDoneCount} target={row.taskTargetCount} />
      ),
    },
  ];

  return (
    <div>
      {/* 标题栏 */}
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 16 }}>
        <Title level={4} style={{ margin: 0 }}>
          <ThunderboltOutlined /> 换链接工作台
        </Title>
        <Button icon={<ReloadOutlined />} onClick={handleRefresh} loading={loading}>
          刷新并重新验证
        </Button>
      </div>

      {/* 统计卡 */}
      <Row gutter={[16, 16]} style={{ marginBottom: 16 }}>
        <Col xs={12} sm={6}>
          <Card size="small"><Statistic title="广告系列" value={totalCount} /></Card>
        </Col>
        <Col xs={12} sm={6}>
          <Card size="small">
            <Statistic title="已匹配商家"
              value={matchedCount}
              styles={{ content: { color: matchedCount === totalCount && totalCount > 0 ? "#52c41a" : "#faad14" } }} />
          </Card>
        </Col>
        <Col xs={12} sm={6}>
          <Card size="small">
            <Statistic title="未匹配"
              value={unmatchedCount}
              styles={{ content: { color: unmatchedCount > 0 ? "#ff4d4f" : "#52c41a" } }} />
          </Card>
        </Col>
        <Col xs={12} sm={6}>
          <Card size="small">
            <Statistic title="进行中任务"
              value={(taskSummary?.pending ?? 0) + (taskSummary?.running ?? 0)}
              suffix={hasActiveTasks ? <SyncOutlined spin style={{ fontSize: 14, color: "#1677ff" }} /> : undefined}
              styles={{ content: { color: hasActiveTasks ? "#1677ff" : undefined } }} />
          </Card>
        </Col>
      </Row>

      {/* 启动控制条 */}
      <Card size="small" style={{ marginBottom: 16 }}>
        <Space size={12} wrap>
          <Text>每个广告系列刷</Text>
          <Space.Compact>
            <Input
              type="number" min={1} max={10000}
              value={clickCount}
              onChange={(e) => setClickCount(Number(e.target.value))}
              style={{ width: 80 }}
            />
            <Input defaultValue="次点击" disabled style={{ width: 58, color: "#595959", background: "#fafafa", cursor: "default" }} />
          </Space.Compact>
          <Popconfirm
            title={`将为 ${matchedCount} 个已匹配广告系列各创建 ${clickCount} 次点击任务，确认开始？`}
            onConfirm={handleStart} okText="确认" cancelText="取消">
            <Button type="primary" icon={<ThunderboltOutlined />} loading={starting}>开始</Button>
          </Popconfirm>
          {hasActiveTasks && (
            <Text type="secondary" style={{ fontSize: 13 }}>
              <SyncOutlined spin style={{ marginRight: 4 }} />
              等待中 {taskSummary?.pending}，执行中 {taskSummary?.running}（每 5 秒自动刷新）
            </Text>
          )}
        </Space>
      </Card>

      {/* 广告系列表格 */}
      <Card size="small"
        title={`广告系列（共 ${totalCount} 个，已匹配 ${matchedCount} 个）`}
        extra={<Text type="secondary" style={{ fontSize: 12 }}>
          <FileTextOutlined style={{ marginRight: 4 }} />来路 URL 优先使用文章链接自动填入
        </Text>}
      >
        <Table
          columns={columns}
          dataSource={rows}
          rowKey="campaignId"
          size="small"
          loading={loading}
          pagination={{ pageSize: 50, showTotal: (t) => `共 ${t} 条`, showSizeChanger: false }}
          rowClassName={(row) => {
            if (row.matched && row.linkStatus === "invalid") return "row-invalid-link";
            if (!row.matched) return "row-unmatched";
            return "";
          }}
          scroll={{ x: 980 }}
        />
      </Card>

      <style>{`
        .row-unmatched td { background: #fff7f7 !important; }
        .row-invalid-link td { background: #fff1f0 !important; }
        .row-invalid-link td:first-child { border-left: 3px solid #ff4d4f !important; }
      `}</style>
    </div>
  );
}
