"use client";

import {
  Table, Button, Modal, Form, Input, Space, Typography,
  Popconfirm, Card, Tabs, Spin, App,
} from "antd";
import {
  PlusOutlined, EditOutlined, DeleteOutlined, SaveOutlined,
  CloudServerOutlined, ApiOutlined, DatabaseOutlined, SettingOutlined, GoogleOutlined,
} from "@ant-design/icons";
import { useEffect, useState, useCallback } from "react";

const { Title, Text } = Typography;
const { TextArea, Password } = Input;

// ─── 配置分组定义（与 system-config.ts 的 CONFIG_GROUPS 保持一致）───
interface ConfigField {
  key: string;
  label: string;
  placeholder: string;
  required?: boolean;
  isPassword?: boolean;
  isTextarea?: boolean;
  type?: string;
}

const CONFIG_GROUPS: Record<string, {
  title: string;
  icon: React.ReactNode;
  description: string;
  fields: ConfigField[];
}> = {
  backend: {
    title: "后端服务器",
    icon: <ApiOutlined />,
    description: "数据分析平台后端 API 地址，用于站点管理、文章发布等服务调用。",
    fields: [
      { key: "backend_api_url", label: "后端 API 地址", placeholder: "如：http://localhost:8000", required: true },
      { key: "backend_api_token", label: "API Token", placeholder: "后端认证 Token", isPassword: true },
    ],
  },
  mysql: {
    title: "MySQL 数据库",
    icon: <DatabaseOutlined />,
    description: "系统 MySQL 数据库连接参数，用于初始化脚本和数据迁移。",
    fields: [
      { key: "mysql_host", label: "主机地址", placeholder: "如：localhost 或 127.0.0.1", required: true },
      { key: "mysql_port", label: "端口", placeholder: "3306", type: "number" },
      { key: "mysql_user", label: "用户名", placeholder: "数据库用户名", required: true },
      { key: "mysql_password", label: "密码", placeholder: "数据库密码", isPassword: true },
      { key: "mysql_database", label: "数据库名", placeholder: "google-data-analysis", required: true },
      { key: "mysql_shadow_database", label: "影子库名", placeholder: "google-data-analysis_shadow" },
    ],
  },
  google_sheets: {
    title: "Google Sheets 服务账号",
    icon: <GoogleOutlined />,
    description: "用于访问需要邮箱授权的 Google Sheet（违规/推荐商家名单）。粘贴 Service Account JSON 密钥，并将 Sheet 共享给该服务账号邮箱（查看者权限）。与 wj07 的 MCC 服务账号一致。",
    fields: [
      { key: "google_sheets_sa_json", label: "Service Account JSON", placeholder: "粘贴 Google Cloud Service Account 密钥 JSON 全文", required: true, isTextarea: true },
    ],
  },
};

// ─── 通用配置 ───
interface Config {
  id: string;
  config_key: string;
  config_value: string | null;
  description: string | null;
}

// 所有分组 key 集合（用于过滤通用配置）
const groupKeys = new Set<string>();
for (const g of Object.values(CONFIG_GROUPS)) {
  for (const f of g.fields) groupKeys.add(f.key);
}

// ─── 分组配置卡片组件 ───
function ConfigGroupCard({
  groupKey,
  group,
  configValues,
  onSaved,
}: {
  groupKey: string;
  group: (typeof CONFIG_GROUPS)[string];
  configValues: Record<string, string>;
  onSaved: () => void;
}) {
  const { message } = App.useApp();
  const [form] = Form.useForm();
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    const values: Record<string, string> = {};
    for (const f of group.fields) {
      values[f.key] = configValues[f.key] || "";
    }
    form.setFieldsValue(values);
  }, [configValues, form, group.fields]);

  const handleSave = async () => {
    const values = await form.validateFields();
    setSaving(true);
    try {
      const res = await fetch("/api/admin/system-config/batch", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(values),
      }).then((r) => r.json());
      if (res.code === 0) {
        message.success(`${group.title}配置已保存`);
        onSaved();
      } else {
        message.error(res.message);
      }
    } catch {
      message.error("保存失败");
    } finally {
      setSaving(false);
    }
  };

  return (
    <Card
      title={<Space>{group.icon}<span>{group.title}</span></Space>}
      extra={
        <Button type="primary" icon={<SaveOutlined />} loading={saving} onClick={handleSave}>
          保存
        </Button>
      }
      style={{ marginBottom: 16 }}
    >
      <Text type="secondary" style={{ display: "block", marginBottom: 16 }}>
        {group.description}
      </Text>
      <Form form={form} layout="vertical" style={{ maxWidth: 640 }}>
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "0 24px" }}>
          {group.fields.map((field) => (
            <Form.Item
              key={field.key}
              name={field.key}
              label={field.label}
              rules={field.required ? [{ required: true, message: `请输入${field.label}` }] : undefined}
              style={(field.key.includes("base_url") || field.key.includes("key_path") || field.isTextarea) ? { gridColumn: "1 / -1" } : undefined}
            >
              {field.isPassword ? (
                <Password placeholder={field.placeholder} />
              ) : field.isTextarea ? (
                <TextArea rows={6} placeholder={field.placeholder} style={{ fontFamily: "monospace", fontSize: 12 }} />
              ) : (
                <Input placeholder={field.placeholder} />
              )}
            </Form.Item>
          ))}
        </div>
      </Form>
    </Card>
  );
}

