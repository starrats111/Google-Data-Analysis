"use client";

import { useState, useEffect } from "react";
import { Card, Switch, Typography, Alert, App, Table, Button, Space, Popconfirm, Modal, Form, Input, InputNumber, Tag, Tabs, Progress, Tooltip } from "antd";
import { TeamOutlined, SettingOutlined, PlusOutlined, EditOutlined, DeleteOutlined, CreditCardOutlined, KeyOutlined } from "@ant-design/icons";
import AppPageHeader from "@/components/AppPageHeader";

const { Text } = Typography;

// ==================== R-01 收款方式清单管理（组长） ====================
type PaymentMethod = { id: string; payee_name: string; card_no: string; created_at: string };

function PaymentMethodsCard() {
  const { message } = App.useApp();
  const [rows, setRows] = useState<PaymentMethod[]>([]);
  const [loading, setLoading] = useState(true);
  const [modalOpen, setModalOpen] = useState(false);
  const [editItem, setEditItem] = useState<PaymentMethod | null>(null);
  const [form] = Form.useForm();

  const fetchData = () =>
    fetch("/api/user/team/payment-methods")
      .then((r) => r.json())
      .then((res) => { if (res?.code === 0) setRows(res.data || []); })
      .catch(() => undefined)
      .finally(() => setLoading(false));

  useEffect(() => { fetchData(); }, []);

  const handleSave = async () => {
    const values = await form.validateFields();
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
          { title: "收款卡号", dataIndex: "card_no", render: (v: string) => v || <Text type="secondary">未填</Text> },
          {
            title: "操作", width: 140,
            render: (_: unknown, rec: PaymentMethod) => (
              <Space size={4}>
                <Button size="small" icon={<EditOutlined />} onClick={() => {
                  setEditItem(rec);
                  form.setFieldsValue({ payee_name: rec.payee_name, card_no: rec.card_no });
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
        onOk={handleSave}
        onCancel={() => { setModalOpen(false); setEditItem(null); }}
      >
        <Form form={form} layout="vertical">
          <Form.Item name="payee_name" label="收款人姓名" rules={[{ required: true, message: "请输入收款人姓名" }]}>
            <Input placeholder="如 张文俊" maxLength={64} />
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
  today_requests: number;
  today_users: number;
  label: string | null;
  is_active: number;
  cooling_until: string | null;
};

function TokenPoolCard() {
  const { message } = App.useApp();
  const [rows, setRows] = useState<PoolToken[]>([]);
  const [loading, setLoading] = useState(true);
  const [modalOpen, setModalOpen] = useState(false);
  const [editItem, setEditItem] = useState<PoolToken | null>(null);
  const [form] = Form.useForm();

  const fetchData = () =>
    fetch("/api/user/team/token-pool")
      .then((r) => r.json())
      .then((res) => { if (res?.code === 0) setRows(res.data || []); })
      .catch(() => undefined)
      .finally(() => setLoading(false));

  useEffect(() => { fetchData(); }, []);

  const handleSave = async () => {
    const values = await form.validateFields();
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

  const handleToggleActive = async (rec: PoolToken, checked: boolean) => {
    const res = await fetch("/api/user/team/token-pool", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id: rec.id, token: rec.token, label: rec.label, daily_quota: rec.daily_quota, is_active: checked ? 1 : 0 }),
    }).then((r) => r.json());
    if (res.code === 0) fetchData();
    else message.error(res.message);
  };

  const totalQuota = rows.filter((r) => r.is_active === 1).reduce((s, r) => s + r.daily_quota, 0);
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
          <Button size="small" type="primary" icon={<PlusOutlined />} onClick={() => {
            setEditItem(null);
            form.resetFields();
            form.setFieldsValue({ daily_quota: 15000 });
            setModalOpen(true);
          }}>添加</Button>
        </Space>
      }
    >
      <Alert
        type="info"
        showIcon
        style={{ marginBottom: 12 }}
        message="每条 = Developer Token + 配对的 Service Account JSON，两者一起存储、一起轮换。本组所有 Google Ads API 请求在池内自动轮询，配额互相分摊；触发限流的 Token 自动冷却几分钟并切换下一个。"
        description="配置后组员的 MCC 无需再填服务账号/Token（已填的作为兜底继续有效）。Token 在 MCC 后台「工具 → API 中心」获取；JSON 为该项目服务账号密钥，且服务账号需被加入本组各 MCC。"
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
              const pct = rec.daily_quota > 0 ? Math.min(100, Math.round((rec.today_requests / rec.daily_quota) * 100)) : 0;
              return (
                <Tooltip title={`今日 ${rec.today_requests.toLocaleString()} / 额度 ${rec.daily_quota.toLocaleString()}`}>
                  <Progress
                    percent={pct}
                    size="small"
                    status={pct >= 90 ? "exception" : "normal"}
                    format={() => `${rec.today_requests.toLocaleString()}/${(rec.daily_quota / 1000).toFixed(0)}k`}
                  />
                </Tooltip>
              );
            },
          },
          { title: "使用人数", dataIndex: "today_users", width: 80, align: "center" as const },
          {
            title: "状态", width: 100,
            render: (_: unknown, rec: PoolToken) =>
              rec.is_active !== 1 ? <Tag>已停用</Tag>
                : rec.cooling_until ? <Tag color="orange">限流冷却中</Tag>
                : <Tag color="green">可用</Tag>,
          },
          {
            title: "启用", width: 60,
            render: (_: unknown, rec: PoolToken) => (
              <Switch size="small" checked={rec.is_active === 1} onChange={(c) => handleToggleActive(rec, c)} />
            ),
          },
          {
            title: "操作", width: 90,
            render: (_: unknown, rec: PoolToken) => (
              <Space size={4}>
                <Button size="small" icon={<EditOutlined />} onClick={() => {
                  setEditItem(rec);
                  form.setFieldsValue({ token: rec.token, label: rec.label, daily_quota: rec.daily_quota, service_account_json: "" });
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
            label={editItem ? "配对 Service Account JSON（留空 = 保留原有）" : "配对 Service Account JSON"}
            rules={editItem ? [] : [{ required: true, message: "请粘贴该 Token 配对的 Service Account JSON" }]}
          >
            <Input.TextArea
              rows={5}
              placeholder='粘贴完整密钥 JSON，形如 {"type":"service_account","client_email":"...","private_key":"..."}'
            />
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
