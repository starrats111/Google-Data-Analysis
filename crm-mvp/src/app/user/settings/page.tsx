"use client";

import { useState, useEffect, useMemo } from "react";
import {
  Card, Tabs, Form, Input, Button, Select, Table, Space, Tag, Typography,
  Popconfirm, Modal, Switch, Upload, Row, Col, App, Tooltip,
} from "antd";
import {
  SettingOutlined, ApiOutlined, GoogleOutlined,
  PlusOutlined, DeleteOutlined, SaveOutlined, EditOutlined, BellOutlined,
  InboxOutlined, FileTextOutlined, CheckCircleOutlined, LockOutlined, CopyOutlined,
  CodeOutlined,
} from "@ant-design/icons";
import { generateLinkExchangeScript } from "@/lib/link-exchange-script-template";
import {
  PLATFORMS,
} from "@/lib/constants";

const { Title, Text } = Typography;

// ==================== 平台连接 Tab ====================
function PlatformConnectionsTab() {
  const { message } = App.useApp();
  const [connections, setConnections] = useState<Record<string, unknown>[]>([]);
  const [sites, setSites] = useState<{ id: string; site_name: string; domain: string }[]>([]);
  const [modalOpen, setModalOpen] = useState(false);
  const [editConn, setEditConn] = useState<Record<string, unknown> | null>(null);
  const [form] = Form.useForm();

  const fetchData = async () => {
    const [connRes, siteRes] = await Promise.all([
      fetch("/api/user/settings/platforms").then((r) => r.json()),
      fetch("/api/user/publish-sites").then((r) => r.json()),
    ]);
    if (connRes.code === 0) setConnections(connRes.data);
    if (siteRes.code === 0) setSites(siteRes.data || []);
  };

  useEffect(() => { fetchData(); }, []);

  const handleSave = async () => {
    const values = await form.validateFields();
    if (editConn && (!values.api_key || values.api_key === "")) {
      delete values.api_key;
    }
    if (editConn) values.id = editConn.id;
    const res = await fetch("/api/user/settings/platforms", {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(values),
    }).then((r) => r.json());
    if (res.code === 0) { message.success("保存成功"); setModalOpen(false); setEditConn(null); fetchData(); }
    else message.error(res.message);
  };

  const handleDelete = async (id: string) => {
    const res = await fetch("/api/user/settings/platforms", {
      method: "DELETE", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ id }),
    }).then((r) => r.json());
    if (res.code === 0) { message.success("删除成功"); fetchData(); } else message.error(res.message);
  };

  const getSiteName = (siteId: string | null | undefined) => {
    if (!siteId) return null;
    const site = sites.find((s) => String(s.id) === String(siteId));
    return site ? `${site.site_name} (${site.domain})` : null;
  };

  // 按平台分组展示
  const groupedByPlatform = useMemo(() => {
    const map: Record<string, Record<string, unknown>[]> = {};
    for (const p of PLATFORMS) map[p.code] = [];
    for (const c of connections) {
      const pCode = c.platform as string;
      if (!map[pCode]) map[pCode] = [];
      map[pCode].push(c);
    }
    return map;
  }, [connections]);

  return (
    <div>
      <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 16 }}>
        <Text>配置联盟平台 API 连接（支持同一平台多个账号）</Text>
        <Button icon={<PlusOutlined />} onClick={() => { setEditConn(null); form.resetFields(); setModalOpen(true); }}>添加连接</Button>
      </div>
      <Row gutter={[16, 16]}>
        {PLATFORMS.map((p) => {
          const conns = groupedByPlatform[p.code] || [];
          return (
            <Col xs={24} sm={12} md={8} key={p.code}>
              <Card
                size="small"
                title={<>{p.code} <Text type="secondary" style={{ fontSize: 12, fontWeight: 400 }}>{p.name}</Text></>}
                extra={
                  <Button size="small" type="link" icon={<PlusOutlined />} onClick={() => {
                    setEditConn(null);
                    form.resetFields();
                    form.setFieldsValue({ platform: p.code });
                    setModalOpen(true);
                  }}>添加</Button>
                }
              >
                {conns.length === 0 ? (
                  <Text type="secondary" style={{ fontSize: 12 }}>未配置连接</Text>
                ) : (
                  <Space orientation="vertical" size={8} style={{ width: "100%" }}>
                    {conns.map((conn) => {
                      const siteName = getSiteName(conn.publish_site_id as string);
                      const accName = (conn.account_name as string) || p.code;
                      return (
                        <div key={conn.id as string} style={{ padding: "6px 8px", background: "#fafafa", borderRadius: 4, border: "1px solid #f0f0f0" }}>
                          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                            <Space size={4}>
                              <Tag color="green" style={{ margin: 0 }}>{accName}</Tag>
                              <Text type="secondary" style={{ fontSize: 11 }}>
                                {(conn.api_key as string)?.slice(0, 6)}...
                              </Text>
                            </Space>
                            <Space size={0}>
                              <Button size="small" type="link" icon={<EditOutlined />} onClick={() => {
                                setEditConn(conn);
                                form.setFieldsValue({
                                  platform: conn.platform,
                                  account_name: conn.account_name,
                                  publish_site_id: conn.publish_site_id ? String(conn.publish_site_id) : undefined,
                                });
                                setModalOpen(true);
                              }} />
                              <Popconfirm title="确认断开此账号？" onConfirm={() => handleDelete(conn.id as string)}>
                                <Button size="small" danger type="link" icon={<DeleteOutlined />} />
                              </Popconfirm>
                            </Space>
                          </div>
                          {siteName && <Text type="secondary" style={{ fontSize: 11 }}>站点: {siteName}</Text>}
                        </div>
                      );
                    })}
                  </Space>
                )}
              </Card>
            </Col>
          );
        })}
      </Row>
      <Modal title={editConn ? "编辑平台连接" : "添加平台连接"} open={modalOpen} onOk={handleSave} onCancel={() => { setModalOpen(false); setEditConn(null); }}>
        <Form form={form} layout="vertical">
          <Form.Item name="platform" label="平台" rules={[{ required: true }]}>
            <Select disabled={!!editConn} options={PLATFORMS.map((p) => ({ value: p.code, label: `${p.code} — ${p.name}` }))} />
          </Form.Item>
          <Form.Item name="account_name" label="账号名称" tooltip="如 RW1、RW2，留空自动生成">
            <Input placeholder="如 RW1（留空自动生成）" />
          </Form.Item>
          <Form.Item name="api_key" label="API Key" rules={editConn ? [] : [{ required: true }]}>
            <Input.Password placeholder={editConn ? "已保存（留空则不修改）" : "请输入 API Key"} />
          </Form.Item>
          <Form.Item name="publish_site_id" label="绑定站点" tooltip="选择该账号对应的发布站点，领取商家后文章将自动发布到此站点">
            <Select
              allowClear
              placeholder="选择发布站点"
              options={sites.map((s) => ({ value: String(s.id), label: `${s.site_name} (${s.domain})` }))}
            />
          </Form.Item>
        </Form>
      </Modal>
    </div>
  );
}

