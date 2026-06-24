"use client";

import { useState, useEffect, useMemo } from "react";
import {
  Card, Tabs, Form, Input, Button, Select, Table, Space, Tag, Typography,
  Popconfirm, Modal, Switch, Upload, Row, Col, App, Tooltip, Alert,
} from "antd";
import {
  SettingOutlined, ApiOutlined, GoogleOutlined,
  PlusOutlined, DeleteOutlined, SaveOutlined, EditOutlined, BellOutlined,
  InboxOutlined, FileTextOutlined, CheckCircleOutlined, LockOutlined, CopyOutlined,
  EyeOutlined, ExclamationCircleOutlined, CheckOutlined, SyncOutlined,
  SearchOutlined, TeamOutlined,
} from "@ant-design/icons";
import {
  PLATFORMS,
} from "@/lib/constants";
import PublishSiteSelect, { type PublishSite } from "@/components/PublishSiteSelect";
import AppPageHeader from "@/components/AppPageHeader";

const { Text } = Typography;

// ==================== 平台连接 Tab ====================
// D-026: 增加测试连接 + 健康状态展示 + 保存前强制测试
type TestResult = { ok: boolean; msg?: string; error?: string; suggest?: string; sample_count?: number; elapsed_ms?: number };

function PlatformConnectionsTab() {
  const { message } = App.useApp();
  const [connections, setConnections] = useState<Record<string, unknown>[]>([]);
  const [sites, setSites] = useState<PublishSite[]>([]);
  const [modalOpen, setModalOpen] = useState(false);
  const [editConn, setEditConn] = useState<Record<string, unknown> | null>(null);
  const [form] = Form.useForm();
  // D-026 新增 state
  const [testingConnId, setTestingConnId] = useState<string | null>(null); // 卡片上点测试
  const [modalTesting, setModalTesting] = useState(false);                 // 弹窗里点测试
  const [modalTestResult, setModalTestResult] = useState<TestResult | null>(null); // 弹窗内测试结果
  const [modalTestPassed, setModalTestPassed] = useState(false);            // 当前表单值是否已测试通过

  const fetchData = async () => {
    const [connRes, siteRes] = await Promise.all([
      fetch("/api/user/settings/platforms").then((r) => r.json()),
      fetch("/api/user/publish-sites").then((r) => r.json()),
    ]);
    if (connRes.code === 0) setConnections(connRes.data);
    if (siteRes.code === 0) setSites(siteRes.data || []);
  };

  useEffect(() => { fetchData(); }, []);

  // D-026: 测试已有连接（卡片上的"测试连接"按钮）
  const handleTestConn = async (conn: Record<string, unknown>) => {
    const connId = String(conn.id);
    setTestingConnId(connId);
    try {
      const res = await fetch("/api/user/settings/platforms/test-connection", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ conn_id: connId }),
      }).then((r) => r.json());
      const data: TestResult = res.data || {};
      if (data.ok) {
        message.success(data.msg || "API 连接正常");
      } else {
        message.error({
          content: data.error || res.message || "测试失败",
          duration: 6,
        });
      }
      fetchData(); // 刷新状态字段
    } catch (e) {
      message.error("测试请求异常：" + (e instanceof Error ? e.message : String(e)));
    } finally {
      setTestingConnId(null);
    }
  };

  // D-026: 弹窗内"测试连接"按钮（用当前表单值，未保存）
  const handleModalTest = async () => {
    const values = await form.validateFields().catch(() => null);
    if (!values) return;
    const apiKey = values.api_key || (editConn?.api_key as string) || "";
    if (!apiKey || !apiKey.trim()) {
      message.warning("请先填写 API Key");
      return;
    }
    setModalTesting(true);
    setModalTestResult(null);
    try {
      const res = await fetch("/api/user/settings/platforms/test-connection", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          platform: values.platform || editConn?.platform,
          api_key: apiKey,
          conn_id: editConn ? String(editConn.id) : undefined,
        }),
      }).then((r) => r.json());
      const data: TestResult = res.data || {};
      setModalTestResult(data);
      setModalTestPassed(!!data.ok);
      if (data.ok) message.success(data.msg || "测试通过");
    } catch (e) {
      const errMsg = e instanceof Error ? e.message : String(e);
      setModalTestResult({ ok: false, error: errMsg });
      setModalTestPassed(false);
    } finally {
      setModalTesting(false);
    }
  };

  const handleSave = async () => {
    const values = await form.validateFields();
    const isEditingWithUnchangedKey = !!editConn && (!values.api_key || values.api_key === "");
    // D-026: 强制测试通过才能保存（编辑模式且未改 key 时跳过此校验，因为不是新 key）
    if (!isEditingWithUnchangedKey && !modalTestPassed) {
      message.warning("请先点击「测试连接」验证 API Key 通过后再保存");
      return;
    }
    if (isEditingWithUnchangedKey) {
      delete values.api_key;
    }
    if (editConn) values.id = editConn.id;
    const res = await fetch("/api/user/settings/platforms", {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(values),
    }).then((r) => r.json());
    if (res.code === 0) {
      message.success("保存成功");
      setModalOpen(false);
      setEditConn(null);
      setModalTestResult(null);
      setModalTestPassed(false);
      fetchData();
    } else {
      message.error(res.message);
    }
  };

  const openEditModal = (conn: Record<string, unknown>) => {
    setEditConn(conn);
    setModalTestResult(null);
    // 编辑模式：API Key 未改时算作"已通过"（无需重测既有连接才能保存其它字段）
    setModalTestPassed(true);
    form.setFieldsValue({
      platform: conn.platform,
      account_name: conn.account_name,
      payee: (conn.payee as string) || undefined,
      publish_site_id: conn.publish_site_id ? String(conn.publish_site_id) : undefined,
    });
    setModalOpen(true);
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

  // D-033: 三次重试策略 — 健康等级计算
  const computeHealthLevel = (conn: Record<string, unknown>): "ok" | "warn" | "error" => {
    const status = String(conn.status || "");
    const consecutiveFailures = Number(conn.consecutive_failures || 0);
    // >= 3 次连续失败 或 status='error' → 红
    if (status === "error" || consecutiveFailures >= 3) return "error";
    // 1-2 次失败（正在重试中）或 unverified 或 从未同步 → 黄
    if (status === "unverified" || consecutiveFailures >= 1) return "warn";
    const lastSyncedAt = conn.last_synced_at;
    if (!lastSyncedAt) return "warn";
    const ageHours = (Date.now() - new Date(String(lastSyncedAt)).getTime()) / 3600000;
    if (ageHours > 24) return "warn";
    return "ok";
  };

  return (
    <div>
      <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 16 }}>
        <Text>配置联盟平台 API 连接（支持同一平台多个账号）</Text>
        <Button icon={<PlusOutlined />} onClick={() => {
          setEditConn(null);
          form.resetFields();
          setModalTestResult(null);
          setModalTestPassed(false);
          setModalOpen(true);
        }}>添加连接</Button>
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
                    setModalTestResult(null);
                    setModalTestPassed(false);
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
                      // D-026: 三态健康展示
                      const health = computeHealthLevel(conn);
                      const consecutiveFailures = Number(conn.consecutive_failures || 0);
                      const tagColor = health === "ok" ? "green" : health === "warn" ? "gold" : "red";
                      // D-033: 区分三种状态文字
                      const tagText = health === "ok"
                        ? accName
                        : health === "error"
                          ? `${accName} (异常)`
                          : consecutiveFailures >= 1
                            ? `${accName} (验证中 ${consecutiveFailures}/3)`
                            : `${accName} (待验证)`;
                      const lastError = (conn.last_error as string) || "";
                      const lastSync = conn.last_synced_at ? new Date(String(conn.last_synced_at)).toLocaleString("zh-CN") : "从未";
                      const lastAttempt = conn.last_sync_attempt_at ? new Date(String(conn.last_sync_attempt_at)).toLocaleString("zh-CN") : "—";
                      const isTesting = testingConnId === String(conn.id);
                      return (
                        <div key={conn.id as string} style={{
                          padding: "6px 8px",
                          background: health === "error" ? "#fff1f0" : "#fafafa",
                          borderRadius: 4,
                          border: health === "error" ? "1px solid #ffa39e" : "1px solid #f0f0f0",
                        }}>
                          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                            <Space size={4}>
                              <Tag color={tagColor} style={{ margin: 0 }} icon={
                                health === "ok" ? <CheckCircleOutlined /> :
                                health === "error" ? <ExclamationCircleOutlined /> : undefined
                              }>{tagText}</Tag>
                              <Text type="secondary" style={{ fontSize: 11 }}>
                                {(conn.api_key as string)?.slice(0, 6)}...
                              </Text>
                            </Space>
                            <Space size={0}>
                              <Tooltip title="测试 API 连接">
                                <Button size="small" type="link" icon={isTesting ? <SyncOutlined spin /> : <CheckOutlined />} loading={isTesting} onClick={() => handleTestConn(conn)} />
                              </Tooltip>
                              <Tooltip title={health === "error" ? "重新配置" : "编辑"}>
                                <Button size="small" type="link" icon={<EditOutlined />} onClick={() => openEditModal(conn)} />
                              </Tooltip>
                              <Popconfirm title="确认断开此账号？" onConfirm={() => handleDelete(conn.id as string)}>
                                <Button size="small" danger type="link" icon={<DeleteOutlined />} />
                              </Popconfirm>
                            </Space>
                          </div>
                          {siteName && <Text type="secondary" style={{ fontSize: 11, display: "block" }}>站点: {siteName}</Text>}
                          {/* D-026: 连接异常 Alert + 引导重新配置 */}
                          {health === "error" && lastError && (
                            <Alert
                              type="error"
                              showIcon
                              style={{ marginTop: 6, padding: "4px 8px" }}
                              message={<Text style={{ fontSize: 11 }}>该连接 API Key 已失效</Text>}
                              description={
                                <div style={{ fontSize: 11 }}>
                                  <div><Text type="danger" style={{ fontSize: 11 }}>错误：{lastError}</Text></div>
                                  <div>上次成功同步：{lastSync}</div>
                                  <Button danger size="small" style={{ marginTop: 4 }} onClick={() => openEditModal(conn)}>
                                    重新配置 API Key
                                  </Button>
                                </div>
                              }
                            />
                          )}
                          {/* D-026: 健康状态信息条（小字灰色） */}
                          {health !== "error" && (
                            <Text type="secondary" style={{ fontSize: 10, display: "block", marginTop: 2 }}>
                              上次同步: {lastSync}{lastAttempt !== lastSync && ` | 尝试: ${lastAttempt}`}
                            </Text>
                          )}
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
      <Modal
        title={editConn ? "编辑平台连接" : "添加平台连接"}
        open={modalOpen}
        onCancel={() => {
          setModalOpen(false);
          setEditConn(null);
          setModalTestResult(null);
          setModalTestPassed(false);
        }}
        width={560}
        footer={[
          <Button key="cancel" onClick={() => {
            setModalOpen(false);
            setEditConn(null);
            setModalTestResult(null);
            setModalTestPassed(false);
          }}>取消</Button>,
          <Button key="test" type="default" icon={<CheckOutlined />} loading={modalTesting} onClick={handleModalTest}>
            测试连接
          </Button>,
          <Tooltip key="save" title={!modalTestPassed && !editConn ? "请先测试连接通过" : ""}>
            <Button
              type="primary"
              onClick={handleSave}
              disabled={!modalTestPassed && !editConn}
            >
              保存
            </Button>
          </Tooltip>,
        ]}
      >
        <Form form={form} layout="vertical" onValuesChange={(changed) => {
          // D-026: 用户改了 api_key / channel_id / platform → 上次测试失效，必须重测
          if ("api_key" in changed || "channel_id" in changed || "platform" in changed) {
            setModalTestPassed(false);
            setModalTestResult(null);
          }
        }}>
          <Form.Item name="platform" label="平台" rules={[{ required: true }]}>
            <Select disabled={!!editConn} options={PLATFORMS.map((p) => ({ value: p.code, label: `${p.code} — ${p.name}` }))} />
          </Form.Item>
          <Form.Item name="account_name" label="账号名称" tooltip="如 RW1、RW2，留空自动生成">
            <Input placeholder="如 RW1（留空自动生成）" />
          </Form.Item>
          <Form.Item name="api_key" label="API Key" rules={editConn ? [] : [{ required: true }]}>
            <Input.Password placeholder={editConn ? "已保存（留空则不修改）" : "请输入 API Key"} />
          </Form.Item>
          <Form.Item name="payee" label="收款人" tooltip="该平台账号打款时实际收款的人，用于结算页「支付查询」按收款人汇总">
            <Input placeholder="如 张文俊 / 龚建成" allowClear />
          </Form.Item>
          <Form.Item name="publish_site_id" label="绑定站点" tooltip="选择该账号对应的发布站点，领取商家后文章将自动发布到此站点">
            <PublishSiteSelect sites={sites} placeholder="选择发布站点（可搜索站点名或域名）" />
          </Form.Item>

          {/* D-026: 测试结果展示 */}
          {modalTestResult && (
            <Alert
              type={modalTestResult.ok ? "success" : "error"}
              showIcon
              message={modalTestResult.ok ? "API 连接测试通过" : "API 连接测试失败"}
              description={
                modalTestResult.ok
                  ? <span>{modalTestResult.msg}（耗时 {modalTestResult.elapsed_ms}ms）</span>
                  : <div>
                      <div>错误：{modalTestResult.error}</div>
                      {modalTestResult.suggest && <div style={{ marginTop: 4 }}>建议：{modalTestResult.suggest}</div>}
                    </div>
              }
            />
          )}
          {!editConn && !modalTestPassed && (
            <Text type="secondary" style={{ fontSize: 12, display: "block", marginTop: 8 }}>
              提示：保存前必须先点击「测试连接」验证 API Key 有效
            </Text>
          )}
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
//   1. 将近 90 天（含今日）的广告数据写入 DailyData 工作表
//   2. 将所有子账号 CID 列表写入 CID_List 工作表
//   3. 将所有广告系列（含 CST 创建日期）写入 CampaignInfo 工作表，供「今日投放商家」统计使用
// 注意：先采集全部数据再清空写入，避免清空后写入失败导致表格丢失数据

function main() {
  var spreadsheet = SpreadsheetApp.openByUrl('${sheetUrl}');
  var headers = ['Date', 'Account', 'AccountName', 'CampaignId', 'CampaignName', 'Status', 'Budget', 'Impressions', 'Clicks', 'Cost', 'Conversions', 'ConversionValue', 'Currency'];
  var allRows = [];
  var cidRows = [];
  var campaignInfoRows = [];

  // 第一步：采集所有账号数据（先采集，后写入，避免清空后失败）
  var accountIterator = AdsManagerApp.accounts().get();
  while (accountIterator.hasNext()) {
    var account = accountIterator.next();
    cidRows.push([account.getCustomerId(), account.getName() || '']);
    AdsManagerApp.select(account);
    var tz = AdsApp.currentAccount().getTimeZone();
    var today = new Date();
    var startD = new Date();
    startD.setDate(startD.getDate() - 90);
    var endDate = Utilities.formatDate(today, tz, 'yyyy-MM-dd');
    var startDate = Utilities.formatDate(startD, tz, 'yyyy-MM-dd');
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

    // 采集广告系列信息（用于「今日投放商家」，start_date_time 在账户时区）
    try {
      // v23+ 已移除 campaign.creation_time / campaign.start_date，统一用
      // campaign.start_date_time（账户时区 "yyyy-MM-dd HH:mm:ss"），再转成北京时间日期。
      var infoReport = AdsApp.report(
        "SELECT campaign.id, campaign.name, campaign.status, campaign.start_date_time FROM campaign WHERE campaign.status != 'REMOVED'"
      );
      var infoRows = infoReport.rows();
      while (infoRows.hasNext()) {
        var infoRow = infoRows.next();
        var startDt = infoRow['campaign.start_date_time'] || '';
        var creationDateCST = '';
        if (startDt) {
          try {
            var parsedDt = Utilities.parseDate(startDt, tz, 'yyyy-MM-dd HH:mm:ss');
            creationDateCST = Utilities.formatDate(parsedDt, 'Asia/Shanghai', 'yyyy-MM-dd');
          } catch (pe) {
            creationDateCST = startDt.slice(0, 10);
          }
        }
        campaignInfoRows.push([infoRow['campaign.id'], infoRow['campaign.name'], infoRow['campaign.status'], creationDateCST, account.getCustomerId()]);
      }
    } catch (e) { Logger.log('CampaignInfo error for ' + account.getName() + ': ' + e.message); }
  }

  // 第二步：数据采集完成后再清空并写入（原子操作，避免清空后写入失败）
  var sheet = spreadsheet.getSheetByName('DailyData') || spreadsheet.insertSheet('DailyData');
  sheet.clearContents();
  sheet.getRange(1, 1, 1, headers.length).setValues([headers]);
  if (allRows.length > 0) {
    sheet.getRange(2, 1, allRows.length, headers.length).setValues(allRows);
  }
  sheet.setFrozenRows(1);
  Logger.log('DailyData: ' + allRows.length + ' rows');

  var cidSheet = spreadsheet.getSheetByName('CID_List') || spreadsheet.insertSheet('CID_List');
  cidSheet.clearContents();
  cidSheet.getRange(1, 1, 1, 2).setValues([['CustomerID', 'AccountName']]);
  cidRows.sort(function(a, b) { return a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0; });
  if (cidRows.length > 0) {
    cidSheet.getRange(2, 1, cidRows.length, 2).setValues(cidRows);
  }
  cidSheet.setFrozenRows(1);
  Logger.log('CID_List: ' + cidRows.length + ' accounts');

  // 写入 CampaignInfo tab（今日投放商家统计数据源）
  var infoSheet = spreadsheet.getSheetByName('CampaignInfo') || spreadsheet.insertSheet('CampaignInfo');
  var infoHeaders = ['CampaignId', 'CampaignName', 'Status', 'CreationDateCST', 'CustomerId'];
  infoSheet.clearContents();
  infoSheet.getRange(1, 1, 1, infoHeaders.length).setValues([infoHeaders]);
  if (campaignInfoRows.length > 0) {
    infoSheet.getRange(2, 1, campaignInfoRows.length, infoHeaders.length).setValues(campaignInfoRows);
  }
  infoSheet.setFrozenRows(1);
  Logger.log('CampaignInfo: ' + campaignInfoRows.length + ' campaigns');
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
      <Table columns={columns} dataSource={accounts} rowKey="id" size="small" pagination={{ defaultPageSize: 10, showTotal: (t) => `共 ${t} 条`, showSizeChanger: true, pageSizeOptions: ["10", "20", "50", "100"] }} />
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

// ==================== 脚本配置 Tab（kylink 关联） ====================
interface KylinkStatus {
  hasKey: boolean;
  keyMasked: string | null;
  linked: boolean;
  linkedAt: string | null;
  kylinkUsername: string | null;
}

function ScriptConfigTab() {
  const { message } = App.useApp();
  const [status, setStatus] = useState<KylinkStatus | null>(null);
  const [apiKey, setApiKey] = useState("");
  const [testing, setTesting] = useState(false);
  const [unlinking, setUnlinking] = useState(false);

  const loadStatus = async () => {
    const res = await fetch("/api/user/settings/kylink").then((r) => r.json());
    if (res.code === 0) setStatus(res.data);
  };

  useEffect(() => { loadStatus(); }, []);

  const handleTest = async () => {
    if (!apiKey.trim()) {
      message.warning("请先填写 kylink API Key");
      return;
    }
    setTesting(true);
    try {
      const res = await fetch("/api/user/settings/kylink/test", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ apiKey: apiKey.trim() }),
      }).then((r) => r.json());
      if (res.code === 0) {
        message.success("连接成功，已关联至 kylink");
        setApiKey("");
        await loadStatus();
      } else {
        message.error(res.message ?? "连接失败");
      }
    } catch {
      message.error("连接失败，请稍后重试");
    } finally {
      setTesting(false);
    }
  };

  const handleUnlink = async () => {
    setUnlinking(true);
    try {
      const res = await fetch("/api/user/settings/kylink", { method: "DELETE" }).then((r) => r.json());
      if (res.code === 0) {
        message.success("已解除 kylink 关联");
        await loadStatus();
      } else {
        message.error(res.message ?? "解除失败");
      }
    } finally {
      setUnlinking(false);
    }
  };

  return (
    <div style={{ maxWidth: 560 }}>
      <Card title={<><ApiOutlined /> kylink 换链接关联</>} size="small">
        <Alert
          type="info"
          showIcon
          style={{ marginBottom: 16 }}
          message="填入 kylink 个人 API Key 并测试连接"
          description="连接成功后，系统每小时会自动把你商家库里的联盟链接，喂给 kylink 中「未配置」的广告系列；kylink 没有匹配到配置的广告系列保持原样，仍可手动填写。"
        />

        {status?.linked && (
          <Alert
            type="success"
            showIcon
            icon={<CheckCircleOutlined />}
            style={{ marginBottom: 16 }}
            message="已关联至 kylink"
            description={
              <Space direction="vertical" size={2}>
                <Text type="secondary">kylink 账号：{status.kylinkUsername || "（重新测试连接后显示）"}</Text>
                <Text type="secondary">API Key：{status.keyMasked}</Text>
                <Text type="secondary">
                  最近连接：{status.linkedAt ? new Date(status.linkedAt).toLocaleString("zh-CN") : "-"}
                </Text>
              </Space>
            }
            action={
              <Popconfirm title="确定解除与 kylink 的关联？" onConfirm={handleUnlink}>
                <Button size="small" danger loading={unlinking}>解除关联</Button>
              </Popconfirm>
            }
          />
        )}

        <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
          <div>
            <Text type="secondary" style={{ display: "block", marginBottom: 6 }}>
              kylink API Key
            </Text>
            <Input.Password
              placeholder={status?.linked ? "如需更换，请输入新的 API Key" : "ky_live_xxxxxxxx"}
              value={apiKey}
              onChange={(e) => setApiKey(e.target.value)}
              autoComplete="off"
              style={{ fontFamily: "monospace" }}
            />
            <Text type="secondary" style={{ fontSize: 12 }}>
              在 kylink「设置」页生成；格式为 ky_live_ 开头的 40 位字符。
            </Text>
          </div>
          <Button type="primary" loading={testing} onClick={handleTest} block>
            {status?.linked ? "重新测试并保存" : "测试连接并保存"}
          </Button>
        </div>
      </Card>
    </div>
  );
}

