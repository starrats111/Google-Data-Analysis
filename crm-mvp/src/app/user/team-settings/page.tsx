"use client";

import { useState, useEffect } from "react";
import { Card, Switch, Typography, Alert, App, Table, Button, Space, Popconfirm, Modal, Form, Input } from "antd";
import { TeamOutlined, SettingOutlined, PlusOutlined, EditOutlined, DeleteOutlined, CreditCardOutlined } from "@ant-design/icons";
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
      style={{ maxWidth: 680, marginTop: 16 }}
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

export default function TeamSettingsPage() {
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
    <div>
      <AppPageHeader icon={<SettingOutlined />} title="团队设置" subtitle="组长专属：控制本组的投放隐私" />
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
      <PaymentMethodsCard />
    </div>
  );
}