// ==================== 生成 Google Ads MCC 脚本 ====================
function generateMccScript(sheetUrl: string, mccId?: string, mccName?: string): string {
  const ts = new Date().toLocaleString("zh-CN", { timeZone: "Asia/Shanghai" });
  return `// Google Ads MCC 脚本 - 自动导出到 Google Sheets
// MCC: ${mccName || "未命名"} (${mccId || "未设置"})
// 生成时间: ${ts}
//
// 功能：
//   1. 将除今天外的所有广告数据写入 DailyData 工作表
//   2. 将所有子账号 CID 列表写入 CID_List 工作表

function main() {
  var spreadsheet = SpreadsheetApp.openByUrl('${sheetUrl}');
  var sheet = spreadsheet.getSheetByName('DailyData') || spreadsheet.insertSheet('DailyData');
  sheet.clear();
  var headers = ['Date', 'Account', 'AccountName', 'CampaignId', 'CampaignName', 'Status', 'Budget', 'Impressions', 'Clicks', 'Cost', 'Conversions', 'ConversionValue', 'Currency'];
  sheet.getRange(1, 1, 1, headers.length).setValues([headers]);
  var allRows = [];
  var cidRows = [];
  var accountIterator = AdsManagerApp.accounts().get();
  while (accountIterator.hasNext()) {
    var account = accountIterator.next();
    cidRows.push([account.getCustomerId(), account.getName() || '']);
    AdsManagerApp.select(account);
    var tz = AdsApp.currentAccount().getTimeZone();
    var yesterday = new Date();
    yesterday.setDate(yesterday.getDate() - 1);
    var endDate = Utilities.formatDate(yesterday, tz, 'yyyy-MM-dd');
    var startDate = '2020-01-01';
    try {
      var report = AdsApp.report(
        "SELECT segments.date, customer.id, customer.descriptive_name, campaign.id, campaign.name, campaign.status, campaign_budget.amount_micros, metrics.impressions, metrics.clicks, metrics.cost_micros, metrics.conversions, metrics.conversions_value, customer.currency_code FROM campaign WHERE segments.date BETWEEN '" + startDate + "' AND '" + endDate + "'"
      );
      var rows = report.rows();
      while (rows.hasNext()) {
        var row = rows.next();
        allRows.push([row['segments.date'], row['customer.id'], row['customer.descriptive_name'], row['campaign.id'], row['campaign.name'], row['campaign.status'], row['campaign_budget.amount_micros'], row['metrics.impressions'], row['metrics.clicks'], row['metrics.cost_micros'], row['metrics.conversions'], row['metrics.conversions_value'], row['customer.currency_code']]);
      }
    } catch (e) { Logger.log('Account ' + account.getName() + ' error: ' + e.message); }
  }
  if (allRows.length > 0) {
    sheet.getRange(2, 1, allRows.length, headers.length).setValues(allRows);
  }
  Logger.log('DailyData: ' + allRows.length + ' rows');
  var cidSheet = spreadsheet.getSheetByName('CID_List') || spreadsheet.insertSheet('CID_List');
  cidSheet.clear();
  cidSheet.getRange(1, 1, 1, 2).setValues([['CustomerID', 'AccountName']]);
  cidRows.sort(function(a, b) { return a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0; });
  if (cidRows.length > 0) {
    cidSheet.getRange(2, 1, cidRows.length, 2).setValues(cidRows);
  }
  cidSheet.setFrozenRows(1);
  Logger.log('CID_List: ' + cidRows.length + ' accounts');
}
`;
}

