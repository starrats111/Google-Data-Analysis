"use client";

import { Table, Button, Modal, Form, Input, Select, InputNumber, Tag, Space, App, Popconfirm, Switch } from "antd";
import { PlusOutlined, EditOutlined, DeleteOutlined } from "@ant-design/icons";
import { useEffect, useState } from "react";
import { AI_SCENES } from "@/lib/constants";

interface ModelConfig {
  id: string;
  scene: string;
  provider_id: string;
  model_name: string;
  max_tokens: number;
  temperature: number;
  is_active: number;
  priority: number;
}

interface Provider { id: string; provider_name: string; }

type ApiEnvelope = { code: number; message?: string; data?: unknown };

async function readApiJson(res: Response): Promise<ApiEnvelope> {
  const text = await res.text();
  if (!text) {
    return {
      code: res.ok ? 0 : -1,
      message: res.ok ? "success" : `服务无响应内容 (${res.status})`,
      data: null,
    };
  }
  try {
    return JSON.parse(text) as ApiEnvelope;
  } catch {
    return {
      code: -1,
      message:
        res.status === 502 || res.status === 503 || res.status === 504
          ? `网关或服务暂时不可用 (${res.status})，请稍后重试`
          : `服务返回异常 (${res.status})，请稍后重试`,
      data: null,
    };
  }
}

export default function AIModelsTab() {
  const { message } = App.useApp();
  const [list, setList] = useState<ModelConfig[]>([]);
  const [providers, setProviders] = useState<Provider[]>([]);
  const [loading, setLoading] = useState(false);
  const [modalOpen, setModalOpen] = useState(false);
  const [editItem, setEditItem] = useState<ModelConfig | null>(null);
  const [form] = Form.useForm();

  const fetchData = async () => {
    setLoading(true);
    try {
      const r = await fetch("/api/admin/ai-models");
      const res = await readApiJson(r);
      if (res.code === 0 && res.data && typeof res.data === "object") {
        const d = res.data as { configs: ModelConfig[]; providers: Provider[] };
        setList(d.configs);
        setProviders(d.providers);
      } else if (res.code !== 0) {
        message.error(res.message ?? "加载失败");
      }
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { fetchData(); }, []);

  const handleCreate = () => { setEditItem(null); form.resetFields(); setModalOpen(true); };

  const handleEdit = (item: ModelConfig) => {
    setEditItem(item);
    form.setFieldsValue({ ...item, temperature: Number(item.temperature) });
    setModalOpen(true);
  };

  const handleSubmit = async () => {
    const values = await form.validateFields();
    const method = editItem ? "PUT" : "POST";
    const body = editItem ? { id: editItem.id, ...values } : values;
    const r = await fetch("/api/admin/ai-models", {
      method, headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
    });
    const res = await readApiJson(r);
    if (res.code === 0) {
      message.success(editItem ? "更新成功" : "创建成功");
      setModalOpen(false);
      fetchData();
    } else {
      message.error(res.message ?? "操作失败");
    }
  };

  const handleDelete = async (id: string) => {
    const r = await fetch("/api/admin/ai-models", {
      method: "DELETE", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ id }),
    });
    const res = await readApiJson(r);
    if (res.code === 0) {
      message.success("删除成功");
      fetchData();
    } else {
      message.error(res.message ?? "删除失败");
    }
  };

  const handleToggle = async (id: string, checked: boolean) => {
    const r = await fetch("/api/admin/ai-models", {
      method: "PUT", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id, is_active: checked ? 1 : 0 }),
    });
    const res = await readApiJson(r);
    if (res.code === 0) {
      fetchData();
    } else {
      message.error(res.message ?? "更新启用状态失败");
      fetchData();
    }
  };

  const sceneLabel = (v: string) => AI_SCENES.find((s) => s.value === v)?.label || v;
  const providerName = (id: string) => providers.find((p) => p.id === id)?.provider_name || id;

  const columns = [
    { title: "场景", dataIndex: "scene", render: (v: string) => <Tag color="blue">{sceneLabel(v)}</Tag> },
    { title: "供应商", dataIndex: "provider_id", render: (v: string) => providerName(v) },
    { title: "模型", dataIndex: "model_name" },
    { title: "优先级", dataIndex: "priority", width: 80 },
    { title: "Max Tokens", dataIndex: "max_tokens", width: 100 },
    { title: "Temperature", dataIndex: "temperature", width: 100, render: (v: number) => Number(v).toFixed(2) },
    { title: "启用", dataIndex: "is_active", width: 80, render: (v: number, record: ModelConfig) => <Switch checked={v === 1} onChange={(c) => handleToggle(record.id, c)} /> },
    {
      title: "操作", width: 160, render: (_: unknown, record: ModelConfig) => (
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
      <div style={{ display: "flex", justifyContent: "flex-end", marginBottom: 16 }}>
        <Button type="primary" icon={<PlusOutlined />} onClick={handleCreate}>添加配置</Button>
      </div>
      <Table columns={columns} dataSource={list} rowKey="id" loading={loading} />
      <Modal title={editItem ? "编辑模型配置" : "添加模型配置"} open={modalOpen} onOk={handleSubmit} onCancel={() => setModalOpen(false)} width={520}>
        <Form form={form} layout="vertical">
          <Form.Item name="scene" label="使用场景" rules={[{ required: true }]}>
            <Select options={AI_SCENES.map((s) => ({ value: s.value, label: s.label }))} />
          </Form.Item>
          <Form.Item name="provider_id" label="AI 供应商" rules={[{ required: true }]}>
            <Select options={providers.map((p) => ({ value: p.id, label: p.provider_name }))} />
          </Form.Item>
          <Form.Item name="model_name" label="模型名称" rules={[{ required: true }]}>
            <Input placeholder="如 claude-sonnet-4-20250514 / gpt-4o" />
          </Form.Item>
          <Space>
            <Form.Item name="priority" label="优先级" initialValue={1}>
              <InputNumber min={1} max={10} />
            </Form.Item>
            <Form.Item name="max_tokens" label="Max Tokens" initialValue={4096}>
              <InputNumber min={256} max={32768} step={256} />
            </Form.Item>
            <Form.Item name="temperature" label="Temperature" initialValue={0.7}>
              <InputNumber min={0} max={2} step={0.1} />
            </Form.Item>
          </Space>
        </Form>
      </Modal>
    </div>
  );
}