// ==================== 广告情报 Tab ====================
interface SerpApiKeyRow {
  id: string;
  key_name: string;
  masked_key: string;
  is_active: boolean;
  created_at: string;
}

function SerpApiTab() {
  const { message } = App.useApp();
  const [keys, setKeys] = useState<SerpApiKeyRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [addVisible, setAddVisible] = useState(false);
  const [newKey, setNewKey] = useState("");
  const [newKeyName, setNewKeyName] = useState("");
  const [saving, setSaving] = useState(false);
  const [testingId, setTestingId] = useState<string | null>(null);
  const [testKeyInput, setTestKeyInput] = useState("");
  const [testingNew, setTestingNew] = useState(false);

  const fetchKeys = async () => {
    setLoading(true);
    const res = await fetch("/api/user/settings/serpapi").then((r) => r.json());
    if (res.code === 0) setKeys(res.data);
    setLoading(false);
  };

  useEffect(() => { fetchKeys(); }, []);

  const handleAdd = async () => {
    const key = newKey.trim();
    if (!key) { message.warning("请输入 API Key"); return; }
    setSaving(true);
    const res = await fetch("/api/user/settings/serpapi", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ api_key: key, key_name: newKeyName.trim() || undefined }),
    }).then((r) => r.json());
    setSaving(false);
    if (res.code === 0) {
      message.success("添加成功");
      setNewKey(""); setNewKeyName(""); setAddVisible(false); fetchKeys();
    } else message.error(res.message);
  };

  const handleDelete = async (id: string) => {
    const res = await fetch("/api/user/settings/serpapi", {
      method: "DELETE",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id }),
    }).then((r) => r.json());
    if (res.code === 0) { message.success("已删除"); fetchKeys(); }
    else message.error(res.message);
  };

  const handleToggle = async (id: string, is_active: boolean) => {
    const res = await fetch("/api/user/settings/serpapi", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id, is_active: !is_active }),
    }).then((r) => r.json());
    if (res.code === 0) { message.success(is_active ? "已禁用" : "已启用"); fetchKeys(); }
    else message.error(res.message);
  };

  const handleTestExisting = async (id: string) => {
    setTestingId(id);
    const res = await fetch("/api/user/settings/serpapi", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id }),
    }).then((r) => r.json());
    setTestingId(null);
    if (res.code === 0) message.success(res.message);
    else message.error(res.message);
  };

  const handleTestNew = async () => {
    const key = testKeyInput.trim() || newKey.trim();
    if (!key) { message.warning("请先输入 Key"); return; }
    setTestingNew(true);
    const res = await fetch("/api/user/settings/serpapi", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ api_key: key }),
    }).then((r) => r.json());
    setTestingNew(false);
    if (res.code === 0) message.success(res.message);
    else message.error(res.message);
  };

  const totalQuota = keys.filter((k) => k.is_active).length * 250;

  const columns = [
    { title: "备注名", dataIndex: "key_name", width: 120, render: (v: string) => <Text strong>{v}</Text> },
    { title: "Key（脱敏）", dataIndex: "masked_key", render: (v: string) => <Text code style={{ fontSize: 12 }}>{v}</Text> },
    {
      title: "状态", dataIndex: "is_active", width: 80,
      render: (v: boolean) => v ? <Tag color="green">启用</Tag> : <Tag color="default">禁用</Tag>,
    },
    {
      title: "操作", width: 200,
      render: (_: unknown, rec: SerpApiKeyRow) => (
        <Space size={4}>
          <Button
            size="small"
            loading={testingId === rec.id}
            onClick={() => handleTestExisting(rec.id)}
          >
            测试
          </Button>
          <Button
            size="small"
            onClick={() => handleToggle(rec.id, rec.is_active)}
          >
            {rec.is_active ? "禁用" : "启用"}
          </Button>
          <Popconfirm title="确认删除此 Key？" onConfirm={() => handleDelete(rec.id)}>
            <Button size="small" danger>删除</Button>
          </Popconfirm>
        </Space>
      ),
    },
  ];

  return (
    <div style={{ maxWidth: 680 }}>
      <Card
        title={<><EyeOutlined /> 广告情报 — SerpApi Key 管理</>}
        size="small"
        extra={
          <Button type="primary" size="small" icon={<PlusOutlined />} onClick={() => setAddVisible(true)}>
            添加 Key
          </Button>
        }
        loading={loading}
      >
        <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
          {keys.length > 0 && (
            <div style={{ background: "#f0f7ff", borderRadius: 6, padding: "8px 14px", fontSize: 12, color: "#1677ff" }}>
              已配置 <strong>{keys.length}</strong> 个 Key，启用 <strong>{keys.filter(k => k.is_active).length}</strong> 个 ·
              合计免费额度 <strong>{totalQuota}</strong> 次/月
            </div>
          )}

          {keys.length === 0 ? (
            <div style={{ textAlign: "center", padding: "24px 0", color: "#bfbfbf" }}>
              <EyeOutlined style={{ fontSize: 32, marginBottom: 8 }} />
              <div>尚未配置 SerpApi Key，点击右上角「添加 Key」开始使用</div>
            </div>
          ) : (
            <Table
              dataSource={keys}
              columns={columns}
              rowKey="id"
              size="small"
              pagination={false}
            />
          )}

          {addVisible && (
            <Card size="small" style={{ background: "#fafafa" }} title="添加新 Key">
              <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
                <div>
                  <Text type="secondary" style={{ display: "block", marginBottom: 4 }}>备注名（选填）</Text>
                  <Input
                    placeholder={`Key ${keys.length + 1}`}
                    value={newKeyName}
                    onChange={(e) => setNewKeyName(e.target.value)}
                    style={{ maxWidth: 200 }}
                  />
                </div>
                <div>
                  <Text type="secondary" style={{ display: "block", marginBottom: 4 }}>SerpApi API Key</Text>
                  <Space.Compact style={{ width: "100%" }}>
                    <Input.Password
                      placeholder="粘贴 SerpApi API Key"
                      value={newKey}
                      onChange={(e) => { setNewKey(e.target.value); setTestKeyInput(e.target.value); }}
                      style={{ flex: 1 }}
                    />
                    <Button loading={testingNew} onClick={handleTestNew}>测试</Button>
                    <Button type="primary" loading={saving} icon={<SaveOutlined />} onClick={handleAdd}>添加</Button>
                    <Button onClick={() => { setAddVisible(false); setNewKey(""); setNewKeyName(""); }}>取消</Button>
                  </Space.Compact>
                </div>
              </div>
            </Card>
          )}

          <div style={{ background: "#f6f8fa", borderRadius: 6, padding: "10px 14px", fontSize: 12, color: "#666", lineHeight: "1.8" }}>
            <div><strong>免费额度</strong>：每人每账号 250 次/月，多 Key 额度叠加</div>
            <div><strong>获取地址</strong>：<a href="https://serpapi.com/manage-api-key" target="_blank" rel="noreferrer">serpapi.com → Dashboard → API Key</a></div>
            <div><strong>选取策略</strong>：每次查询随机从启用的 Key 中选取，均匀分摊用量</div>
            <div><strong>团队缓存</strong>：同一商家域名 24h 内只消耗 1 次额度</div>
          </div>
        </div>
      </Card>
    </div>
  );
}