// ==================== MCC 账户 Tab ====================
function MccAccountsTab() {
  const { message } = App.useApp();
  const [accounts, setAccounts] = useState<Record<string, unknown>[]>([]);
  const [modalOpen, setModalOpen] = useState(false);
  const [editItem, setEditItem] = useState<Record<string, unknown> | null>(null);
  const [form] = Form.useForm();
  const [jsonFileName, setJsonFileName] = useState<string>("");

  const fetchData = async () => {
    const res = await fetch("/api/user/settings/mcc").then((r) => r.json());
    if (res.code === 0) setAccounts(res.data);
  };

  useEffect(() => { fetchData(); }, []);

  const handleSubmit = async () => {
    const values = await form.validateFields();
    const method = editItem ? "PUT" : "POST";
    const body = editItem ? { id: editItem.id, ...values } : values;
    // 编辑模式下，如果 developer_token 为空字符串，说明用户没有修改，不传给后端
    if (method === "PUT" && body.developer_token === "") {
      delete body.developer_token;
    }
    const res = await fetch("/api/user/settings/mcc", {
      method, headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
    }).then((r) => r.json());
    if (res.code === 0) { message.success("保存成功"); setModalOpen(false); fetchData(); }
    else message.error(res.message);
  };

  const handleDelete = async (id: string) => {
    const res = await fetch("/api/user/settings/mcc", {
      method: "DELETE", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ id }),
    }).then((r) => r.json());
    if (res.code === 0) { message.success("删除成功"); fetchData(); } else message.error(res.message);
  };

  const columns = [
    { title: "MCC ID", dataIndex: "mcc_id" },
    { title: "名称", dataIndex: "mcc_name" },
    { title: "货币", dataIndex: "currency", render: (v: string) => <Tag color={v === "USD" ? "green" : "blue"}>{v}</Tag> },
    { title: "Sheet", dataIndex: "sheet_url", render: (v: string) => v ? <Tag color="blue">已配置</Tag> : <Tag>未配置</Tag> },
    { title: "状态", dataIndex: "is_active", render: (v: number) => <Tag color={v ? "green" : "default"}>{v ? "启用" : "禁用"}</Tag> },
    {
      title: "操作", render: (_: unknown, record: Record<string, unknown>) => (
        <Space>
          <Button size="small" icon={<EditOutlined />} onClick={() => {
            setEditItem(record);
            // 编辑时不回填 developer_token（密码字段），避免误清空
            const { developer_token: _dt, ...rest } = record;
            form.setFieldsValue(rest);
            setJsonFileName(record.service_account_json ? "已有凭证" : "");
            setModalOpen(true);
          }}>编辑</Button>
          <Popconfirm title="确认删除？" onConfirm={() => handleDelete(record.id as string)}>
            <Button size="small" danger icon={<DeleteOutlined />}>删除</Button>
          </Popconfirm>
        </Space>
      ),
    },
  ];

  return (
    <div>
      <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 16 }}>
        <Text>Google Ads MCC 账户管理</Text>
        <Button icon={<PlusOutlined />} onClick={() => { setEditItem(null); form.resetFields(); setJsonFileName(""); setModalOpen(true); }}>添加 MCC</Button>
      </div>
      <Table columns={columns} dataSource={accounts} rowKey="id" size="small" pagination={{ pageSize: 10, showTotal: (t) => `共 ${t} 条` }} />
      <Modal title={editItem ? "编辑 MCC" : "添加 MCC"} open={modalOpen} onOk={handleSubmit} onCancel={() => setModalOpen(false)}>
        <Form form={form} layout="vertical">
          <Form.Item name="mcc_id" label="MCC ID" rules={[{ required: true }]}>
            <Input placeholder="如 123-456-7890" disabled={!!editItem} />
          </Form.Item>
          <Form.Item name="mcc_name" label="MCC 名称">
            <Input />
          </Form.Item>
          <Form.Item name="currency" label="货币" initialValue="USD">
            <Select options={[{ value: "USD", label: "USD" }, { value: "CNY", label: "CNY" }]} />
          </Form.Item>
          <Form.Item name="service_account_json" label="服务账号凭证 JSON">
            {jsonFileName ? (
              <div style={{ display: "flex", alignItems: "center", gap: 8, padding: "8px 12px", background: "#f6ffed", border: "1px solid #b7eb8f", borderRadius: 6 }}>
                <CheckCircleOutlined style={{ color: "#52c41a" }} />
                <FileTextOutlined />
                <span style={{ flex: 1 }}>{jsonFileName}</span>
                <Button size="small" type="link" danger onClick={() => { setJsonFileName(""); form.setFieldValue("service_account_json", undefined); }}>移除</Button>
              </div>
            ) : (
              <Upload.Dragger
                accept=".json"
                showUploadList={false}
                beforeUpload={(file) => {
                  const reader = new FileReader();
                  reader.onload = (e) => {
                    try {
                      const text = e.target?.result as string;
                      JSON.parse(text); // 验证是合法 JSON
                      form.setFieldValue("service_account_json", text);
                      setJsonFileName(file.name);
                      message.success(`已读取 ${file.name}`);
                    } catch {
                      message.error("文件不是有效的 JSON 格式");
                    }
                  };
                  reader.readAsText(file);
                  return false; // 阻止自动上传
                }}
                style={{ padding: "12px 0" }}
              >
                <p style={{ marginBottom: 8 }}><InboxOutlined style={{ fontSize: 28, color: "#4DA6FF" }} /></p>
                <p style={{ fontSize: 13, color: "#666" }}>拖拽 JSON 文件到此处，或点击选择文件</p>
                <p style={{ fontSize: 12, color: "#999" }}>仅支持 .json 格式</p>
              </Upload.Dragger>
            )}
          </Form.Item>
          <Form.Item name="developer_token" label="Developer Token" tooltip="Google Ads API 开发者令牌">
            <Input.Password placeholder={editItem?.developer_token ? "已保存（留空则不修改）" : "Google Ads API Developer Token"} />
          </Form.Item>
          <Form.Item name="sheet_url" label="Google Sheet URL" tooltip="MCC 脚本导出的 Google Sheet 链接（用于同步历史数据）">
            <Input
              placeholder="https://docs.google.com/spreadsheets/d/..."
              addonAfter={
                <Tooltip title="根据 Sheet 链接生成 Google Ads MCC 脚本并复制到剪贴板">
                  <span
                    style={{ cursor: "pointer", display: "inline-flex", alignItems: "center", gap: 4 }}
                    onClick={() => {
                      const sheetUrl = form.getFieldValue("sheet_url");
                      if (!sheetUrl || !sheetUrl.includes("docs.google.com/spreadsheets")) {
                        message.warning("请先输入有效的 Google Sheet 共享链接");
                        return;
                      }
                      const mccId = form.getFieldValue("mcc_id") || editItem?.mcc_id;
                      const mccName = form.getFieldValue("mcc_name") || editItem?.mcc_name;
                      const script = generateMccScript(sheetUrl, mccId as string, mccName as string);
                      navigator.clipboard.writeText(script).then(() => {
                        message.success("脚本已复制到剪贴板，请粘贴到 Google Ads MCC 脚本中运行");
                      });
                    }}
                  >
                    <CopyOutlined /> 复制脚本
                  </span>
                </Tooltip>
              }
            />
          </Form.Item>
        </Form>
      </Modal>
    </div>
  );
}

