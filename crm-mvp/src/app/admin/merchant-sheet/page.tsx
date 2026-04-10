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

  // Service Account
  const [saEmail, setSaEmail] = useState<string | null>(null);

  // 详情弹窗
  const [detailModal, setDetailModal] = useState(false);
  const [detailTitle, setDetailTitle] = useState("");
  const [detailContent, setDetailContent] = useState("");

  const fetchConfig = async () => {
    const res = await fetch("/api/admin/merchant-sheet?action=config").then((r) => r.json());
    if (res.code === 0) {
      setSheetUrl(res.data.sheet_url || "");
      setLastSynced(res.data.last_synced_at);
      setSaEmail(res.data.sa_email || null);
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

  const [syncProgress, setSyncProgress] = useState("");

  const pollSyncStatus = async () => {
    const maxPoll = 180;
    for (let i = 0; i < maxPoll; i++) {
      await new Promise((r) => setTimeout(r, 3000));
      try {
        const res = await fetch("/api/admin/merchant-sheet?action=sync_status").then((r) => r.json());
        if (res.code !== 0) continue;
        const st = res.data;
        setSyncProgress(st.progress || "");
        if (!st.running) {
          if (st.error) {
            message.error(`同步失败: ${st.error}`);
          } else if (st.result) {
            setSyncResult(st.result);
            const v = st.result?.violation || {};
            const r = st.result?.recommendation || {};
            message.success(`同步完成 — 违规：新增 ${v.new || 0} 条，更新 ${v.updated || 0} 条，标记 ${v.marked || 0} 个 | 推荐：新增 ${r.new || 0} 条，标记 ${r.marked || 0} 个`);
          }
          fetchViolations(1);
          fetchRecommendations(1);
          fetchConfig();
          return;
        }
      } catch { /* ignore poll error */ }
    }
    message.warning("同步仍在后台运行，请稍后刷新页面查看结果");
  };

  const handleSync = async () => {
    setSheetSyncing(true);
    setSyncResult(null);
    setSyncProgress("正在启动同步…");
    try {
      let csvData: string | undefined;
      if (!saEmail) {
        const sheetIdMatch = sheetUrl.match(/\/spreadsheets\/d\/([a-zA-Z0-9_-]+)/);
        if (sheetIdMatch) {
          const sid = sheetIdMatch[1];
          const csvUrls = [
            `https://docs.google.com/spreadsheets/d/${sid}/gviz/tq?tqx=out:csv&gid=0`,
            `https://docs.google.com/spreadsheets/d/${sid}/export?format=csv&gid=0`,
          ];
          for (const url of csvUrls) {
            try {
              const resp = await fetch(url);
              if (resp.ok) {
                let text = await resp.text();
                if (text.charCodeAt(0) === 0xFEFF) text = text.slice(1);
                if (text.trim()) { csvData = text; break; }
              }
            } catch { /* try next URL */ }
          }
        }
      }

      const res = await fetch("/api/admin/merchant-sheet", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "sync", ...(csvData ? { csv_data: csvData } : {}) }),
      }).then((r) => r.json());

      if (res.code === 0 && res.data?.async) {
        message.info(res.message || "同步已启动，正在后台执行…");
        await pollSyncStatus();
      } else if (res.code === 0) {
        setSyncResult(res.data);
        message.success(res.message);
        fetchViolations(1);
        fetchRecommendations(1);
        fetchConfig();
      } else {
        message.error(res.message);
      }
    } catch (e: any) {
      message.error("同步失败: " + e.message);
    } finally {
      setSheetSyncing(false);
      setSyncProgress("");
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
            {sheetSyncing && syncProgress ? syncProgress : "统一同步"}
          </Button>
          <Tooltip title="从同一个 Google Sheets 链接同步黑名单（gid=0 的 A-F 列）和推荐商家（gid=0 的 G-M 列），按商家名称+域名跨平台匹配">
            <span style={{ fontSize: 12, color: "#999", cursor: "help" }}>ⓘ</span>
          </Tooltip>
          {lastSynced && <span style={{ fontSize: 12, color: "#999" }}>上次同步: {new Date(lastSynced).toLocaleString("zh-CN", { timeZone: "Asia/Shanghai" })}</span>}
        </div>
        {saEmail && (
          <Alert
            type="info" showIcon style={{ marginTop: 12 }}
            message={
              <span>
                已启用 Service Account 认证访问，支持需要邮箱授权的 Google Sheet。
                请将 Sheet 共享给：<strong style={{ userSelect: "all" }}>{saEmail}</strong>（查看者权限即可）
              </span>
            }
          />
        )}
        {!saEmail && (
          <Alert
            type="warning" showIcon style={{ marginTop: 12 }}
            message="未检测到 Service Account，仅支持公开的 Google Sheet。如需访问授权表格，请在 MCC 设置中配置 Service Account。"
          />
        )}
      </Card>

      {syncResult && (
        <Alert
          type={syncResult.violation?.error || syncResult.recommendation?.error ? "warning" : "success"}
          showIcon closable style={{ marginBottom: 16 }}
          message={
            (syncResult.violation?.error || syncResult.recommendation?.error)
              ? "部分同步完成（有错误）"
              : `统一同步完成 — 违规：共 ${syncResult.violation?.total ?? 0} 条，新增 ${syncResult.violation?.new ?? 0}，更新 ${syncResult.violation?.updated ?? syncResult.violation?.skipped ?? 0}，标记 ${syncResult.violation?.marked ?? 0} 个 | 推荐：共 ${syncResult.recommendation?.total ?? 0} 条，新增 ${syncResult.recommendation?.new ?? 0}，标记 ${syncResult.recommendation?.marked ?? 0} 个`
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