// ==================== SemRush 关键词 Tab（方案-09：员工自配 3UE 账号）====================
interface SemrushKeyRow {
  id: string;
  key_name: string;
  username: string;
  user_id_3ue: string;
  masked_api_key: string;
  node: string;
  database: string;
  is_active: boolean;
  created_at: string;
}

function SemRushTab() {
  const { message } = App.useApp();
  const [keys, setKeys] = useState<SemrushKeyRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [addVisible, setAddVisible] = useState(false);
  const [saving, setSaving] = useState(false);
  const [testingId, setTestingId] = useState<string | null>(null);
  const [testingNew, setTestingNew] = useState(false);
  // SEM-01：员工只填【用户名+密码】，UserID/ApiKey/节点/默认库 跟管理台全局。
  const [form, setForm] = useState({ key_name: "", username: "", password: "" });

  const setField = (k: keyof typeof form, v: string) => setForm((p) => ({ ...p, [k]: v }));
  const resetForm = () => setForm({ key_name: "", username: "", password: "" });

  const fetchKeys = async () => {
    setLoading(true);
    const res = await fetch("/api/user/settings/semrush").then((r) => r.json());
    if (res.code === 0) setKeys(res.data);
    setLoading(false);
  };

  useEffect(() => { fetchKeys(); }, []);

  const handleAdd = async () => {
    if (!form.username.trim() || !form.password.trim()) {
      message.warning("用户名/密码必填"); return;
    }
    setSaving(true);
    const res = await fetch("/api/user/settings/semrush", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(form),
    }).then((r) => r.json());
    setSaving(false);
    if (res.code === 0) { message.success("添加成功"); resetForm(); setAddVisible(false); fetchKeys(); }
    else message.error(res.message);
  };

  const handleDelete = async (id: string) => {
    const res = await fetch("/api/user/settings/semrush", {
      method: "DELETE", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ id }),
    }).then((r) => r.json());
    if (res.code === 0) { message.success("已删除"); fetchKeys(); } else message.error(res.message);
  };

  const handleToggle = async (id: string, is_active: boolean) => {
    const res = await fetch("/api/user/settings/semrush", {
      method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ id, is_active: !is_active }),
    }).then((r) => r.json());
    if (res.code === 0) { message.success(is_active ? "已禁用" : "已启用"); fetchKeys(); } else message.error(res.message);
  };

  const handleTestExisting = async (id: string) => {
    setTestingId(id);
    const res = await fetch("/api/user/settings/semrush", {
      method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ id }),
    }).then((r) => r.json());
    setTestingId(null);
    if (res.code === 0) message.success(res.message); else message.error(res.message);
  };

  const handleTestNew = async () => {
    if (!form.username.trim() || !form.password.trim()) {
      message.warning("请先填用户名和密码再测试"); return;
    }
    setTestingNew(true);
    const res = await fetch("/api/user/settings/semrush", {
      method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(form),
    }).then((r) => r.json());
    setTestingNew(false);
    if (res.code === 0) message.success(res.message); else message.error(res.message);
  };

  const columns = [
    { title: "备注名", dataIndex: "key_name", width: 120, render: (v: string) => <Text strong>{v}</Text> },
    { title: "用户名", dataIndex: "username", render: (v: string) => <Text code style={{ fontSize: 12 }}>{v}</Text> },
    { title: "节点/库", width: 120, render: () => <Text type="secondary" style={{ fontSize: 12 }}>跟随全局</Text> },
    { title: "状态", dataIndex: "is_active", width: 70, render: (v: boolean) => v ? <Tag color="green">启用</Tag> : <Tag color="default">禁用</Tag> },
    {
      title: "操作", width: 190,
      render: (_: unknown, rec: SemrushKeyRow) => (
        <Space size={4}>
          <Button size="small" loading={testingId === rec.id} onClick={() => handleTestExisting(rec.id)}>测试</Button>
          <Button size="small" onClick={() => handleToggle(rec.id, rec.is_active)}>{rec.is_active ? "禁用" : "启用"}</Button>
          <Popconfirm title="确认删除此账号？" onConfirm={() => handleDelete(rec.id)}>
            <Button size="small" danger>删除</Button>
          </Popconfirm>
        </Space>
      ),
    },
  ];

  return (
    <div style={{ maxWidth: 760 }}>
      <Card
        title={<><SearchOutlined /> SemRush 关键词 — 3UE 账号管理</>}
        size="small"
        extra={<Button type="primary" size="small" icon={<PlusOutlined />} onClick={() => setAddVisible(true)}>添加账号</Button>}
        loading={loading}
      >
        <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
          {keys.length === 0 ? (
            <div style={{ textAlign: "center", padding: "24px 0", color: "#bfbfbf" }}>
              <SearchOutlined style={{ fontSize: 32, marginBottom: 8 }} />
              <div>尚未配置 SemRush 账号，点击右上角「添加账号」开始使用</div>
              <div style={{ fontSize: 12, marginTop: 6 }}>未配置时系统暂用全局兜底账号（过渡期）</div>
            </div>
          ) : (
            <Table dataSource={keys} columns={columns} rowKey="id" size="small" pagination={false} />
          )}

          {addVisible && (
            <Card size="small" style={{ background: "#fafafa" }} title="添加新 SemRush(3UE) 账号">
              <Row gutter={[10, 10]}>
                <Col span={8}>
                  <Text type="secondary" style={{ display: "block", marginBottom: 4 }}>备注名（选填）</Text>
                  <Input placeholder={`账号 ${keys.length + 1}`} value={form.key_name} onChange={(e) => setField("key_name", e.target.value)} />
                </Col>
                <Col span={8}>
                  <Text type="secondary" style={{ display: "block", marginBottom: 4 }}>用户名 *</Text>
                  <Input placeholder="3UE 登录用户名" value={form.username} onChange={(e) => setField("username", e.target.value)} />
                </Col>
                <Col span={8}>
                  <Text type="secondary" style={{ display: "block", marginBottom: 4 }}>密码 *</Text>
                  <Input.Password placeholder="3UE 登录密码" value={form.password} onChange={(e) => setField("password", e.target.value)} />
                </Col>
                <Col span={24}>
                  <Text type="secondary" style={{ fontSize: 12 }}>
                    UserID / ApiKey / 节点 / 默认库 均自动跟随管理台全局配置，无需填写。
                  </Text>
                </Col>
                <Col span={24}>
                  <Space>
                    <Button loading={testingNew} onClick={handleTestNew}>测试连接</Button>
                    <Button type="primary" loading={saving} icon={<SaveOutlined />} onClick={handleAdd}>添加</Button>
                    <Button onClick={() => { setAddVisible(false); resetForm(); }}>取消</Button>
                  </Space>
                </Col>
              </Row>
            </Card>
          )}

          <div style={{ background: "#f6f8fa", borderRadius: 6, padding: "10px 14px", fontSize: 12, color: "#666", lineHeight: "1.8" }}>
            <div><strong>为什么自配</strong>：每人各用各的 3UE 账号配额，避免共用一个账号被批量生成打满「设备数超限」。</div>
            <div><strong>只填用户名+密码</strong>：UserID / ApiKey / 节点 / 默认库 全部跟随管理台全局配置，无需员工填写。</div>
            <div><strong>选取策略</strong>：广告生成 / 关键词查询优先用你启用中的账号（按账号各自串行、不同员工并行）。</div>
            <div><strong>未配置</strong>：过渡期回退全局兜底账号，建议尽快配置自己的账号。</div>
          </div>
        </div>
      </Card>
    </div>
  );
}

