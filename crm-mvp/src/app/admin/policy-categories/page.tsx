"use client";

import { useState, useEffect, useCallback } from "react";
import {
  Card, Table, Button, Space, Tag, Modal, Form, Input, Select, Switch,
  Popconfirm, Typography, Tooltip, App,
} from "antd";
import {
  PlusOutlined, EditOutlined, DeleteOutlined, AuditOutlined, SyncOutlined,
} from "@ant-design/icons";
import { RESTRICTION_LEVELS } from "@/lib/constants";

const { Text } = Typography;
const { TextArea } = Input;

interface PolicyCategory {
  id: string;
  category_code: string;
  category_name: string;
  category_name_en: string;
  restriction_level: string;
  description: string | null;
  age_targeting: string | null;
  requires_cert: number;
  match_keywords: string[] | null;
  match_domains: string[] | null;
  sort_order: number;
  created_at: string;
}

export default function PolicyCategoriesPage() {
  const { message, modal } = App.useApp();
  const [categories, setCategories] = useState<PolicyCategory[]>([]);
  const [loading, setLoading] = useState(false);
  const [modalOpen, setModalOpen] = useState(false);
  const [editing, setEditing] = useState<PolicyCategory | null>(null);
  const [form] = Form.useForm();
  const [reviewing, setReviewing] = useState(false);

  const fetchCategories = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch("/api/admin/policy-categories").then((r) => r.json());
      if (res.code === 0) setCategories(res.data || []);
    } catch { /* ignore */ }
    setLoading(false);
  }, []);

  useEffect(() => { fetchCategories(); }, [fetchCategories]);

  // 全量审核所有商家
  const handleBatchReview = async () => {
    setReviewing(true);
    try {
      const res = await fetch("/api/admin/policy-review", { method: "POST" }).then((r) => r.json());
      if (res.code === 0) {
        message.success(res.message || "审核完成");
        modal.info({
          title: "全量政策审核结果",
          content: (
            <div style={{ lineHeight: 2 }}>
              <p>总商家数：<strong>{res.data.total}</strong></p>
              <p>已审核：<strong>{res.data.reviewed}</strong></p>
              <p style={{ color: "#fa8c16" }}>限制类（可投放）：<strong>{res.data.restricted}</strong></p>
              <p style={{ color: "#f5222d" }}>禁止类（不可投放）：<strong>{res.data.prohibited}</strong></p>
              <p style={{ color: "#52c41a" }}>无限制：<strong>{res.data.clean}</strong></p>
            </div>
          ),
        });
      } else {
        message.error(res.message);
      }
    } catch {
      message.error("审核请求失败");
    }
    setReviewing(false);
  };

  const openCreate = () => {
    setEditing(null);
    form.resetFields();
    form.setFieldsValue({ restriction_level: "restricted", requires_cert: false, sort_order: 0 });
    setModalOpen(true);
  };

  const openEdit = (record: PolicyCategory) => {
    setEditing(record);
    const kw = record.match_keywords;
    const dm = record.match_domains;
    const kwArr = typeof kw === "string" ? JSON.parse(kw) : (kw || []);
    const dmArr = typeof dm === "string" ? JSON.parse(dm) : (dm || []);
    form.setFieldsValue({
      ...record,
      requires_cert: record.requires_cert === 1,
      match_keywords: kwArr.join(", "),
      match_domains: dmArr.join(", "),
    });
    setModalOpen(true);
  };

  const handleSubmit = async () => {
    const values = await form.validateFields();
    // 解析逗号分隔的关键词和域名
    const data = {
      ...values,
      requires_cert: values.requires_cert ? 1 : 0,
      match_keywords: values.match_keywords
        ? values.match_keywords.split(/[,，\n]/).map((s: string) => s.trim()).filter(Boolean)
        : [],
      match_domains: values.match_domains
        ? values.match_domains.split(/[,，\n]/).map((s: string) => s.trim()).filter(Boolean)
        : [],
    };

    const url = "/api/admin/policy-categories";
    const method = editing ? "PUT" : "POST";
    if (editing) data.id = editing.id;

    const res = await fetch(url, {
      method,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(data),
    }).then((r) => r.json());

    if (res.code === 0) {
      message.success(editing ? "更新成功" : "创建成功");
      setModalOpen(false);
      fetchCategories();
    } else {
      message.error(res.message);
    }
  };

  const handleDelete = async (id: string) => {
    const res = await fetch(`/api/admin/policy-categories?id=${id}`, { method: "DELETE" }).then((r) => r.json());
    if (res.code === 0) {
      message.success("删除成功");
      fetchCategories();
    } else {
      message.error(res.message);
    }
  };

  const columns = [
    {
      title: "类别代码", dataIndex: "category_code", width: 120,
      render: (v: string) => <Tag style={{ fontFamily: "monospace" }}>{v}</Tag>,
    },
    { title: "中文名", dataIndex: "category_name", width: 100 },
    { title: "英文名", dataIndex: "category_name_en", width: 140 },
    {
      title: "限制等级", dataIndex: "restriction_level", width: 120,
      render: (v: string) => (
        <Tag color={v === "prohibited" ? "red" : "orange"}>
          {v === "prohibited" ? "⛔ 禁止投放" : "⚠️ 有限制"}
        </Tag>
      ),
    },
    {
      title: "年龄限制", dataIndex: "age_targeting", width: 80,
      render: (v: string | null) => v || "-",
    },
    {
      title: "需认证", dataIndex: "requires_cert", width: 70,
      render: (v: number) => v ? <Tag color="blue">是</Tag> : "-",
    },
    {
      title: "匹配关键词", dataIndex: "match_keywords", width: 200, ellipsis: true,
      render: (v: string[] | string | null) => {
        if (!v) return "-";
        const arr = typeof v === "string" ? JSON.parse(v) : v;
        if (!Array.isArray(arr) || arr.length === 0) return "-";
        const display = arr.slice(0, 5).join(", ");
        return (
          <Tooltip title={arr.join(", ")}>
            <span>{display}{arr.length > 5 ? ` +${arr.length - 5}` : ""}</span>
          </Tooltip>
        );
      },
    },
    {
      title: "匹配域名", dataIndex: "match_domains", width: 180, ellipsis: true,
      render: (v: string[] | string | null) => {
        if (!v) return "-";
        const arr = typeof v === "string" ? JSON.parse(v) : v;
        if (!Array.isArray(arr) || arr.length === 0) return "-";
        return (
          <Tooltip title={arr.join(", ")}>
            <span>{arr.slice(0, 3).join(", ")}{arr.length > 3 ? ` +${arr.length - 3}` : ""}</span>
          </Tooltip>
        );
      },
    },
    { title: "排序", dataIndex: "sort_order", width: 60 },
    {
      title: "操作", width: 120,
      render: (_: unknown, record: PolicyCategory) => (
        <Space size={4}>
          <Button type="link" size="small" icon={<EditOutlined />} onClick={() => openEdit(record)}>编辑</Button>
          <Popconfirm title="确认删除此政策类别？" onConfirm={() => handleDelete(record.id)}>
            <Button type="link" size="small" danger icon={<DeleteOutlined />}>删除</Button>
          </Popconfirm>
        </Space>
      ),
    },
  ];

  return (
    <div>
      <Card
        title={<><AuditOutlined /> Google Ads 政策类别管理</>}
        extra={
          <Space>
            <Popconfirm
              title="全量审核所有商家"
              description="将根据当前政策类别的关键词和域名规则，重新审核所有商家并更新标签。确认执行？"
              onConfirm={handleBatchReview}
              okText="确认执行"
              cancelText="取消"
            >
              <Button icon={<SyncOutlined spin={reviewing} />} loading={reviewing}>
                全量审核商家
              </Button>
            </Popconfirm>
            <Button type="primary" icon={<PlusOutlined />} onClick={openCreate}>
              新增类别
            </Button>
          </Space>
        }
      >
        <div style={{ marginBottom: 12 }}>
          <Text type="secondary" style={{ fontSize: 13 }}>
            管理 Google Ads 广告政策限制类别。商家同步时会自动根据关键词和域名匹配政策类别，标记为"限制"或"禁止"。
          </Text>
        </div>
        <Table
          rowKey="id"
          loading={loading}
          dataSource={categories}
          columns={columns}
          size="small"
          scroll={{ x: 1200 }}
          pagination={false}
        />
      </Card>

      <Modal
        title={editing ? "编辑政策类别" : "新增政策类别"}
        open={modalOpen}
        onOk={handleSubmit}
        onCancel={() => setModalOpen(false)}
        width={640}
        okText={editing ? "保存" : "创建"}
      >
        <Form form={form} layout="vertical" size="small">
          <Form.Item name="category_code" label="类别代码" rules={[{ required: true, message: "请输入类别代码" }]}
            extra="英文小写，如 alcohol, gambling">
            <Input placeholder="alcohol" disabled={!!editing} />
          </Form.Item>
          <Space style={{ width: "100%" }} size={12}>
            <Form.Item name="category_name" label="中文名" rules={[{ required: true }]} style={{ flex: 1 }}>
              <Input placeholder="酒精类" />
            </Form.Item>
            <Form.Item name="category_name_en" label="英文名" style={{ flex: 1 }}>
              <Input placeholder="Alcohol" />
            </Form.Item>
          </Space>
          <Space style={{ width: "100%" }} size={12}>
            <Form.Item name="restriction_level" label="限制等级" rules={[{ required: true }]} style={{ flex: 1 }}>
              <Select options={RESTRICTION_LEVELS.map((r) => ({ value: r.value, label: r.label }))} />
            </Form.Item>
            <Form.Item name="age_targeting" label="年龄限制" style={{ flex: 1 }}>
              <Select allowClear placeholder="无" options={[
                { value: "18+", label: "18+" },
                { value: "21+", label: "21+" },
              ]} />
            </Form.Item>
            <Form.Item name="requires_cert" label="需Google认证" valuePropName="checked" style={{ flex: 1 }}>
              <Switch />
            </Form.Item>
          </Space>
          <Form.Item name="description" label="政策说明">
            <TextArea rows={2} placeholder="该类别的 Google Ads 政策说明..." />
          </Form.Item>
          <Form.Item name="match_keywords" label="匹配关键词" extra="逗号分隔，用于自动匹配商家名称/类别/域名">
            <TextArea rows={3} placeholder="alcohol, wine, beer, liquor, spirits, brewery..." />
          </Form.Item>
          <Form.Item name="match_domains" label="匹配域名" extra="逗号分隔，精确匹配商家域名">
            <TextArea rows={2} placeholder="wine.com, totalwine.com, drizly.com..." />
          </Form.Item>
          <Form.Item name="sort_order" label="排序">
            <Input type="number" placeholder="0" style={{ width: 100 }} />
          </Form.Item>
        </Form>
      </Modal>
    </div>
  );
}