// ==================== 通知偏好 Tab ====================
function NotificationPreferencesTab() {
  const { message } = App.useApp();
  const [form] = Form.useForm();
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    fetch("/api/user/notifications/preferences")
      .then((r) => r.json())
      .then((res) => {
        if (res.code === 0) {
          form.setFieldsValue({
            notify_system: res.data.notify_system === 1,
            notify_merchant: res.data.notify_merchant === 1,
            notify_article: res.data.notify_article === 1,
            notify_ad: res.data.notify_ad === 1,
            notify_alert: res.data.notify_alert === 1,
          });
        }
      });
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const handleSave = async () => {
    setLoading(true);
    const values = form.getFieldsValue();
    const res = await fetch("/api/user/notifications/preferences", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        notify_system: values.notify_system ? 1 : 0,
        notify_merchant: values.notify_merchant ? 1 : 0,
        notify_article: values.notify_article ? 1 : 0,
        notify_ad: values.notify_ad ? 1 : 0,
        notify_alert: values.notify_alert ? 1 : 0,
      }),
    }).then((r) => r.json());
    setLoading(false);
    if (res.code === 0) message.success("通知偏好已保存");
    else message.error(res.message);
  };

  const notifTypes = [
    { name: "notify_system", label: "系统通知", desc: "系统更新、维护公告等" },
    { name: "notify_merchant", label: "商家通知", desc: "商家状态变更、佣金变化等" },
    { name: "notify_article", label: "文章通知", desc: "文章发布状态、审核结果等" },
    { name: "notify_ad", label: "广告通知", desc: "广告投放状态、预算预警等" },
    { name: "notify_alert", label: "预警通知", desc: "ROI 异常、花费超标等" },
  ];

  return (
    <Card title="通知类型设置" size="small" extra={<Button type="primary" size="small" icon={<SaveOutlined />} loading={loading} onClick={handleSave}>保存</Button>}>
      <Text type="secondary" style={{ display: "block", marginBottom: 16 }}>选择你希望接收的通知类型</Text>
      <Form form={form} layout="vertical">
        {notifTypes.map((t) => (
          <div key={t.name} style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: "12px 0", borderBottom: "1px solid #F0F0F0" }}>
            <div>
              <div style={{ fontWeight: 500 }}>{t.label}</div>
              <Text type="secondary" style={{ fontSize: 13 }}>{t.desc}</Text>
            </div>
            <Form.Item name={t.name} valuePropName="checked" style={{ margin: 0 }}>
              <Switch />
            </Form.Item>
          </div>
        ))}
      </Form>
    </Card>
  );
}

