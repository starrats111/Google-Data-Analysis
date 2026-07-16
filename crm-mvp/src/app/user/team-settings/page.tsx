"use client";

import { useState, useEffect } from "react";
import { Card, Switch, Typography, Alert, App, Table, Button, Space, Popconfirm, Modal, Form, Input, InputNumber, Tag, Tabs, Progress, Tooltip, Upload } from "antd";
import { TeamOutlined, SettingOutlined, PlusOutlined, EditOutlined, DeleteOutlined, CreditCardOutlined, KeyOutlined, CheckCircleOutlined, FileTextOutlined, InboxOutlined } from "@ant-design/icons";
import AppPageHeader from "@/components/AppPageHeader";

const { Text } = Typography;

// ==================== R-01 收款方式清单管理（组长） ====================
// C-178：收款人=纯名字，打款方式（银行/渠道）单独一列
type PaymentMethod = { id: string; payee_name: string; pay_channel: string; card_no: string; created_at: string };

function PaymentMethodsCard() {
  const { message } = App.useApp();
  const [rows, setRows] = useState<PaymentMethod[]>([]);
  const [loading, setLoading] = useState(true);
  const [modalOpen, setModalOpen] = useState(false);
  const [editItem, setEditItem] = useState<PaymentMethod | null>(null);
  const [saving, setSaving] = useState(false);
  const [form] = Form.useForm();

  const fetchData = () =>
    fetch("/api/user/team/payment-methods")
      .then((r) => r.json())
      .then((res) => { if (res?.code === 0) setRows(res.data || []); })
      .catch(() => undefined)
      .finally(() => setLoading(false));

  useEffect(() => { fetchData(); }, []);

  const handleSave = async () => {
    let values: Record<string, unknown>;
    try { values = await form.validateFields(); } catch { return; }
    setSaving(true);
    try {
      const body = editItem ? { id: editItem.id, ...values } : values;
      const res = await fetch("/api/user/team/payment-methods", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      }).then((r) => r.json());
      if (res.code === 0) {
        message.success(res.message || "保存成功");
        setModalOpen(false);
        setEditItem(null);
        fetchData();
      } else {
        message.error(res.message);
      }
    } catch {
      message.error("网络异常，请重试");
    } finally {
      setSaving(false);
    }
  };

  const handleDelete = async (id: string) => {
    const res = await fetch("/api/user/team/payment-methods", {
      method: "DELETE",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id }),
    }).then((r) => r.json());
    if (res.code === 0) { message.success("删除成功"); fetchData(); }
    else message.error(res.message);
  };

  return (
    <Card
      title={<><CreditCardOutlined /> 收款方式清单</>}
      size="small"
      loading={loading}
      style={{ maxWidth: 680 }}
      extra={
        <Button size="small" type="primary" icon={<PlusOutlined />} onClick={() => {
          setEditItem(null);
          form.resetFields();
          setModalOpen(true);
        }}>添加</Button>
      }
    >
      <Alert
        type="info"
        showIcon
        style={{ marginBottom: 12 }}
        message="组员在「个人设置 → 联盟平台连接」中为各联盟账号选择收款方式，月度收支报表按绑定显示收款人/卡号"
      />
      <Table
        dataSource={rows}
        rowKey="id"
        size="small"
        pagination={false}
        columns={[
          { title: "收款人", dataIndex: "payee_name" },
          { title: "打款方式", dataIndex: "pay_channel", render: (v: string) => v ? <Tag color="blue">{v}</Tag> : <Text type="secondary">未填</Text> },
          { title: "收款卡号", dataIndex: "card_no", render: (v: string) => v || <Text type="secondary">未填</Text> },
          {
            title: "操作", width: 140,
            render: (_: unknown, rec: PaymentMethod) => (
              <Space size={4}>
                <Button size="small" icon={<EditOutlined />} onClick={() => {
                  setEditItem(rec);
                  form.setFieldsValue({ payee_name: rec.payee_name, pay_channel: rec.pay_channel, card_no: rec.card_no });
                  setModalOpen(true);
                }}>编辑</Button>
                <Popconfirm title="确认删除此收款方式？" onConfirm={() => handleDelete(rec.id)}>
                  <Button size="small" danger icon={<DeleteOutlined />} />
                </Popconfirm>
              </Space>
            ),
          },
        ]}
      />
      <Modal
        title={editItem ? "编辑收款方式" : "添加收款方式"}
        open={modalOpen}
        confirmLoading={saving}
        onOk={handleSave}
        onCancel={() => { setModalOpen(false); setEditItem(null); }}
      >
        <Form form={form} layout="vertical">
          <Form.Item
            name="payee_name" label="收款人姓名"
            rules={[
              { required: true, message: "请输入收款人姓名" },
              { pattern: /^[^（()）]*$/, message: "请填纯名字，银行/渠道填在下方「打款方式」" },
            ]}
          >
            <Input placeholder="如 张文俊（纯名字，不带括号）" maxLength={64} />
          </Form.Item>
          <Form.Item name="pay_channel" label="打款方式" tooltip="该卡的收款银行/渠道，结算查询「打款记录」按此列展示与筛选">
            <Input placeholder="如 农业 / 工商 / 香港 / PingPong / WISE" maxLength={64} />
          </Form.Item>
          <Form.Item name="card_no" label="收款卡号">
            <Input placeholder="如 6222031203014493768" maxLength={64} />
          </Form.Item>
        </Form>
      </Modal>
    </Card>
  );
}

