"use client";

import {
  Card, Form, Input, Button, Typography, Space, Spin, Popconfirm, Alert, Descriptions, Tag, App,
} from "antd";
import {
  SaveOutlined, DeleteOutlined, ReloadOutlined, CheckCircleOutlined, ExclamationCircleOutlined,
  ApiOutlined, LoadingOutlined, CloseCircleOutlined,
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
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<{ steps: { step: string; status: string; detail: string }[]; overall: string } | null>(null);

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

  const handleSave = async (values: Record<string, string>) => {
    setSaving(true);
    try {
      const res = await fetch("/api/admin/semrush-config", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ config: values }),
      }).then((r) => r.json());
      if (res.code === 0) {
        message.success("保存成功");
        setHasConfig(true);
      } else {
        message.error(res.message || "保存失败");
      }
    } catch {
      message.error("网络请求失败，请重试");
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

  const handleTest = async () => {
    setTesting(true);
    setTestResult(null);
    try {
      const res = await fetch("/api/admin/semrush-config/test", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
      }).then((r) => r.json());
      if (res.code === 0) {
        setTestResult(res.data);
        if (res.data.overall === "success") {
          message.success("所有连接测试通过");
        } else {
          message.warning("部分测试未通过，请查看详情");
        }
      } else {
        message.error(res.message || "测试失败");
      }
    } catch {
      message.error("测试请求失败");
    }
    setTesting(false);
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
          <Form form={form} layout="vertical" style={{ maxWidth: 560 }} onFinish={handleSave}>
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
              <Space>
                <Button type="primary" htmlType="submit" icon={<SaveOutlined />} loading={saving} size="large">
                  保存配置
                </Button>
                {hasConfig && (
                  <Button
                    icon={testing ? <LoadingOutlined /> : <ApiOutlined />}
                    onClick={handleTest}
                    loading={testing}
                    size="large"
                  >
                    测试连接
                  </Button>
                )}
              </Space>
            </Form.Item>
          </Form>

          {testResult && (
            <div style={{ marginTop: 16, padding: 16, background: "#fafafa", borderRadius: 8 }}>
              <Text strong style={{ display: "block", marginBottom: 12 }}>连接诊断结果：</Text>
              {testResult.steps.map((s, i) => (
                <div key={i} style={{ display: "flex", alignItems: "flex-start", gap: 8, marginBottom: 8 }}>
                  {s.status === "success" ? (
                    <CheckCircleOutlined style={{ color: "#52c41a", marginTop: 3 }} />
                  ) : s.status === "fail" ? (
                    <CloseCircleOutlined style={{ color: "#ff4d4f", marginTop: 3 }} />
                  ) : (
                    <ExclamationCircleOutlined style={{ color: "#faad14", marginTop: 3 }} />
                  )}
                  <div>
                    <Text strong>{s.step}</Text>
                    <Text type={s.status === "fail" ? "danger" : "secondary"} style={{ display: "block", fontSize: 12 }}>
                      {s.detail}
                    </Text>
                  </div>
                </div>
              ))}
              {testResult.overall === "success" && (
                <Alert type="success" message="所有步骤测试通过，SemRush 功能可正常使用" showIcon style={{ marginTop: 8 }} />
              )}
              {testResult.overall === "fail" && (
                <Alert type="error" message="连接测试未通过，请根据上方提示修正配置后重试" showIcon style={{ marginTop: 8 }} />
              )}
            </div>
          )}
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
