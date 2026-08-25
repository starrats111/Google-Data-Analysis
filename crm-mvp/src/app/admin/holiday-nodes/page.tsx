"use client";

// D-278：海外节点推荐管理——节点日历 CRUD + 各节点商家清单 Excel 导入。
// 节点过后把 node_date 改成下一届日期即可复用（提醒窗口自动复位）。

import {
  Card, Table, Button, Input, InputNumber, Space, Tag, Typography, Popconfirm, App,
  Modal, Form, DatePicker, Select, Switch, Upload, Tooltip,
} from "antd";
import { PlusOutlined, ReloadOutlined, EditOutlined, DeleteOutlined, UploadOutlined, CalendarOutlined, FireOutlined } from "@ant-design/icons";
import { useEffect, useState, useCallback } from "react";
import AppPageHeader from "@/components/AppPageHeader";
import { CATEGORY_CN, catCn } from "@/lib/category-cn";
import dayjs from "dayjs";

const { Text } = Typography;

interface NodeRow {
  id: string;
  code: string;
  name: string;
  node_date: string;
  countries: string | null;
  lead_days: number;
  categories: string[] | null;
  description: string | null;
  enabled: number;
  notified_at: string | null;
  list_count: number;
  days_until: number;
}

const CATEGORY_OPTIONS = Object.entries(CATEGORY_CN).map(([k, v]) => ({ value: k, label: `${v} (${k})` }));