// ─── 主页面 ───
export default function SystemConfigPage() {
  const { message } = App.useApp();
  const [configValues, setConfigValues] = useState<Record<string, string>>({});
  const [generalList, setGeneralList] = useState<Config[]>([]);
  const [loading, setLoading] = useState(false);
  const [modalOpen, setModalOpen] = useState(false);
  const [editItem, setEditItem] = useState<Config | null>(null);
  const [form] = Form.useForm();

  const fetchAll = useCallback(async () => {
    setLoading(true);
    // 获取分组配置
    const batchRes = await fetch("/api/admin/system-config/batch").then((r) => r.json()).catch(() => ({ code: -1 }));
    if (batchRes.code === 0) setConfigValues(batchRes.data || {});

    // 获取通用配置
    const generalRes = await fetch("/api/admin/system-config").then((r) => r.json()).catch(() => ({ code: -1 }));
    if (generalRes.code === 0) {
      // 过滤掉分组配置
      setGeneralList((generalRes.data || []).filter((c: Config) => !groupKeys.has(c.config_key)));
    }
    setLoading(false);
  }, []);

  useEffect(() => { fetchAll(); }, [fetchAll]);

  // ─── 通用配置 CRUD ───
  const handleCreate = () => { setEditItem(null); form.resetFields(); setModalOpen(true); };
  const handleEdit = (item: Config) => { setEditItem(item); form.setFieldsValue(item); setModalOpen(true); };

  const handleSubmit = async () => {
    const values = await form.validateFields();
    const method = editItem ? "PUT" : "POST";
    const body = editItem ? { id: editItem.id, ...values } : values;
    const res = await fetch("/api/admin/system-config", {
      method, headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
    }).then((r) => r.json());
    if (res.code === 0) { message.success(editItem ? "更新成功" : "创建成功"); setModalOpen(false); fetchAll(); }
    else message.error(res.message);
  };

  const handleDelete = async (id: string) => {
    const res = await fetch("/api/admin/system-config", {
      method: "DELETE", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ id }),
    }).then((r) => r.json());
    if (res.code === 0) { message.success("删除成功"); fetchAll(); } else message.error(res.message);
  };

  const columns = [
    { title: "配置键", dataIndex: "config_key", width: 200 },
    { title: "配置值", dataIndex: "config_value", ellipsis: true },
    { title: "说明", dataIndex: "description", ellipsis: true },
    {
      title: "操作", width: 160, render: (_: unknown, record: Config) => (
        <Space>
          <Button size="small" icon={<EditOutlined />} onClick={() => handleEdit(record)}>编辑</Button>
          <Popconfirm title="确认删除？" onConfirm={() => handleDelete(record.id)}>
            <Button size="small" danger icon={<DeleteOutlined />}>删除</Button>
          </Popconfirm>
        </Space>
      ),
    },
  ];

  return (
    <div>
      <Title level={4} style={{ marginBottom: 24 }}>
        <SettingOutlined /> 系统配置
      </Title>

      <Spin spinning={loading}>
        <Tabs
          defaultActiveKey="servers"
          items={[
            {
              key: "servers",
              label: <><CloudServerOutlined /> 服务器配置</>,
              children: (
                <>
                  <ConfigGroupCard groupKey="backend" group={CONFIG_GROUPS.backend} configValues={configValues} onSaved={fetchAll} />
                </>
              ),
            },
            {
              key: "mysql",
              label: <><DatabaseOutlined /> MySQL 配置</>,
              children: (
                <ConfigGroupCard groupKey="mysql" group={CONFIG_GROUPS.mysql} configValues={configValues} onSaved={fetchAll} />
              ),
            },
            {
              key: "google_sheets",
              label: <><GoogleOutlined /> Google Sheets</>,
              children: (
                <ConfigGroupCard groupKey="google_sheets" group={CONFIG_GROUPS.google_sheets} configValues={configValues} onSaved={fetchAll} />
              ),
            },
            {
              key: "general",
              label: <><SettingOutlined /> 其他配置</>,
              children: (
                <Card
                  extra={<Button type="primary" icon={<PlusOutlined />} onClick={handleCreate}>添加配置</Button>}
                >
                  <Table columns={columns} dataSource={generalList} rowKey="id" size="small" pagination={false} />
                </Card>
              ),
            },
          ]}
        />
      </Spin>

      <Modal title={editItem ? "编辑配置" : "添加配置"} open={modalOpen} onOk={handleSubmit} onCancel={() => setModalOpen(false)}>
        <Form form={form} layout="vertical">
          {!editItem && (
            <Form.Item name="config_key" label="配置键" rules={[{ required: true }]}>
              <Input placeholder="如 exchange_rate_interval" />
            </Form.Item>
          )}
          <Form.Item name="config_value" label="配置值">
            <TextArea rows={3} />
          </Form.Item>
          <Form.Item name="description" label="说明">
            <Input />
          </Form.Item>
        </Form>
      </Modal>
    </div>
  );
}