// ==================== 团队隐私 Tab（组长专属）====================
function TeamPrivacyTab() {
  const { message } = App.useApp();
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [teamName, setTeamName] = useState("");
  const [visible, setVisible] = useState(false); // cross_team_visible === 1

  useEffect(() => {
    fetch("/api/user/settings/team-privacy")
      .then((r) => r.json())
      .then((res) => {
        if (res.code === 0) {
          setTeamName(res.data.team_name || "");
          setVisible(res.data.cross_team_visible === 1);
        } else {
          message.error(res.message || "加载失败");
        }
      })
      .catch(() => message.error("加载失败"))
      .finally(() => setLoading(false));
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const handleToggle = async (checked: boolean) => {
    setSaving(true);
    const res = await fetch("/api/user/settings/team-privacy", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ cross_team_visible: checked ? 1 : 0 }),
    }).then((r) => r.json()).catch(() => null);
    setSaving(false);
    if (res?.code === 0) {
      setVisible(checked);
      message.success("已保存");
    } else {
      message.error(res?.message || "保存失败");
    }
  };

  return (
    <div style={{ maxWidth: 640 }}>
      <Card title={<><TeamOutlined /> 团队投放隐私{teamName ? ` — ${teamName}` : ""}</>} size="small" loading={loading}>
        <Alert
          type="info"
          showIcon
          style={{ marginBottom: 16 }}
          message="控制本组成员能否查看其他组的投放情况"
          description="关闭（默认）时，本组成员在商家「在投详情」里只能看到本组成员的投放，「在投人数」也只统计本组；开启后，本组成员可查看其他组的投放情况。该开关仅由组长控制。"
        />
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: "12px 0" }}>
          <div>
            <div style={{ fontWeight: 500 }}>允许本组查看其他组的投放情况</div>
            <Text type="secondary" style={{ fontSize: 13 }}>
              {visible ? "已开启：本组成员可看到其他组的投放情况" : "已关闭：本组成员只能看到本组的投放情况"}
            </Text>
          </div>
          <Switch
            checked={visible}
            loading={saving}
            onChange={handleToggle}
            checkedChildren="开"
            unCheckedChildren="关"
          />
        </div>
      </Card>
    </div>
  );
}

// ==================== 主页面 ====================
export default function SettingsPage() {
  const [activeTab, setActiveTab] = useState("platforms");
  const [isLeader, setIsLeader] = useState(false);

  useEffect(() => {
    fetch("/api/auth/me?role=user")
      .then((r) => r.json())
      .then((res) => {
        if (res.code === 0 && res.data?.role === "leader") setIsLeader(true);
      })
      .catch(() => {});
  }, []);

  return (
    <div>
      <AppPageHeader icon={<SettingOutlined />} title="个人设置" />
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
          { key: "serpapi", label: <><EyeOutlined /> 广告情报</>, children: <SerpApiTab /> },
          { key: "semrush", label: <><SearchOutlined /> SemRush 关键词</>, children: <SemRushTab /> },
          ...(isLeader ? [{ key: "team-privacy", label: <><TeamOutlined /> 团队隐私</>, children: <TeamPrivacyTab /> }] : []),
        ]}
      />
    </div>
  );
}
