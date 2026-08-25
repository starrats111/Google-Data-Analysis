"use client";

/**
 * D-277：账户状态总览看板（user 侧与 admin 侧共用，仅数据接口不同）
 * 一屏看完权限内所有 Google 账户的状态；异常置顶；支持只看异常/搜索。
 * 状态来源：统一脚本 CID_List Status 列（Google 真值）→ 半小时级同步入库。
 */
import { useEffect, useMemo, useState } from "react";
import { Alert, Button, Card, Col, Input, Row, Space, Statistic, Switch, Table, Tag, Tooltip, Typography, message } from "antd";
import { ReloadOutlined } from "@ant-design/icons";
import type { ColumnsType } from "antd/es/table";

interface AccountStatusRow {
  mcc_id: string;
  mcc_name: string | null;
  owner: string;
  customer_id: string;
  customer_name: string | null;
  status: string;
  is_available: string;
  status_changed_at: string | null;
  last_synced_at: string | null;
  enabled_campaigns: number;
}

const STATUS_TAG: Record<string, { color: string; label: string }> = {
  active: { color: "green", label: "正常" },
  suspended: { color: "red", label: "已被暂停" },
  cancelled: { color: "default", label: "已注销/关闭" },
};

const AVAIL_TAG: Record<string, { color: string; label: string; tip: string }> = {
  Y: { color: "green", label: "空闲", tip: "已核实无在投系列，可用于建新广告" },
  N: { color: "blue", label: "占用", tip: "有在投系列" },
  U: { color: "orange", label: "未核实", tip: "本轮同步未核实，数据可能过期" },
  D: { color: "red", label: "禁用", tip: "账户被停或管理员停用，禁止选号" },
};

function fmtBeijing(iso: string | null): string {
  if (!iso) return "—";
  const d = new Date(iso);
  return d.toLocaleString("zh-CN", {
    timeZone: "Asia/Shanghai",
    year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", hour12: false,
  });
}

