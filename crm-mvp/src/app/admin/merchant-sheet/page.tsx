"use client";

import { useState, useEffect, useCallback } from "react";
import {
  Card, Table, Input, Button, Space, Tag, Tabs, Alert, Tooltip, Modal, Popconfirm, App,
} from "antd";
import {
  SearchOutlined, CloudSyncOutlined, WarningOutlined, StarOutlined, DeleteOutlined, LinkOutlined,
} from "@ant-design/icons";

export default function MerchantSheetPage() {
  const { message } = App.useApp();
  const [tab, setTab] = useState("violations");

  // 违规商家
  const [violations, setViolations] = useState<any[]>([]);
  const [vioTotal, setVioTotal] = useState(0);
  const [vioPage, setVioPage] = useState(1);
  const [vioLoading, setVioLoading] = useState(false);
  const [vioSearch, setVioSearch] = useState("");

  // 推荐商家
  const [recommendations, setRecommendations] = useState<any[]>([]);
  const [recTotal, setRecTotal] = useState(0);
  const [recPage, setRecPage] = useState(1);
  const [recLoading, setRecLoading] = useState(false);
  const [recSearch, setRecSearch] = useState("");

  // 共享表格
  const [sheetUrl, setSheetUrl] = useState("");
  const [sheetSyncing, setSheetSyncing] = useState(false);
  const [syncResult, setSyncResult] = useState<any>(null);
  const [lastSynced, setLastSynced] = useState<string | null>(null);

  // 详情弹窗
  const [detailModal, setDetailModal] = useState(false);
  const [detailTitle, setDetailTitle] = useState("");
  const [detailContent, setDetailContent] = useState("");

  const fetchConfig = async () => {
    const res = await fetch("/api/admin/merchant-sheet?action=config").then((r) => r.json());
    if (res.code === 0) {
      setSheetUrl(res.data.sheet_url || "");
      setLastSynced(res.data.last_synced_at);
    }
  };

  const fetchViolations = useCallback(async (p = 1) => {
    setVioLoading(true);
    const params = new URLSearchParams({ action: "violations", page: String(p), pageSize: "50" });
    if (vioSearch) params.set("search", vioSearch);
    const res = await fetch(`/api/admin/merchant-sheet?${params}`).then((r) => r.json());
    if (res.code === 0) { setViolations(res.data.items); setVioTotal(res.data.total); setVioPage(p); }
    setVioLoading(false);
  }, [vioSearch]);

  const fetchRecommendations = useCallback(async (p = 1) => {
    setRecLoading(true);
    const params = new URLSearchParams({ action: "recommendations", page: String(p), pageSize: "50" });
    if (recSearch) params.set("search", recSearch);
    const res = await fetch(`/api/admin/merchant-sheet?${params}`).then((r) => r.json());
    if (res.code === 0) { setRecommendations(res.data.items); setRecTotal(res.data.total); setRecPage(p); }
    setRecLoading(false);
  }, [recSearch]);

  useEffect(() => { fetchConfig(); }, []);
  useEffect(() => {
    if (tab === "violations") fetchViolations(1);
    else fetchRecommendations(1);
  }, [tab]); // eslint-disable-line react-hooks/exhaustive-deps

  const handleSaveUrl = async () => {
    if (!sheetUrl.trim()) { message.warning("请输入 Google Sheets 链接"); return; }
    const res = await fetch("/api/admin/merchant-sheet", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "save_url", sheet_url: sheetUrl.trim() }),
    }).then((r) => r.json());
    if (res.code === 0) message.success("链接已保存");
    else message.error(res.message);
  };

  const handleSync = async () => {
    setSheetSyncing(true);
    setSyncResult(null);
    try {
      const res = await fetch("/api/admin/merchant-sheet", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "sync" }),
      }).then((r) => r.json());
      if (res.code === 0) {
        setSyncResult(res.data);
        const v = res.data?.violation || {};
        const r = res.data?.recommendation || {};
        message.success(`同步完成 — 违规：新增 ${v.new || 0} 条，标记 ${v.marked || 0} 个 | 推荐：新增 ${r.new || 0} 条，标记 ${r.marked || 0} 个`);
        fetchViolations(1);
        fetchRecommendations(1);
        fetchConfig();
      } else message.error(res.message);
    } catch (e: any) {
      message.error("同步失败: " + e.message);
    } finally {
      setSheetSyncing(false);
    }
  };

  const handleDelete = async (type: string, id: string) => {
    const res = await fetch("/api/admin/merchant-sheet", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: type === "violation" ? "delete_violation" : "delete_recommendation", id }),
    }).then((r) => r.json());
    if (res.code === 0) {
      message.success("已删除");
      if (type === "violation") fetchViolations(vioPage);
      else fetchRecommendations(recPage);
    } else message.error(res.message);
  };

  return (
    <div>
      {/* 共享表格配置区 */}
      <Card size="small" style={{ marginBottom: 16 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 12, flexWrap: "wrap" }}>
          <LinkOutlined style={{ fontSize: 16, color: "#1890ff" }} />
          <span style={{ fontWeight: 600 }}>Google 共享表格</span>
          <Input
            placeholder="粘贴 Google Sheets 链接（包含黑名单 + 推荐商家表）"
            style={{ flex: 1, minWidth: 300 }}
            value={sheetUrl}
            onChange={(e) => setSheetUrl(e.target.value)}
            onPressEnter={handleSaveUrl}
          />
          <Button onClick={handleSaveUrl}>保存</Button>
          <Button type="primary" loading={sheetSyncing} onClick={handleSync} disabled={!sheetUrl} icon={<CloudSyncOutlined />}>
            统一同步
          </Button>
          <Tooltip title="从同一个 Google Sheets 链接同步黑名单（gid=0）和推荐商家表（第二个 sheet），按商家名称+域名跨平台匹配">
            <span style={{ fontSize: 12, color: "#999", cursor: "help" }}>ⓘ</span>
          </Tooltip>
          {lastSynced && <span style={{ fontSize: 12, color: "#999" }}>上次同步: {new Date(lastSynced).toLocaleString("zh-CN", { timeZone: "Asia/Shanghai" })}</span>}
        </div>
      </Card>

      {syncResult && (
        <Alert
          type={syncResult.violation?.error || syncResult.recommendation?.error ? "warning" : "success"}
          showIcon closable style={{ marginBottom: 16 }}
          message={
            (syncResult.violation?.error || syncResult.recommendation?.error)
              ? "部分同步完成（有错误）"
              : `统一同步完成 — 违规：共 ${syncResult.violation?.total ?? 0} 条，新增 ${syncResult.violation?.new ?? 0} 条，标记 ${syncResult.violation?.marked ?? 0} 个 | 推荐：共 ${syncResult.recommendation?.total ?? 0} 条，新增 ${syncResult.recommendation?.new ?? 0} 条，标记 ${syncResult.recommendation?.marked ?? 0} 个`
          }
          description={
            (syncResult.violation?.error || syncResult.recommendation?.error)
              ? [
                  syncResult.violation?.error && `违规同步错误: ${syncResult.violation.error}`,
                  syncResult.recommendation?.error && `推荐同步错误: ${syncResult.recommendation.error}`,
                  !syncResult.violation?.error && `违规：共 ${syncResult.violation?.total ?? 0} 条，新增 ${syncResult.violation?.new ?? 0} 条`,
                  !syncResult.recommendation?.error && `推荐：共 ${syncResult.recommendation?.total ?? 0} 条，新增 ${syncResult.recommendation?.new ?? 0} 条`,
                ].filter(Boolean).join("\n")
              : undefined
          }
          onClose={() => setSyncResult(null)}
        />
      )}

      {/* Tab 切换 */}
      <Card>
        <Tabs activeKey={tab} onChange={setTab} items={[
          { key: "violations", label: <span><WarningOutlined style={{ color: "#ff4d4f", marginRight: 4 }} />违规商家（黑名单）</span> },
          { key: "recommendations", label: <span><StarOutlined style={{ color: "#52c41a", marginRight: 4 }} />推荐商家</span> },
        ]} />

        {tab === "violations" && (
          <>
            <div style={{ marginBottom: 12 }}>
              <Space>
                <Input allowClear placeholder="搜索商家名" style={{ width: 240 }} prefix={<SearchOutlined />}
                  value={vioSearch} onChange={(e) => setVioSearch(e.target.value)} onPressEnter={() => fetchViolations(1)} />
                <Button type="primary" size="small" onClick={() => fetchViolations(1)}>查询</Button>
              </Space>
            </div>
            <Table rowKey="id" loading={vioLoading} dataSource={violations} size="small" scroll={{ x: 1100 }}
              pagination={{ current: vioPage, pageSize: 50, total: vioTotal, showTotal: (t) => `共 ${t} 条`, onChange: (p) => fetchViolations(p) }}
              columns={[
                { title: "商家名称", dataIndex: "merchant_name", width: 200, ellipsis: true },
                { title: "平台", dataIndex: "platform", width: 80, render: (v: string) => v ? <Tag>{v}</Tag> : <Tag>全平台</Tag> },
                { title: "商家域名", dataIndex: "merchant_domain", width: 180, ellipsis: true,
                  render: (v: string) => v ? <a href={v.startsWith("http") ? v : `https://${v}`} target="_blank" rel="noreferrer">{v}</a> : "-" },
                { title: "违规原因", dataIndex: "violation_reason", width: 120,
                  render: (v: string) => v ? <Button type="link" size="small" onClick={() => { setDetailTitle("违规原因"); setDetailContent(v); setDetailModal(true); }}>查看</Button> : "-" },
                { title: "违规时间", dataIndex: "violation_time", width: 120,
                  render: (v: string) => v ? new Date(v).toLocaleDateString("zh-CN", { timeZone: "Asia/Shanghai" }) : "-" },
                { title: "名单来源", dataIndex: "source", width: 100, render: (v: string) => v || "-" },
                { title: "同步批次", dataIndex: "upload_batch", width: 200, ellipsis: true },
                { title: "操作", width: 80, fixed: "right" as const,
                  render: (_: unknown, record: any) => (
                    <Popconfirm title="确认删除？" onConfirm={() => handleDelete("violation", record.id)}>
                      <Button type="link" size="small" danger icon={<DeleteOutlined />} />
                    </Popconfirm>
                  ),
                },
              ]}
            />
          </>
        )}

        {tab === "recommendations" && (
          <>
            <div style={{ marginBottom: 12 }}>
              <Space>
                <Input allowClear placeholder="搜索商家名" style={{ width: 240 }} prefix={<SearchOutlined />}
                  value={recSearch} onChange={(e) => setRecSearch(e.target.value)} onPressEnter={() => fetchRecommendations(1)} />
                <Button type="primary" size="small" onClick={() => fetchRecommendations(1)}>查询</Button>
              </Space>
            </div>
            <Table rowKey="id" loading={recLoading} dataSource={recommendations} size="small" scroll={{ x: 1000 }}
              pagination={{ current: recPage, pageSize: 50, total: recTotal, showTotal: (t) => `共 ${t} 条`, onChange: (p) => fetchRecommendations(p) }}
              columns={[
                { title: "商家名称", dataIndex: "merchant_name", width: 200, ellipsis: true },
                { title: "ROI参考", dataIndex: "roi_reference", width: 100, render: (v: string) => v || "-" },
                { title: "佣金率", dataIndex: "commission_info", width: 100, render: (v: string) => v || "-" },
                { title: "结算率", dataIndex: "settlement_info", width: 100, render: (v: string) => v || "-" },
                { title: "备注/标记", dataIndex: "remark", width: 200,
                  render: (v: string) => v ? <Button type="link" size="small" onClick={() => { setDetailTitle("推荐详情"); setDetailContent(v); setDetailModal(true); }}>查看</Button> : "-" },
                { title: "分享时间", dataIndex: "share_time", width: 100, render: (v: string) => v || "-" },
                { title: "同步批次", dataIndex: "upload_batch", width: 200, ellipsis: true },
                { title: "操作", width: 80, fixed: "right" as const,
                  render: (_: unknown, record: any) => (
                    <Popconfirm title="确认删除？" onConfirm={() => handleDelete("recommendation", record.id)}>
                      <Button type="link" size="small" danger icon={<DeleteOutlined />} />
                    </Popconfirm>
                  ),
                },
              ]}
            />
          </>
        )}
      </Card>

      <Modal title={detailTitle} open={detailModal} onCancel={() => setDetailModal(false)} footer={null} width={480}>
        <div style={{ whiteSpace: "pre-wrap", lineHeight: 1.8, padding: "8px 0" }}>{detailContent}</div>
      </Modal>
    </div>
  );
}
