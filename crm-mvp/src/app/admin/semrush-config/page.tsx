"use client";

import {
  Card, Form, Input, Button, Typography, Space, Spin, Popconfirm, Alert, Descriptions, Tag, App,
} from "antd";
import {
  SaveOutlined, DeleteOutlined, ReloadOutlined, CheckCircleOutlined, ExclamationCircleOutlined,
} from "@ant-design/icons";
import { useEffect, useState, useCallback } from "react";

const { Title, Text } = Typography;

interface SemRushField {
  key: string;
  label: string;
  required: boolean;
  default?: string;
}

export default function SemRushConfigPage() {
  const { message } = App.useApp();
  const [form] = Form.useForm();
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [fields, setFields] = useState<SemRushField[]>([]);
  const [hasConfig, setHasConfig] = useState(false);

  const fetchConfig = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch("/api/admin/semrush-config").then((r) => r.json());
      if (res.code === 0) {
        setFields(res.data.fields);
        form.setFieldsValue(res.data.config);
        // 判断是否已配置（username 非空）
        setHasConfig(!!res.data.config.semrush_username);
      }
    } catch {
      message.error("加载配置失败");
    }
    setLoading(false);
  }, [form]);

  useEffect(() => { fetchConfig(); }, [fetchConfig]);

  const handleSave = async () => {
    try {
      const values = await form.validateFields();
      setSaving(true);
      const res = await fetch("/api/admin/semrush-config", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ config: values }),
      }).then((r) => r.json());
      if (res.code === 0) {
        message.success("保存成功");
        setHasConfig(true);
      } else {
        message.error(res.message);
      }
    } catch {
      message.error("请填写必填项");
    }
    setSaving(false);
  };

  const handleClear = async () => {
    const res = await fetch("/api/admin/semrush-config", {
      method: "DELETE",
      headers: { "Content-Type": "application/json" },
    }).then((r) => r.json());
    if (res.code === 0) {
      message.success("配置已清除");
      form.resetFields();
      setHasConfig(false);
    } else {
      message.error(res.message);
    }
  };

  // 密码类字段
  const sensitiveKeys = ["semrush_password", "semrush_api_key"];

  return (
    <div>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 16 }}>
        <Space>
          <Title level={4} style={{ margin: 0 }}>SemRush 竞品分析配置</Title>
          {hasConfig ? (
            <Tag icon={<CheckCircleOutlined />} color="success">已配置</Tag>
          ) : (
            <Tag icon={<ExclamationCircleOutlined />} color="warning">未配置</Tag>
          )}
        </Space>
        <Space>
          <Button icon={<ReloadOutlined />} onClick={fetchConfig}>刷新</Button>
          <Popconfirm title="确认清除所有 SemRush 配置？" onConfirm={handleClear} okText="确认" cancelText="取消">
            <Button danger icon={<DeleteOutlined />}>清除配置</Button>
          </Popconfirm>
        </Space>
      </div>

      <Alert
        title="SemRush 竞品分析"
        description="配置 3UE/SemRush 代理凭据后，系统可自动从竞品网站提取关键词、广告标题和描述，用于广告创建时的智能文案生成。"
        type="info"
        showIcon
        style={{ marginBottom: 16 }}
      />

      <Spin spinning={loading}>
        <Card>
          <Form form={form} layout="vertical" style={{ maxWidth: 560 }}>
            {fields.map((field) => (
              <Form.Item
                key={field.key}
                name={field.key}
                label={
                  <Space>
                    <Text strong>{field.label}</Text>
                    <Text type="secondary" style={{ fontSize: 12 }}>({field.key})</Text>
                  </Space>
                }
                rules={field.required ? [{ required: true, message: `请输入${field.label}` }] : []}
              >
                {sensitiveKeys.includes(field.key) ? (
                  <Input.Password placeholder={field.required ? `必填` : `选填，默认: ${field.default || ""}`} />
                ) : (
                  <Input placeholder={field.required ? `必填` : `选填，默认: ${field.default || ""}`} />
                )}
              </Form.Item>
            ))}

            <Form.Item style={{ marginTop: 24 }}>
              <Button type="primary" icon={<SaveOutlined />} onClick={handleSave} loading={saving} size="large">
                保存配置
              </Button>
            </Form.Item>
          </Form>
        </Card>
      </Spin>

      <Card title="配置说明" style={{ marginTop: 16 }} size="small">
        <Descriptions column={1} size="small" bordered>
          <Descriptions.Item label="用户名 / 密码">3UE 平台登录凭据（dash.3ue.co）</Descriptions.Item>
          <Descriptions.Item label="User ID">RPC 请求所需的 userId，从 3UE 后台获取</Descriptions.Item>
          <Descriptions.Item label="API Key">RPC 请求所需的 apiKey，从 3UE 后台获取</Descriptions.Item>
          <Descriptions.Item label="节点">访问节点编号，默认 3，一般不需要修改</Descriptions.Item>
          <Descriptions.Item label="默认数据库">查询的国家数据库，如 us / uk / ca / au</Descriptions.Item>
        </Descriptions>
      </Card>
    </div>
  );
}
