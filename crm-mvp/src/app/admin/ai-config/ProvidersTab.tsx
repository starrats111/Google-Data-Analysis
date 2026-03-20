"use client";

import { Table, Button, Modal, Form, Input, Select, Tag, Space, App, Popconfirm } from "antd";
import { PlusOutlined, EditOutlined, DeleteOutlined } from "@ant-design/icons";
import { useEffect, useState } from "react";

interface Provider {
  id: string;
  provider_name: string;
  api_key: string;
  api_base_url: string | null;
  status: string;
  created_at: string;
}

export default function AIProvidersTab() {
  const { message } = App.useApp();
  const [list, setList] = useState<Provider[]>([]);
  const [loading, setLoading] = useState(false);
  const [modalOpen, setModalOpen] = useState(false);
  const [editItem, setEditItem] = useState<Provider | null>(null);
  const [form] = Form.useForm();

  const fetchData = async () => {
    setLoading(true);
    const res = await fetch("/api/admin/ai-providers").then((r) => r.json());
    if (res.code === 0) setList(res.data);
    setLoading(false);
  };

  useEffect(() => { fetchData(); }, []);

  const handleCreate = () => { setEditItem(null); form.resetFields(); setModalOpen(true); };

  const handleEdit = (item: Provider) => {
    setEditItem(item);
    form.setFieldsValue({ provider_name: item.provider_name, api_key: item.api_key, api_base_url: item.api_base_url, status: item.status });
    setModalOpen(true);
  };

  const handleSubmit = async () => {
    const values = await form.validateFields();
    const method = editItem ? "PUT" : "POST";
    const body = editItem ? { id: editItem.id, ...values } : values;
    const res = await fetch("/api/admin/ai-providers", {
      method, headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
    }).then((r) => r.json());
    if (res.code === 0) { message.success(editItem ? "更新成功" : "创建成功"); setModalOpen(false); fetchData(); }
    else message.error(res.message);
  };

  const handleDelete = async (id: string) => {
    const res = await fetch("/api/admin/ai-providers", {
      method: "DELETE", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ id }),
    }).then((r) => r.json());
    if (res.code === 0) { message.success("删除成功"); fetchData(); } else message.error(res.message);
  };

  const columns = [
    { title: "ID", dataIndex: "id", width: 80 },
    { title: "供应商", dataIndex: "provider_name" },
    { title: "API Key", dataIndex: "api_key", render: (v: string) => v ? `${v.slice(0, 8)}...` : "-" },
    { title: "Base URL", dataIndex: "api_base_url", render: (v: string | null) => v || "默认" },
    { title: "状态", dataIndex: "status", render: (v: string) => <Tag color={v === "active" ? "green" : "default"}>{v === "active" ? "启用" : "禁用"}</Tag> },
    {
      title: "操作", render: (_: unknown, record: Provider) => (
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
        <Button type="primary" icon={<PlusOutlined />} onClick={handleCreate}>添加供应商</Button>
      </div>
      <Table columns={columns} dataSource={list} rowKey="id" loading={loading} />
      <Modal title={editItem ? "编辑供应商" : "添加供应商"} open={modalOpen} onOk={handleSubmit} onCancel={() => setModalOpen(false)}>
        <Form form={form} layout="vertical">
          <Form.Item name="provider_name" label="供应商名称" rules={[{ required: true }]}>
            <Select options={[
              { value: "openai", label: "OpenAI" },
              { value: "anthropic", label: "Anthropic" },
              { value: "deepseek", label: "DeepSeek" },
              { value: "google", label: "Google" },
            ]} />
          </Form.Item>
          <Form.Item name="api_key" label="API Key" rules={[{ required: true }]}>
            <Input.Password />
          </Form.Item>
          <Form.Item name="api_base_url" label="API Base URL（可选）">
            <Input placeholder="留空使用默认地址" />
          </Form.Item>
          {editItem && (
            <Form.Item name="status" label="状态">
              <Select options={[{ value: "active", label: "启用" }, { value: "disabled", label: "禁用" }]} />
            </Form.Item>
          )}
        </Form>
      </Modal>
    </div>
  );
}
