"use client";

import {
  Table, Button, Modal, Form, Input, Select, Tag, Space, Typography,
  App, Popconfirm, Tabs,
} from "antd";
import type { ColumnsType } from "antd/es/table";
import { PlusOutlined, DeleteOutlined, EditOutlined } from "@ant-design/icons";
import { useState, useEffect, useCallback } from "react";
import AppPageHeader from "@/components/AppPageHeader";

const { Text, Paragraph } = Typography;

interface ParentNetwork {
  id: string;
  label: string;
  displayName: string | null;
  matchKeywords: string[];
  note: string | null;
  updatedAt: string;
}
interface BlacklistRule {
  id: string;
  platform: string;
  parentLabel: string;
  note: string | null;
  updatedAt: string;
}

export default function AffiliateNetworksPage() {
  const { message } = App.useApp();
  const [networks, setNetworks] = useState<ParentNetwork[]>([]);
  const [blacklist, setBlacklist] = useState<BlacklistRule[]>([]);
  const [loading, setLoading] = useState(true);

  const [pnModalOpen, setPnModalOpen] = useState(false);
  const [editPn, setEditPn] = useState<ParentNetwork | null>(null);
  const [pnForm] = Form.useForm();

  const [blModalOpen, setBlModalOpen] = useState(false);
  const [blForm] = Form.useForm();

  const fetchAll = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch("/api/admin/affiliate-networks").then((r) => r.json());
      if (res.code === 0) {
        setNetworks(res.data.networks);
        setBlacklist(res.data.blacklist);
      } else {
        message.error(res.message || "加载失败");
      }
    } finally {
      setLoading(false);
    }
  }, [message]);

  useEffect(() => { fetchAll(); }, [fetchAll]);

  // ───── 上级联盟 ─────
  const openPnModal = (pn?: ParentNetwork) => {
    setEditPn(pn || null);
    pnForm.resetFields();
    pnForm.setFieldsValue({
      label: pn?.displayName || pn?.label || "",
      match_keywords: pn ? pn.matchKeywords.join(", ") : "",
      note: pn?.note || "",
    });
    setPnModalOpen(true);
  };

  const savePn = async () => {
    const v = await pnForm.validateFields();
    try {
      const res = await fetch("/api/admin/affiliate-networks", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ kind: "parent", label: v.label, match_keywords: v.match_keywords, note: v.note }),
      }).then((r) => r.json());
      if (res.code === 0) {
        message.success("已保存");
        setPnModalOpen(false);
        fetchAll();
      } else {
        message.error(res.message || "保存失败");
      }
    } catch {
      message.error("网络异常，请重试");
    }
  };

  const deletePn = async (id: string) => {
    try {
      const res = await fetch("/api/admin/affiliate-networks", {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ kind: "parent", id }),
      }).then((r) => r.json());
      if (res.code === 0) { message.success("已删除"); fetchAll(); }
      else message.error(res.message || "删除失败");
    } catch {
      message.error("网络异常，请重试");
    }
  };

  // ───── 黑名单 ─────
  const saveBl = async () => {
    const v = await blForm.validateFields();
    try {
      const res = await fetch("/api/admin/affiliate-networks", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ kind: "blacklist", platform: v.platform, parent_label: v.parent_label, note: v.note }),
      }).then((r) => r.json());
      if (res.code === 0) { message.success("已保存"); setBlModalOpen(false); blForm.resetFields(); fetchAll(); }
      else message.error(res.message || "保存失败");
    } catch {
      message.error("网络异常，请重试");
    }
  };

  const deleteBl = async (id: string) => {
    try {
      const res = await fetch("/api/admin/affiliate-networks", {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ kind: "blacklist", id }),
      }).then((r) => r.json());
      if (res.code === 0) { message.success("已删除"); fetchAll(); }
      else message.error(res.message || "删除失败");
    } catch {
      message.error("网络异常，请重试");
    }
  };

  const pnColumns: ColumnsType<ParentNetwork> = [
    { title: "上级联盟", dataIndex: "displayName", render: (v, r) => <Text strong>{v || r.label}</Text> },
    { title: "label", dataIndex: "label", render: (v) => <Tag>{v}</Tag> },
    {
      title: "识别关键词",
      dataIndex: "matchKeywords",
      render: (kws: string[]) => (
        <Space size={[4, 4]} wrap>
          {kws.map((k) => <Tag key={k} color="blue">{k}</Tag>)}
        </Space>
      ),
    },
    { title: "备注", dataIndex: "note", render: (v) => v || "-" },
    {
      title: "操作",
      width: 140,
      render: (_, r) => (
        <Space>
          <Button size="small" icon={<EditOutlined />} onClick={() => openPnModal(r)}>编辑</Button>
          <Popconfirm title="删除该上级联盟？关联黑名单也会停用" onConfirm={() => deletePn(r.id)}>
            <Button size="small" danger icon={<DeleteOutlined />} />
          </Popconfirm>
        </Space>
      ),
    },
  ];

  const blColumns: ColumnsType<BlacklistRule> = [
    { title: "平台", dataIndex: "platform", render: (v) => <Tag color={v === "*" ? "red" : "geekblue"}>{v === "*" ? "全平台" : v}</Tag> },
    { title: "禁跑上级联盟", dataIndex: "parentLabel", render: (v) => <Tag color="volcano">{v}</Tag> },
    { title: "备注", dataIndex: "note", render: (v) => v || "-" },
    {
      title: "操作",
      width: 90,
      render: (_, r) => (
        <Popconfirm title="移除该黑名单规则？" onConfirm={() => deleteBl(r.id)}>
          <Button size="small" danger icon={<DeleteOutlined />} />
        </Popconfirm>
      ),
    },
  ];

  return (
    <div>
      <AppPageHeader title="上级联盟与黑名单" subtitle="创建广告时按投放国巡航联盟追踪链接，识别上级联盟并拦截黑名单平台" />
      <Paragraph type="secondary" style={{ marginTop: 8 }}>
        创建广告（提交到 Google Ads）时，系统会自动沿投放国代理跟随商家联盟追踪链接的整条跳转链，
        识别其所属<Text strong>上级联盟</Text>；若该上级联盟在对应平台的黑名单内，则<Text strong>硬拦截不予投放</Text>。
        关键词命中规则：整条跳转链（不区分大小写）包含任一关键词即判定属于该上级联盟。
      </Paragraph>
      <Tabs
        defaultActiveKey="networks"
        items={[
          {
            key: "networks",
            label: `上级联盟库 (${networks.length})`,
            children: (
              <>
                <Button type="primary" icon={<PlusOutlined />} style={{ marginBottom: 12 }} onClick={() => openPnModal()}>
                  新增上级联盟
                </Button>
                <Table rowKey="id" loading={loading} columns={pnColumns} dataSource={networks} size="small" pagination={{ pageSize: 20 }} />
              </>
            ),
          },
          {
            key: "blacklist",
            label: `平台黑名单 (${blacklist.length})`,
            children: (
              <>
                <Button type="primary" icon={<PlusOutlined />} style={{ marginBottom: 12 }} onClick={() => { blForm.resetFields(); setBlModalOpen(true); }}>
                  新增黑名单规则
                </Button>
                <Table rowKey="id" loading={loading} columns={blColumns} dataSource={blacklist} size="small" pagination={{ pageSize: 20 }} />
              </>
            ),
          },
        ]}
      />

      <Modal title={editPn ? "编辑上级联盟" : "新增上级联盟"} open={pnModalOpen} onOk={savePn} onCancel={() => setPnModalOpen(false)} destroyOnClose>
        <Form form={pnForm} layout="vertical">
          <Form.Item name="label" label="上级联盟名字" rules={[{ required: true, message: "必填" }]}>
            <Input placeholder="如 Awin / Impact / CJ" disabled={!!editPn} />
          </Form.Item>
          <Form.Item name="match_keywords" label="识别关键词（逗号或换行分隔）" extra="含跳板域名/特征参数，如 awin1.com, zenaps.com">
            <Input.TextArea rows={3} placeholder="awin1.com, zenaps.com, dwin1.com" />
          </Form.Item>
          <Form.Item name="note" label="备注">
            <Input />
          </Form.Item>
        </Form>
      </Modal>

      <Modal title="新增黑名单规则" open={blModalOpen} onOk={saveBl} onCancel={() => setBlModalOpen(false)} destroyOnClose>
        <Form form={blForm} layout="vertical">
          <Form.Item name="platform" label="平台代号" extra="* 表示全平台；如 LH / CG / FP（与商家 platform 字段一致）" initialValue="*">
            <Input placeholder="*" />
          </Form.Item>
          <Form.Item name="parent_label" label="禁跑上级联盟" rules={[{ required: true, message: "必选" }]}>
            <Select
              showSearch
              placeholder="选择上级联盟 label"
              options={networks.map((n) => ({ value: n.label, label: `${n.displayName || n.label} (${n.label})` }))}
            />
          </Form.Item>
          <Form.Item name="note" label="备注">
            <Input />
          </Form.Item>
        </Form>
      </Modal>
    </div>
  );
}