// ==================== 修改密码 Tab ====================
function ChangePasswordTab() {
  const { message } = App.useApp();
  const [form] = Form.useForm();
  const [loading, setLoading] = useState(false);

  const handleSubmit = async () => {
    const values = await form.validateFields();
    if (values.new_password !== values.confirm_password) {
      message.error("两次输入的新密码不一致");
      return;
    }
    setLoading(true);
    try {
      const res = await fetch("/api/user/settings/password", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ old_password: values.old_password, new_password: values.new_password }),
      }).then((r) => r.json());
      if (res.code === 0) {
        message.success("密码修改成功");
        form.resetFields();
      } else {
        message.error(res.message);
      }
    } finally {
      setLoading(false);
    }
  };

  return (
    <Card title="修改登录密码" size="small" style={{ maxWidth: 480 }}>
      <Form form={form} layout="vertical" onFinish={handleSubmit}>
        <Form.Item name="old_password" label="旧密码" rules={[{ required: true, message: "请输入旧密码" }]}>
          <Input.Password placeholder="请输入当前密码" />
        </Form.Item>
        <Form.Item name="new_password" label="新密码" rules={[
          { required: true, message: "请输入新密码" },
          { min: 6, message: "密码长度至少 6 位" },
        ]}>
          <Input.Password placeholder="请输入新密码（至少6位）" />
        </Form.Item>
        <Form.Item name="confirm_password" label="确认新密码" rules={[
          { required: true, message: "请再次输入新密码" },
        ]}>
          <Input.Password placeholder="请再次输入新密码" />
        </Form.Item>
        <Form.Item>
          <Button type="primary" htmlType="submit" icon={<SaveOutlined />} loading={loading}>确认修改</Button>
        </Form.Item>
      </Form>
    </Card>
  );
}

