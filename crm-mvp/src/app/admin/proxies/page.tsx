"use client";

import {
  Table, Button, Modal, Form, Input, Select, Tag, Space, Typography,
  App, Popconfirm, Switch, InputNumber, Tabs,
} from "antd";
import type { ColumnsType } from "antd/es/table";
import {
  PlusOutlined, EditOutlined, DeleteOutlined, TeamOutlined,
  GlobalOutlined, CheckCircleOutlined,
} from "@ant-design/icons";
import { useState, useEffect, useCallback } from "react";

const { Title, Text } = Typography;

interface Proxy {
  id: string;
  name: string;
  host: string;
  port: number;
  proxyType: string;
  priority: number;
  status: string;
  userCount: number;
  createdAt: string;
}

interface ProxyUser {
  bindingId: string;
  userId: string;
  username: string;
  displayName: string | null;
  createdAt: string;
}

interface AllUser {
  id: string;
  username: string;
  display_name: string | null;
}

export default function ProxiesPage() {
  const { message } = App.useApp();
  const [proxies, setProxies] = useState<Proxy[]>([]);
  const [loading, setLoading] = useState(true);
  const [modalOpen, setModalOpen] = useState(false);
  const [editProxy, setEditProxy] = useState<Proxy | null>(null);
  const [form] = Form.useForm();

  // 用户绑定 Modal
  const [bindModalOpen, setBindModalOpen] = useState(false);
  const [selectedProxy, setSelectedProxy] = useState<Proxy | null>(null);
  const [proxyUsers, setProxyUsers] = useState<ProxyUser[]>([]);
  const [allUsers, setAllUsers] = useState<AllUser[]>([]);
  const [bindUserId, setBindUserId] = useState<string | null>(null);
  const [bindLoading, setBindLoading] = useState(false);

  const fetchProxies = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch("/api/admin/proxies").then((r) => r.json());
      if (res.code === 0) setProxies(res.data);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { fetchProxies(); }, [fetchProxies]);

  const fetchAllUsers = async () => {
    const res = await fetch("/api/admin/users").then((r) => r.json());
    const list = res.data?.list ?? res.data ?? [];
    setAllUsers(list);
  };

  const fetchProxyUsers = async (proxyId: string) => {
    const res = await fetch(`/api/admin/proxies/users?proxyId=${proxyId}`).then((r) => r.json());
    if (res.code === 0) setProxyUsers(res.data);
  };

  const openBindModal = async (proxy: Proxy) => {
    setSelectedProxy(proxy);
    setBindUserId(null);
    await Promise.all([fetchProxyUsers(proxy.id), fetchAllUsers()]);
    setBindModalOpen(true);
  };

  const handleSave = async () => {
    const values = await form.validateFields();
    const isEdit = !!editProxy;
    const body = isEdit
      ? { id: editProxy!.id, ...values, port: Number(values.port), priority: Number(values.priority) }
      : { ...values, port: Number(values.port), priority: Number(values.priority) };

    const res = await fetch("/api/admin/proxies", {
      method: isEdit ? "PUT" : "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    }).then((r) => r.json());

    if (res.code === 0) {
      message.success(isEdit ? "已更新" : "已创建");
      setModalOpen(false);
      fetchProxies();
    } else {
      message.error(res.message ?? "操作失败");
    }
  };

  const handleDelete = async (id: string) => {
    const res = await fetch("/api/admin/proxies", {
      method: "DELETE",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id }),
    }).then((r) => r.json());
    if (res.code === 0) { message.success("已删除"); fetchProxies(); }
    else message.error(res.message ?? "删除失败");
  };

  const handleToggleStatus = async (proxy: Proxy) => {
    const newStatus = proxy.status === "active" ? "disabled" : "active";
    const res = await fetch("/api/admin/proxies", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id: proxy.id, status: newStatus }),
    }).then((r) => r.json());
    if (res.code === 0) fetchProxies();
    else message.error(res.message ?? "切换失败");
  };

  const handleBind = async () => {
    if (!bindUserId || !selectedProxy) return;
    setBindLoading(true);
    try {
      const res = await fetch("/api/admin/proxies/users", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ proxyId: selectedProxy.id, userId: bindUserId }),
      }).then((r) => r.json());
      if (res.code === 0) {
        message.success("绑定成功");
        setBindUserId(null);
        fetchProxyUsers(selectedProxy.id);
      } else {
        message.error(res.message ?? "绑定失败");
      }
    } finally {
      setBindLoading(false);
    }
  };

  const handleUnbind = async (bindingId: string) => {
    const res = await fetch("/api/admin/proxies/users", {
      method: "DELETE",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ bindingId }),
    }).then((r) => r.json());
    if (res.code === 0) {
      message.success("已解绑");
      if (selectedProxy) fetchProxyUsers(selectedProxy.id);
    } else {
      message.error(res.message ?? "解绑失败");
    }
  };

  const columns: ColumnsType<Proxy> = [
    {
      title: "代理名称",
      dataIndex: "name",
      render: (name: string) => <Text strong>{name}</Text>,
    },
    {
      title: "地址",
      key: "address",
      render: (_: unknown, row) => (
        <Text style={{ fontFamily: "monospace", fontSize: 13 }}>
          {row.host}:{row.port}
        </Text>
      ),
    },
    {
      title: "类型",
      dataIndex: "proxyType",
      render: (t: string) => <Tag>{t.toUpperCase()}</Tag>,
    },
    {
      title: "优先级",
      dataIndex: "priority",
      sorter: (a, b) => a.priority - b.priority,
    },
    {
      title: "状态",
      dataIndex: "status",
      render: (status: string, row) => (
        <Switch
          size="small"
          checked={status === "active"}
          checkedChildren="启用"
          unCheckedChildren="停用"
          onChange={() => handleToggleStatus(row)}
        />
      ),
    },
    {
      title: "绑定用户",
      dataIndex: "userCount",
      render: (count: number) => <Tag icon={<TeamOutlined />}>{count} 人</Tag>,
    },
    {
      title: "操作",
      key: "actions",
      render: (_: unknown, row) => (
        <Space>
          <Button
            size="small"
            icon={<TeamOutlined />}
            onClick={() => openBindModal(row)}
          >
            分配用户
          </Button>
          <Button
            size="small"
            icon={<EditOutlined />}
            onClick={() => {
              setEditProxy(row);
              form.setFieldsValue({
                name: row.name, host: row.host, port: row.port,
                proxyType: row.proxyType, priority: row.priority, status: row.status,
              });
              setModalOpen(true);
            }}
          >
            编辑
          </Button>
          <Popconfirm title="确认删除此代理？" onConfirm={() => handleDelete(row.id)}>
            <Button size="small" danger icon={<DeleteOutlined />}>删除</Button>
          </Popconfirm>
        </Space>
      ),
    },
  ];

  // 用户绑定 Modal 里的已绑定用户 id 集合
  const boundUserIds = new Set(proxyUsers.map((u) => u.userId));
  const availableUsers = allUsers.filter((u) => !boundUserIds.has(u.id));

  return (
    <div>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 16 }}>
        <Title level={4} style={{ margin: 0 }}>
          <GlobalOutlined /> 代理管理
        </Title>
        <Button
          type="primary"
          icon={<PlusOutlined />}
          onClick={() => {
            setEditProxy(null);
            form.resetFields();
            form.setFieldsValue({ proxyType: "http", priority: 5, status: "active" });
            setModalOpen(true);
          }}
        >
          添加代理
        </Button>
      </div>

      <Table
        columns={columns}
        dataSource={proxies}
        rowKey="id"
        loading={loading}
        size="small"
        pagination={{ pageSize: 20, showTotal: (t) => `共 ${t} 条` }}
      />

      {/* 新建/编辑 Modal */}
      <Modal
        title={editProxy ? "编辑代理" : "添加代理"}
        open={modalOpen}
        onOk={handleSave}
        onCancel={() => { setModalOpen(false); setEditProxy(null); }}
        okText="保存"
      >
        <Form form={form} layout="vertical">
          <Form.Item name="name" label="代理名称" rules={[{ required: true }]}>
            <Input placeholder="如 cliproxy-01" />
          </Form.Item>
          <Form.Item name="host" label="服务器地址" rules={[{ required: true }]}>
            <Input placeholder="如 proxy.example.com 或 1.2.3.4" />
          </Form.Item>
          <Form.Item name="port" label="端口" rules={[{ required: true }]}>
            <InputNumber min={1} max={65535} style={{ width: "100%" }} placeholder="如 8080" />
          </Form.Item>
          <Form.Item name="proxyType" label="协议类型" initialValue="http">
            <Select options={[{ value: "http", label: "HTTP" }, { value: "https", label: "HTTPS" }, { value: "socks5", label: "SOCKS5" }]} />
          </Form.Item>
          <Form.Item name="priority" label="优先级（数字越小越优先）" initialValue={5}>
            <InputNumber min={1} max={10} style={{ width: "100%" }} />
          </Form.Item>
          <Form.Item name="status" label="状态" initialValue="active">
            <Select options={[{ value: "active", label: "启用" }, { value: "disabled", label: "停用" }]} />
          </Form.Item>
        </Form>
      </Modal>

      {/* 用户绑定 Modal */}
      <Modal
        title={`分配用户 — ${selectedProxy?.name ?? ""}`}
        open={bindModalOpen}
        onCancel={() => setBindModalOpen(false)}
        footer={null}
        width={560}
      >
        <Tabs
          items={[
            {
              key: "bound",
              label: `已绑定（${proxyUsers.length}）`,
              children: (
                <Table
                  dataSource={proxyUsers}
                  rowKey="bindingId"
                  size="small"
                  pagination={false}
                  columns={[
                    { title: "用户名", dataIndex: "username" },
                    { title: "显示名", dataIndex: "displayName", render: (v: string | null) => v ?? "—" },
                    {
                      title: "操作",
                      render: (_: unknown, row: ProxyUser) => (
                        <Popconfirm title="确认解绑？" onConfirm={() => handleUnbind(row.bindingId)}>
                          <Button size="small" danger>解绑</Button>
                        </Popconfirm>
                      ),
                    },
                  ]}
                />
              ),
            },
            {
              key: "add",
              label: "添加用户",
              children: (
                <Space style={{ width: "100%" }} direction="vertical">
                  <Select
                    style={{ width: "100%" }}
                    placeholder="选择要绑定的用户"
                    value={bindUserId}
                    onChange={setBindUserId}
                    showSearch
                    filterOption={(input, option) =>
                      (option?.label as string ?? "").toLowerCase().includes(input.toLowerCase())
                    }
                    options={availableUsers.map((u) => ({
                      value: u.id,
                      label: u.display_name ? `${u.username} (${u.display_name})` : u.username,
                    }))}
                  />
                  <Button
                    type="primary"
                    icon={<CheckCircleOutlined />}
                    loading={bindLoading}
                    disabled={!bindUserId}
                    onClick={handleBind}
                    block
                  >
                    确认绑定
                  </Button>
                </Space>
              ),
            },
          ]}
        />
      </Modal>
    </div>
  );
}