export default function HolidayNodesPage() {
  const { message } = App.useApp();
  const [rows, setRows] = useState<NodeRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [modalOpen, setModalOpen] = useState(false);
  const [editing, setEditing] = useState<NodeRow | null>(null);
  const [saving, setSaving] = useState(false);
  const [uploadingCode, setUploadingCode] = useState<string | null>(null);
  const [form] = Form.useForm();

  const fetchRows = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch("/api/admin/holiday-nodes").then((r) => r.json());
      if (res.code === 0) setRows(res.data.items);
      else message.error(res.message || "加载节点列表失败");
    } catch {
      message.error("加载节点列表失败，请刷新重试");
    } finally {
      setLoading(false);
    }
  }, [message]);

  useEffect(() => { fetchRows(); }, [fetchRows]);

  const openModal = (row: NodeRow | null) => {
    setEditing(row);
    if (row) {
      form.setFieldsValue({
        code: row.code,
        name: row.name,
        node_date: dayjs(row.node_date),
        countries: row.countries || "",
        lead_days: row.lead_days,
        categories: row.categories || [],
        description: row.description || "",
        enabled: row.enabled === 1,
      });
    } else {
      form.resetFields();
      form.setFieldsValue({ lead_days: 30, enabled: true });
    }
    setModalOpen(true);
  };

  const handleSave = async () => {
    const values = await form.validateFields();
    setSaving(true);
    try {
      const res = await fetch("/api/admin/holiday-nodes", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          ...(editing ? { id: editing.id } : { code: values.code }),
          name: values.name,
          node_date: values.node_date.format("YYYY-MM-DD"),
          countries: values.countries || null,
          lead_days: values.lead_days,
          categories: values.categories || [],
          description: values.description || null,
          enabled: values.enabled ? 1 : 0,
        }),
      }).then((r) => r.json());
      if (res.code === 0) {
        message.success(res.message || "已保存");
        setModalOpen(false);
        fetchRows();
      } else message.error(res.message);
    } catch {
      message.error("网络异常，保存失败，请重试");
    } finally {
      setSaving(false);
    }
  };

  const handleDelete = async (id: string) => {
    try {
      const res = await fetch(`/api/admin/holiday-nodes?id=${id}`, { method: "DELETE" }).then((r) => r.json());
      if (res.code === 0) { message.success("已删除"); fetchRows(); }
      else message.error(res.message);
    } catch {
      message.error("网络异常，删除失败");
    }
  };

  const handleUpload = async (code: string, file: File) => {
    setUploadingCode(code);
    try {
      const fd = new FormData();
      fd.append("node_code", code);
      fd.append("files", file);
      const res = await fetch("/api/admin/holiday-nodes/import", { method: "POST", body: fd }).then((r) => r.json());
      if (res.code === 0) { message.success(res.message || "导入成功"); fetchRows(); }
      else message.error(res.message || "导入失败");
    } catch {
      message.error("网络异常，导入失败");
    } finally {
      setUploadingCode(null);
    }
  };

  const columns = [
    { title: "节点", dataIndex: "name", width: 150,
      render: (v: string, r: NodeRow) => (
        <Space size={4}>
          {r.days_until >= 0 && r.days_until <= r.lead_days && <FireOutlined style={{ color: "#fa541c" }} />}
          <span style={{ fontWeight: 600 }}>{v}</span>
          <Text type="secondary" style={{ fontSize: 11 }}>{r.code}</Text>
        </Space>
      ),
    },
    { title: "日期", dataIndex: "node_date", width: 110, render: (v: string) => v?.slice(0, 10) },
    { title: "倒计时", dataIndex: "days_until", width: 90, align: "right" as const,
      render: (v: number) => v >= 0 ? <Tag color={v <= 30 ? "volcano" : "default"}>{v} 天</Tag> : <Tag>已过 {-v} 天</Tag>,
    },
    { title: "主要市场", dataIndex: "countries", width: 130, ellipsis: true, render: (v: string | null) => v || <Text type="secondary">通用</Text> },
    { title: "提前提醒", dataIndex: "lead_days", width: 80, align: "right" as const, render: (v: number) => `${v} 天` },
    { title: "推荐品类", dataIndex: "categories", width: 220,
      render: (v: string[] | null) => (v && v.length > 0)
        ? <Space size={2} wrap>{v.map((c) => <Tag key={c} style={{ margin: 0, fontSize: 11 }}>{catCn(c)}</Tag>)}</Space>
        : <Text type="secondary" style={{ fontSize: 12 }}>待确认（扩展层不展示）</Text>,
    },
    { title: "清单商家", dataIndex: "list_count", width: 90, align: "right" as const,
      render: (v: number) => v > 0 ? <Tag color="green">{v}</Tag> : "-",
    },
    { title: "已提醒", dataIndex: "notified_at", width: 100,
      render: (v: string | null) => v ? <Tooltip title={`本届已于 ${v}（库存 UTC）群发过`}><Tag color="blue">已发</Tag></Tooltip> : "-",
    },
    { title: "启用", dataIndex: "enabled", width: 60, render: (v: number) => v === 1 ? <Tag color="green">是</Tag> : <Tag>否</Tag> },
    { title: "操作", key: "action", width: 210,
      render: (_: unknown, r: NodeRow) => (
        <Space size={4}>
          <Button size="small" icon={<EditOutlined />} onClick={() => openModal(r)}>编辑</Button>
          <Upload accept=".xlsx,.xls" showUploadList={false}
            beforeUpload={(file) => { handleUpload(r.code, file); return false; }}>
            <Button size="small" icon={<UploadOutlined />} loading={uploadingCode === r.code}>导清单</Button>
          </Upload>
          <Popconfirm title="确定删除该节点？清单商家会一并从专区消失" onConfirm={() => handleDelete(r.id)}>
            <Button size="small" danger icon={<DeleteOutlined />} />
          </Popconfirm>
        </Space>
      ),
    },
  ];

  return (
    <div style={{ maxWidth: 1400, margin: "0 auto" }}>
      <AppPageHeader icon={<CalendarOutlined />} title="节点推荐管理"
        subtitle="海外重大时间节点日历：配置节点、导入官方推荐商家清单；节点前按提前天数全员站内提醒" />
      <Card
        title="节点日历"
        extra={<Space>
          <Button icon={<ReloadOutlined />} onClick={fetchRows}>刷新</Button>
          <Button type="primary" icon={<PlusOutlined />} onClick={() => openModal(null)}>新建节点</Button>
        </Space>}
      >
        <div style={{ marginBottom: 12, padding: "8px 12px", background: "#f6ffed", border: "1px solid #b7eb8f", borderRadius: 6, fontSize: 12, color: "#666" }}>
          清单 Excel 支持两种表头：LH 节点清单格式（BU/Mcid/MID/商家名称/Website/下单地区/媒体EPC/媒体佣金比例/媒体每单平均佣金）
          和标准推荐清单格式（mcid/MID/名称/联盟/网址/商家地区/EPC/佣金上限/平均佣金率/平均带单佣金）。
          导入是按节点替换式的：重传只覆盖该节点自己的清单。节点过后把日期改成下一届即可复用，提醒会自动复位。
        </div>
        <Table rowKey="id" loading={loading} dataSource={rows} columns={columns} size="small"
          pagination={false} scroll={{ x: 1250 }} />
      </Card>

      <Modal title={editing ? `编辑节点：${editing.name}` : "新建节点"} open={modalOpen}
        onCancel={() => setModalOpen(false)} onOk={handleSave} confirmLoading={saving} destroyOnHidden width={560}>
        <Form form={form} layout="vertical" size="small">
          {!editing && (
            <Form.Item name="code" label="代码（小写字母/数字/下划线，建成后不可改）"
              rules={[{ required: true, pattern: /^[a-z0-9_]{2,32}$/, message: "格式：小写字母/数字/下划线，2-32 位" }]}>
              <Input placeholder="如 singles_day" />
            </Form.Item>
          )}
          <Form.Item name="name" label="节点名称" rules={[{ required: true, message: "必填" }]}>
            <Input placeholder="如 双十一" />
          </Form.Item>
          <Form.Item name="node_date" label="本届日期（节点过后改成下一届日期即可复用）" rules={[{ required: true, message: "必填" }]}>
            <DatePicker style={{ width: "100%" }} />
          </Form.Item>
          <Form.Item name="countries" label="主要市场（国家代码 CSV，留空=通用）">
            <Input placeholder="如 US,GB,CA" />
          </Form.Item>
          <Form.Item name="lead_days" label="提前提醒天数" rules={[{ required: true, message: "必填" }]}>
            <InputNumber min={1} max={120} style={{ width: "100%" }} />
          </Form.Item>
          <Form.Item name="categories" label="推荐品类（品类扩展层按它圈库内同类商家；留空则扩展层显示待确认）">
            <Select mode="multiple" allowClear options={CATEGORY_OPTIONS} placeholder="从统一品类表选择" />
          </Form.Item>
          <Form.Item name="description" label="说明（展示在专区提示条里）">
            <Input.TextArea rows={2} maxLength={512} />
          </Form.Item>
          <Form.Item name="enabled" label="启用" valuePropName="checked">
            <Switch />
          </Form.Item>
        </Form>
      </Modal>
    </div>
  );
}