// ==================== 脚本配置 Tab ====================
function ScriptConfigTab() {
  const { message } = App.useApp();
  const [apiKey, setApiKey] = useState<string | null>(null);
  const [generating, setGenerating] = useState(false);
  const [sheetUrl, setSheetUrl] = useState("");

  useEffect(() => {
    fetch("/api/user/settings/script-api-key")
      .then((r) => r.json())
      .then((res) => { if (res.code === 0) setApiKey(res.data.apiKey); });
  }, []);

  const handleGenerate = async () => {
    setGenerating(true);
    try {
      const res = await fetch("/api/user/settings/script-api-key", { method: "POST" }).then((r) => r.json());
      if (res.code === 0) {
        setApiKey(res.data.apiKey);
        message.success(res.data.isNew ? "API Key 已生成" : "API Key 已重置");
      } else {
        message.error(res.message ?? "生成失败");
      }
    } finally {
      setGenerating(false);
    }
  };

  const handleCopyScript = () => {
    if (!apiKey) return;
    if (!sheetUrl.trim()) {
      message.warning("请先填写 Google Sheet 链接");
      return;
    }
    const script = generateLinkExchangeScript(
      apiKey,
      window?.location?.origin ?? "https://google-data-analysis.top",
      sheetUrl.trim()
    );
    navigator.clipboard.writeText(script).then(() => message.success("脚本已复制，粘贴到 Google Ads Script 即可运行"));
  };

  return (
    <div style={{ maxWidth: 560 }}>
      <Card
        title={<><CodeOutlined /> 换链接脚本配置</>}
        size="small"
        extra={
          <Button type="primary" size="small" loading={generating} onClick={handleGenerate}>
            {apiKey ? "重置 Key" : "生成 Key"}
          </Button>
        }
      >
        {!apiKey ? (
          <Text type="secondary">尚未生成 API Key，点击右上角「生成 Key」按钮创建。</Text>
        ) : (
          <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
            <div>
              <Text type="secondary" style={{ display: "block", marginBottom: 6 }}>API Key</Text>
              <Input
                value={apiKey}
                readOnly
                style={{ fontFamily: "monospace" }}
              />
            </div>
            <div>
              <Text type="secondary" style={{ display: "block", marginBottom: 6 }}>Google Sheet 链接</Text>
              <Input
                placeholder="https://docs.google.com/spreadsheets/d/..."
                value={sheetUrl}
                onChange={(e) => setSheetUrl(e.target.value)}
                allowClear
              />
            </div>
            <Button
              type="primary"
              icon={<CopyOutlined />}
              onClick={handleCopyScript}
              block
            >
              复制脚本
            </Button>
          </div>
        )}
      </Card>
    </div>
  );
}

// ==================== 主页面 ====================
export default function SettingsPage() {
  const [activeTab, setActiveTab] = useState("platforms");

  return (
    <div>
      <Title level={4} style={{ marginBottom: 16 }}><SettingOutlined /> 个人设置</Title>
      <Tabs
        activeKey={activeTab}
        onChange={setActiveTab}
        destroyOnHidden
        items={[
          { key: "platforms", label: <><ApiOutlined /> 联盟平台连接</>, children: <PlatformConnectionsTab /> },
          { key: "mcc", label: <><GoogleOutlined /> Google Ads MCC</>, children: <MccAccountsTab /> },
          { key: "notifications", label: <><BellOutlined /> 通知设置</>, children: <NotificationPreferencesTab /> },
          { key: "password", label: <><LockOutlined /> 修改密码</>, children: <ChangePasswordTab /> },
          { key: "script", label: <><FileTextOutlined /> 脚本配置</>, children: <ScriptConfigTab /> },
        ]}
      />
    </div>
  );
}
