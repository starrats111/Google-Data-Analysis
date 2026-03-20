"use client";

import { Table, Button, Modal, Form, Input, Select, Tag, Space, Typography, App, Popconfirm } from "antd";
import { PlusOutlined, EditOutlined, DeleteOutlined } from "@ant-design/icons";
import { useState, useMemo, useCallback } from "react";
import { useApi, mutateApi } from "@/lib/swr";

const { Title, Text } = Typography;

interface User { id: string; username: string; role: string; status: string; team_id: string | null; display_name: string | null; plain_password: string | null; created_at: string; }

export default function UsersPage() {
  const { message } = App.useApp();
  const [modalOpen, setModalOpen] = useState(false);
  const [editUser, setEditUser] = useState<User | null>(null);
  const [form] = Form.useForm();

  // ─── SWR 缓存用户列表 ───
  const { data: userData, isLoading: loading, mutate } = useApi<{ list: User[]; total: number }>("/api/admin/users");
  const users = userData?.list || (Array.isArray(userData) ? userData as unknown as User[] : []);

  // ─── 获取小组列表 ───
  const { data: teamsData } = useApi<{ list: { id: string; team_code: string; team_name: string }[] }>("/api/admin/teams");
  const teams = teamsData?.list || [];

  const handleCreate = useCallback(() => {
    setEditUser(null);
    form.resetFields();
    setModalOpen(true);
  }, [form]);

  const handleEdit = useCallback((user: User) => {
    setEditUser(user);
    form.setFieldsValue({ status: user.status, role: user.role, team_id: user.team_id || undefined, display_name: user.display_name || "" });
    setModalOpen(true);
  }, [form]);

  const handleSubmit = useCallback(async () => {
    const values = await form.validateFields();
    const method = editUser ? "PUT" : "POST";
    const body = editUser ? { id: editUser.id, ...values } : values;
    const res = await mutateApi("/api/admin/users", { method, body });
    if (res.code === 0) {
      message.success(editUser ? "更新成功" : "创建成功");
      setModalOpen(false);
      mutate(); // 刷新列表
    } else {
      message.error(res.message);
    }
  }, [form, editUser, mutate]);

  const handleDelete = useCallback(async (id: string) => {
    const res = await mutateApi("/api/admin/users", { method: "DELETE", body: { id } });
    if (res.code === 0) { message.success("删除成功"); mutate(); }
    else message.error(res.message);
  }, [mutate]);

  // ─── columns — useMemo ───
  const columns = useMemo(() => [
    { title: "ID", dataIndex: "id", width: 80 },
    { title: "用户名", dataIndex: "username" },
    { title: "密码", dataIndex: "plain_password", width: 120, render: (v: string | null) => v ? <Text copyable style={{ fontSize: 12 }}>{v}</Text> : <Text type="secondary" style={{ fontSize: 12 }}>未记录</Text> },
    { title: "角色", dataIndex: "role", render: (v: string) => {
      const colorMap: Record<string, string> = { admin: "red", leader: "orange", user: "blue" };
      const labelMap: Record<string, string> = { admin: "管理员", leader: "组长", user: "用户" };
      return <Tag color={colorMap[v] || "blue"}>{labelMap[v] || v}</Tag>;
    }},
    { title: "状态", dataIndex: "status", render: (v: string) => <Tag color={v === "active" ? "green" : "default"}>{v === "active" ? "启用" : "禁用"}</Tag> },
    { title: "创建时间", dataIndex: "created_at", render: (v: string) => new Date(v).toLocaleString("zh-CN", { timeZone: "Asia/Shanghai" }) },
    {
      title: "操作", render: (_: unknown, record: User) => (
        <Space>
          <Button size="small" icon={<EditOutlined />} onClick={() => handleEdit(record)}>编辑</Button>
          <Popconfirm title="确认删除？" onConfirm={() => handleDelete(record.id)}>
            <Button size="small" danger icon={<DeleteOutlined />}>删除</Button>
          </Popconfirm>
        </Space>
      ),
    },
  ], [handleEdit, handleDelete]);

  return (
    <div>
      <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 16 }}>
        <Title level={4} style={{ margin: 0 }}>用户管理</Title>
        <Button type="primary" icon={<PlusOutlined />} onClick={handleCreate}>创建用户</Button>
      </div>
      <Table columns={columns} dataSource={users} rowKey="id" loading={loading}
        pagination={{ pageSize: 20, showTotal: (t) => `共 ${t} 条` }} />
      <Modal title={editUser ? "编辑用户" : "创建用户"} open={modalOpen} onOk={handleSubmit} onCancel={() => setModalOpen(false)}>
        <Form form={form} layout="vertical">
          {!editUser && (
            <>
              <Form.Item name="username" label="用户名" rules={[{ required: true, message: "请输入用户名" }]}><Input /></Form.Item>
              <Form.Item name="password" label="密码" rules={[{ required: true, message: "请输入密码" }]}><Input.Password /></Form.Item>
              <Form.Item name="role" label="角色" initialValue="user">
                <Select options={[{ value: "user", label: "用户" }, { value: "leader", label: "组长" }, { value: "admin", label: "管理员" }]} />
              </Form.Item>
              <Form.Item name="display_name" label="显示名称（中文名）">
                <Input placeholder="可选" />
              </Form.Item>
              <Form.Item name="team_id" label="所属小组">
                <Select allowClear placeholder="选择小组（可选）"
                  options={teams.map((t) => ({ value: t.id, label: `${t.team_name} (${t.team_code})` }))} />
              </Form.Item>
            </>
          )}
          {editUser && (
            <>
              <Form.Item name="status" label="状态">
                <Select options={[{ value: "active", label: "启用" }, { value: "disabled", label: "禁用" }]} />
              </Form.Item>
              <Form.Item name="role" label="角色">
                <Select options={[{ value: "user", label: "用户" }, { value: "leader", label: "组长" }, { value: "admin", label: "管理员" }]} />
              </Form.Item>
              <Form.Item name="display_name" label="显示名称（中文名）">
                <Input placeholder="可选" />
              </Form.Item>
              <Form.Item name="team_id" label="所属小组">
                <Select allowClear placeholder="选择小组（可选）"
                  options={teams.map((t) => ({ value: t.id, label: `${t.team_name} (${t.team_code})` }))} />
              </Form.Item>
              <Form.Item name="password" label="重置密码（留空不修改）"><Input.Password /></Form.Item>
            </>
          )}
        </Form>
      </Modal>
    </div>
  );
}