// ==================== Developer Token 池管理（组长） ====================
type PoolToken = {
  id: string;
  token: string;
  token_masked: string;
  has_sa_json: boolean;
  sa_email: string | null;
  daily_quota: number;
  detected_quota: number | null;
  today_requests: number;
  today_users: number;
  label: string | null;
  is_active: number;
  cooling_until: string | null;
  health_status: string;
  health_note: string | null;
  last_ok_at: string | null;
  ok_mccs: string[];
  denied_mccs: string[];
};

function TokenPoolCard() {
  const { message } = App.useApp();
  const [rows, setRows] = useState<PoolToken[]>([]);
  const [loading, setLoading] = useState(true);
  const [modalOpen, setModalOpen] = useState(false);
  const [editItem, setEditItem] = useState<PoolToken | null>(null);
  const [jsonFileName, setJsonFileName] = useState("");
  const [probing, setProbing] = useState<string | null>(null); // "all" 或单个 token id
  const [saving, setSaving] = useState(false);
  const [form] = Form.useForm();

  const fetchData = () =>
    fetch("/api/user/team/token-pool")
      .then((r) => r.json())
      .then((res) => { if (res?.code === 0) setRows(res.data || []); })
      .catch(() => undefined)
      .finally(() => setLoading(false));

  useEffect(() => { fetchData(); }, []);

  const handleSave = async () => {
    let values: Record<string, unknown>;
    try { values = await form.validateFields(); } catch { return; }
    setSaving(true);
    try {
      const body = editItem ? { id: editItem.id, ...values } : values;
      const res = await fetch("/api/user/team/token-pool", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      }).then((r) => r.json());
      if (res.code === 0) {
        message.success(res.message || "保存成功");
        setModalOpen(false);
        setEditItem(null);
        fetchData();
      } else {
        message.error(res.message);
      }
    } catch {
      message.error("网络异常，请重试");
    } finally {
      setSaving(false);
    }
  };

  const handleDelete = async (id: string) => {
    const res = await fetch("/api/user/team/token-pool", {
      method: "DELETE",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id }),
    }).then((r) => r.json());
    if (res.code === 0) { message.success("已移除"); fetchData(); }
    else message.error(res.message);
  };

  const handleProbe = async (id: string | null) => {
    setProbing(id || "all");
    try {
      const res = await fetch("/api/user/team/token-pool/probe", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(id ? { id } : {}),
      }).then((r) => r.json());
      if (res.code === 0) { message.success("检测完成，标记已更新"); fetchData(); }
      else message.error(res.message);
    } catch {
      message.error("检测请求失败");
    } finally {
      setProbing(null);
    }
  };

  const handleToggleActive = async (rec: PoolToken, checked: boolean) => {
    const res = await fetch("/api/user/team/token-pool", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id: rec.id, token: rec.token, label: rec.label, daily_quota: rec.daily_quota, is_active: checked ? 1 : 0 }),
    }).then((r) => r.json());
    if (res.code === 0) fetchData();
    else message.error(res.message);
  };

  // 实测额度（触顶反推）优先于手填额度
  const effectiveQuota = (r: PoolToken) => r.detected_quota ?? r.daily_quota;
  const totalQuota = rows.filter((r) => r.is_active === 1).reduce((s, r) => s + effectiveQuota(r), 0);
  const totalUsed = rows.reduce((s, r) => s + r.today_requests, 0);

  return (
    <Card
      title={<><KeyOutlined /> Google Ads Developer Token 池</>}
      size="small"
      loading={loading}
      style={{ maxWidth: 980 }}
      extra={
        <Space>
          <Text type="secondary" style={{ fontSize: 13 }}>
            池总额度 <Text strong>{totalQuota.toLocaleString()}</Text> / 今日已用 <Text strong>{totalUsed.toLocaleString()}</Text>
          </Text>
          <Button size="small" loading={probing === "all"} onClick={() => handleProbe(null)}>全部检测</Button>
          <Button size="small" type="primary" icon={<PlusOutlined />} onClick={() => {
            setEditItem(null);
            form.resetFields();
            form.setFieldsValue({ daily_quota: 15000 });
            setJsonFileName("");
            setModalOpen(true);
          }}>添加</Button>
        </Space>
      }
    >
      <Alert
        type="info"
        showIcon
        style={{ marginBottom: 12 }}
        message="每条 = Developer Token + 配对的 Service Account JSON，两者一起存储、一起轮换。系统自动体检：根据真实请求与每日探测自动标记「谁能用、对哪些 MCC 能用」，失效/无权限的凭证自动跳过；每日额度触顶时自动反推实测额度（带 ✓），次日自动恢复。"
        description="配置后组员的 MCC 无需再填服务账号/Token（已填的作为兜底继续有效）。新加 Token 后可点「检测」立即体检；标记无需人工维护，凭证修复后次日体检自动复活。"
      />
      <Table
        dataSource={rows}
        rowKey="id"
        size="small"
        pagination={false}
        columns={[
          { title: "Token", dataIndex: "token_masked", width: 110, render: (v: string) => <Text code>{v}</Text> },
          {
            title: "配对 JSON", width: 170,
            render: (_: unknown, rec: PoolToken) =>
              rec.has_sa_json
                ? <Tooltip title={rec.sa_email}><Tag color="blue" style={{ maxWidth: 160, overflow: "hidden", textOverflow: "ellipsis" }}>{rec.sa_email || "已配置"}</Tag></Tooltip>
                : <Tag color="red">未配置</Tag>,
          },
          { title: "备注", dataIndex: "label", ellipsis: true, render: (v: string | null) => v || <Text type="secondary">—</Text> },
          {
            title: "今日用量", width: 160,
            render: (_: unknown, rec: PoolToken) => {
              const quota = effectiveQuota(rec);
              const pct = quota > 0 ? Math.min(100, Math.round((rec.today_requests / quota) * 100)) : 0;
              const quotaLabel = rec.detected_quota != null
                ? `实测额度 ${rec.detected_quota.toLocaleString()}（触顶自动探得）`
                : `预设额度 ${rec.daily_quota.toLocaleString()}（未触顶，实际额度待系统探测）`;
              return (
                <Tooltip title={`今日 ${rec.today_requests.toLocaleString()} / ${quotaLabel}`}>
                  <Progress
                    percent={pct}
                    size="small"
                    status={pct >= 90 ? "exception" : "normal"}
                    format={() => `${rec.today_requests.toLocaleString()}/${(quota / 1000).toFixed(0)}k${rec.detected_quota != null ? "✓" : ""}`}
                  />
                </Tooltip>
              );
            },
          },
          { title: "使用人数", dataIndex: "today_users", width: 80, align: "center" as const },
          {
            title: "状态", width: 130,
            render: (_: unknown, rec: PoolToken) => {
              if (rec.is_active !== 1) return <Tag>已停用</Tag>;
              const denied = rec.denied_mccs.length;
              const tip = [
                rec.health_note,
                rec.ok_mccs.length > 0 ? `可用 MCC：${rec.ok_mccs.join(", ")}` : null,
                denied > 0 ? `无权限 MCC：${rec.denied_mccs.join(", ")}` : null,
                rec.last_ok_at ? `最近成功：${new Date(rec.last_ok_at).toLocaleString("zh-CN")}` : null,
              ].filter(Boolean).join("\n");
              const tag =
                rec.cooling_until ? <Tag color="orange">限流冷却中</Tag>
                : rec.health_status === "invalid" ? <Tag color="red">已失效</Tag>
                : rec.health_status === "limited" ? <Tag color="volcano">额度触顶</Tag>
                : rec.health_status === "ok" ? (denied > 0 ? <Tag color="gold">部分可用</Tag> : <Tag color="green">可用</Tag>)
                : <Tag color="default">待检测</Tag>;
              return <Tooltip title={<span style={{ whiteSpace: "pre-line" }}>{tip || "系统将根据真实请求与每日体检自动标记"}</span>}>{tag}</Tooltip>;
            },
          },
          {
            title: "启用", width: 60,
            render: (_: unknown, rec: PoolToken) => (
              <Switch size="small" checked={rec.is_active === 1} onChange={(c) => handleToggleActive(rec, c)} />
            ),
          },
          {
            title: "操作", width: 130,
            render: (_: unknown, rec: PoolToken) => (
              <Space size={4}>
                <Tooltip title="立即检测：用此凭证对本组各 MCC 发一条最小查询，自动更新可用性标记">
                  <Button size="small" loading={probing === rec.id} onClick={() => handleProbe(rec.id)}>检测</Button>
                </Tooltip>
                <Button size="small" icon={<EditOutlined />} onClick={() => {
                  setEditItem(rec);
                  form.setFieldsValue({ token: rec.token, label: rec.label, daily_quota: rec.daily_quota, service_account_json: undefined });
                  setJsonFileName(rec.has_sa_json ? `已有凭证（${rec.sa_email || "已配置"}）` : "");
                  setModalOpen(true);
                }} />
                <Popconfirm title="确认从池中移除此 Token？" onConfirm={() => handleDelete(rec.id)}>
                  <Button size="small" danger icon={<DeleteOutlined />} />
                </Popconfirm>
              </Space>
            ),
          },
        ]}
      />
      <Modal
        title={editItem ? "编辑 Token" : "添加 Developer Token"}
        open={modalOpen}
        width={560}
        confirmLoading={saving}
        onOk={handleSave}
        onCancel={() => { setModalOpen(false); setEditItem(null); }}
      >
        <Form form={form} layout="vertical">
          <Form.Item
            name="token"
            label="Developer Token"
            rules={[
              { required: true, message: "请输入 Developer Token" },
              { min: 15, message: "Token 长度异常，Google Ads Developer Token 一般为 22 位" },
            ]}
          >
            <Input placeholder="如 rYAXtRxxxxxxxxxxxxxxxx（22 位）" maxLength={64} />
          </Form.Item>
          <Form.Item
            name="service_account_json"
            label="配对服务账号凭证 JSON"
            rules={editItem ? [] : [{ required: true, message: "请上传该 Token 配对的服务账号 JSON 文件" }]}
          >
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
                      const sa = JSON.parse(text); // 验证是合法 JSON
                      if (!sa.client_email || !sa.private_key) {
                        message.error("JSON 缺少 client_email 或 private_key，请上传完整的服务账号密钥文件");
                        return;
                      }
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
                <p style={{ fontSize: 12, color: "#999" }}>{editItem ? "不上传则保留已有凭证；仅支持 .json 格式" : "仅支持 .json 格式"}</p>
              </Upload.Dragger>
            )}
          </Form.Item>
          <Form.Item name="daily_quota" label="每日额度（operations/天）" tooltip="Basic 级默认 15000；仅用于用量展示与预警，不影响轮询">
            <InputNumber min={1000} max={10000000} step={1000} style={{ width: 200 }} />
          </Form.Item>
          <Form.Item name="label" label="备注（选填）">
            <Input placeholder="如：MCC 468-317-xxxx 的 Token" maxLength={64} />
          </Form.Item>
        </Form>
      </Modal>
    </Card>
  );
}

// ==================== 团队投放隐私（组长） ====================
function PrivacyCard() {
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
    <Card
      title={<><TeamOutlined /> 团队投放隐私{teamName ? ` — ${teamName}` : ""}</>}
      size="small"
      loading={loading}
      style={{ maxWidth: 680 }}
    >
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
  );
}

export default function TeamSettingsPage() {
  return (
    <div>
      <AppPageHeader icon={<SettingOutlined />} title="团队设置" subtitle="组长专属：投放隐私 / 收款方式 / Token 池" />
      <Tabs
        defaultActiveKey="privacy"
        items={[
          { key: "privacy", label: <><TeamOutlined /> 投放隐私</>, children: <PrivacyCard /> },
          { key: "payment", label: <><CreditCardOutlined /> 收款方式</>, children: <PaymentMethodsCard /> },
          { key: "token-pool", label: <><KeyOutlined /> Token 池</>, children: <TokenPoolCard /> },
        ]}
      />
    </div>
  );
}