export default function AccountStatusBoard({ endpoint }: { endpoint: string }) {
  const [rows, setRows] = useState<AccountStatusRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [onlyAbnormal, setOnlyAbnormal] = useState(false);
  const [keyword, setKeyword] = useState("");

  const load = async () => {
    setLoading(true);
    try {
      const res = await fetch(endpoint);
      const json = await res.json();
      if (json.code === 0) {
        setRows(json.data || []);
      } else {
        message.error(json.message || "加载失败");
      }
    } catch {
      message.error("网络错误，加载失败");
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [endpoint]);

  const filtered = useMemo(() => {
    let out = rows;
    if (onlyAbnormal) out = out.filter((r) => r.status !== "active");
    const kw = keyword.trim().toLowerCase();
    if (kw) {
      out = out.filter((r) =>
        r.customer_id.includes(kw)
        || (r.customer_name || "").toLowerCase().includes(kw)
        || r.mcc_id.includes(kw)
        || (r.mcc_name || "").toLowerCase().includes(kw)
        || r.owner.toLowerCase().includes(kw));
    }
    return out;
  }, [rows, onlyAbnormal, keyword]);

  const stats = useMemo(() => ({
    total: rows.length,
    active: rows.filter((r) => r.status === "active").length,
    suspended: rows.filter((r) => r.status === "suspended").length,
    cancelled: rows.filter((r) => r.status === "cancelled").length,
  }), [rows]);

  const columns: ColumnsType<AccountStatusRow> = [
    {
      title: "MCC",
      key: "mcc",
      width: 200,
      render: (_, r) => (
        <Space direction="vertical" size={0}>
          <Typography.Text>{r.mcc_name || "-"}</Typography.Text>
          <Typography.Text type="secondary" style={{ fontSize: 12 }}>{r.mcc_id}</Typography.Text>
        </Space>
      ),
    },
    { title: "归属人", dataIndex: "owner", key: "owner", width: 110 },
    {
      title: "账户 CID",
      key: "cid",
      width: 180,
      render: (_, r) => (
        <Space direction="vertical" size={0}>
          <Typography.Text copyable={{ text: r.customer_id }}>{r.customer_id}</Typography.Text>
          {r.customer_name ? (
            <Typography.Text type="secondary" style={{ fontSize: 12 }}>{r.customer_name}</Typography.Text>
          ) : null}
        </Space>
      ),
    },
    {
      title: "Google 状态",
      dataIndex: "status",
      key: "status",
      width: 130,
      filters: [
        { text: "正常", value: "active" },
        { text: "已被暂停", value: "suspended" },
        { text: "已注销/关闭", value: "cancelled" },
      ],
      onFilter: (v, r) => r.status === v,
      render: (s: string) => {
        const t = STATUS_TAG[s] || { color: "default", label: s };
        return <Tag color={t.color}>{t.label}</Tag>;
      },
    },
    {
      title: (
        <Tooltip title="最近一次状态变化时间（北京时间；老数据在脚本升级前无记录）">
          状态变化时间
        </Tooltip>
      ),
      dataIndex: "status_changed_at",
      key: "status_changed_at",
      width: 160,
      render: (v: string | null) => fmtBeijing(v),
      sorter: (a, b) => (a.status_changed_at || "").localeCompare(b.status_changed_at || ""),
    },
    {
      title: "在投系列",
      dataIndex: "enabled_campaigns",
      key: "enabled_campaigns",
      width: 90,
      sorter: (a, b) => a.enabled_campaigns - b.enabled_campaigns,
      render: (n: number) => (n > 0 ? <Tag color="blue">{n}</Tag> : <Typography.Text type="secondary">0</Typography.Text>),
    },
    {
      title: "可用性",
      dataIndex: "is_available",
      key: "is_available",
      width: 90,
      render: (v: string) => {
        const t = AVAIL_TAG[v] || { color: "default", label: v, tip: "" };
        return <Tooltip title={t.tip}><Tag color={t.color}>{t.label}</Tag></Tooltip>;
      },
    },
    {
      title: "最近同步",
      dataIndex: "last_synced_at",
      key: "last_synced_at",
      width: 160,
      render: (v: string | null) => (
        <Typography.Text type="secondary" style={{ fontSize: 12 }}>{fmtBeijing(v)}</Typography.Text>
      ),
    },
  ];

  const abnormal = stats.suspended + stats.cancelled;

  return (
    <div style={{ padding: 24 }}>
      <Typography.Title level={4} style={{ marginTop: 0 }}>账户状态总览</Typography.Title>
      <Alert
        type="info"
        showIcon
        style={{ marginBottom: 16 }}
        message="状态由各 MCC 统一脚本自动回传（半小时级）。账户被 Google 停用会自动标记并通知归属人；恢复需人工核实后在 MCC 管理点「同步 CID」。「需要验证」的事前预警 Google 不对普通付款账户开放，此处展示的是账户级状态真值。"
      />
      <Row gutter={16} style={{ marginBottom: 16 }}>
        <Col span={6}><Card size="small"><Statistic title="账户总数" value={stats.total} /></Card></Col>
        <Col span={6}><Card size="small"><Statistic title="正常" value={stats.active} valueStyle={{ color: "#3f8600" }} /></Card></Col>
        <Col span={6}><Card size="small"><Statistic title="已被暂停" value={stats.suspended} valueStyle={{ color: stats.suspended > 0 ? "#cf1322" : undefined }} /></Card></Col>
        <Col span={6}><Card size="small"><Statistic title="已注销/关闭" value={stats.cancelled} /></Card></Col>
      </Row>
      <Space style={{ marginBottom: 12 }} wrap>
        <Input.Search
          allowClear
          placeholder="搜 CID / 账户名 / MCC / 归属人"
          style={{ width: 280 }}
          onChange={(e) => setKeyword(e.target.value)}
        />
        <span>
          只看异常 <Switch checked={onlyAbnormal} onChange={setOnlyAbnormal} />
          {abnormal > 0 ? <Typography.Text type="danger" style={{ marginLeft: 8 }}>（{abnormal} 个异常）</Typography.Text> : null}
        </span>
        <Button icon={<ReloadOutlined />} onClick={() => void load()} loading={loading}>刷新</Button>
      </Space>
      <Table<AccountStatusRow>
        rowKey={(r) => `${r.mcc_id}-${r.customer_id}`}
        size="small"
        loading={loading}
        columns={columns}
        dataSource={filtered}
        pagination={{ pageSize: 50, showSizeChanger: true, showTotal: (t) => `共 ${t} 个账户` }}
      />
    </div>
  );
}
