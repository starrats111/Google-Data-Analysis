"use client";

import { useState, useMemo, useCallback } from "react";
import {
  Table, Button, Modal, Form, Input, Select, Tag, Space, Typography, App, Popconfirm,
} from "antd";
import {
  PlusOutlined, EditOutlined, DeleteOutlined, EyeOutlined, TeamOutlined,
} from "@ant-design/icons";
import { useApi, mutateApi } from "@/lib/swr";
import MemberDataModal from "@/components/team/MemberDataModal";

const { Title } = Typography;

interface Member {
  id: string;
  username: string;
  display_name: string | null;
  status: string;
  created_at: string;
}

export default function TeamMembersPage() {
  const { message } = App.useApp();
  const [modalOpen, setModalOpen] = useState(false);
  const [editMember, setEditMember] = useState<Member | null>(null);
  const [form] = Form.useForm();

  // 数据看板弹窗
  const [dataModal, setDataModal] = useState<{
    open: boolean; userId: string | null; username?: string; displayName?: string;
  }>({ open: false, userId: null });

  // SWR 缓存组员列表
  const { data: memberData, isLoading, mutate } = useApi<{ list: Member[]; total: number }>("/api/user/team/members");
  const members = memberData?.list || [];

  const handleCreate = useCallback(() => {
    setEditMember(null);
    form.resetFields();
    setModalOpen(true);
  }, [form]);

  const handleEdit = useCallback((member: Member) => {
    setEditMember(member);
    form.setFieldsValue({ status: member.status, display_name: member.display_name || "" });
    setModalOpen(true);
  }, [form]);

  const handleSubmit = useCallback(async () => {
    const values = await form.validateFields();
    const method = editMember ? "PUT" : "POST";
    const body = editMember ? { id: editMember.id, ...values } : values;
    // 如果密码为空字符串，编辑时不传
    if (editMember && !values.password) delete body.password;
    const res = await mutateApi("/api/user/team/members", { method, body });
    if (res.code === 0) {
      message.success(editMember ? "更新成功" : "创建成功");
      setModalOpen(false);
      mutate();
    } else {
      message.error(res.message);
    }
  }, [form, editMember, mutate, message]);

  const handleDelete = useCallback(async (id: string) => {
    const res = await mutateApi("/api/user/team/members", { method: "DELETE", body: { id } });
    if (res.code === 0) { message.success("删除成功"); mutate(); }
    else message.error(res.message);
  }, [mutate, message]);

  const handleView = useCallback((member: Member) => {
    setDataModal({
      open: true,
      userId: member.id,
      username: member.username,
      displayName: member.display_name || undefined,
    });
  }, []);

  const columns = useMemo(() => [
    { title: "ID", dataIndex: "id", width: 80 },
    { title: "用户名", dataIndex: "username" },
    {
      title: "显示名", dataIndex: "display_name", width: 120,
      render: (v: string | null) => v || <span style={{ color: "#999" }}>-</span>,
    },
    {
      title: "状态", dataIndex: "status", width: 80,
      render: (v: string) => <Tag color={v === "active" ? "green" : "default"}>{v === "active" ? "启用" : "禁用"}</Tag>,
    },
    {
      title: "创建时间", dataIndex: "created_at", width: 170,
      render: (v: string) => new Date(v).toLocaleString("zh-CN", { timeZone: "Asia/Shanghai" }),
    },
    {
      title: "操作", width: 220,
      render: (_: unknown, record: Member) => (
        <Space>
          <Button size="small" type="primary" ghost icon={<EyeOutlined />} onClick={() => handleView(record)}>查看</Button>
          <Button size="small" icon={<EditOutlined />} onClick={() => handleEdit(record)}>编辑</Button>
          <Popconfirm title="确认删除该组员？" onConfirm={() => handleDelete(record.id)}>
            <Button size="small" danger icon={<DeleteOutlined />}>删除</Button>
          </Popconfirm>
        </Space>
      ),
    },
  ], [handleEdit, handleDelete, handleView]);

  return (
    <div>
      <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 16 }}>
        <Title level={4} style={{ margin: 0 }}>
          <TeamOutlined style={{ marginRight: 8 }} />员工管理
        </Title>
        <Button type="primary" icon={<PlusOutlined />} onClick={handleCreate}>添加组员</Button>
      </div>

      <Table
        columns={columns}
        dataSource={members}
        rowKey="id"
        loading={isLoading}
        pagination={{ pageSize: 20, showTotal: (t) => `共 ${t} 条` }}
      />

      {/* 创建/编辑弹窗 */}
      <Modal
        title={editMember ? "编辑组员" : "添加组员"}
        open={modalOpen}
        onOk={handleSubmit}
        onCancel={() => setModalOpen(false)}
      >
        <Form form={form} layout="vertical">
          {!editMember && (
            <>
              <Form.Item name="username" label="用户名" rules={[{ required: true, message: "请输入用户名" }]}>
                <Input />
              </Form.Item>
              <Form.Item name="password" label="密码" rules={[{ required: true, message: "请输入密码" }]}>
                <Input.Password />
              </Form.Item>
            </>
          )}
          <Form.Item name="display_name" label="显示名称（中文名）">
            <Input placeholder="可选" />
          </Form.Item>
          {editMember && (
            <>
              <Form.Item name="status" label="状态">
                <Select options={[{ value: "active", label: "启用" }, { value: "disabled", label: "禁用" }]} />
              </Form.Item>
              <Form.Item name="password" label="重置密码（留空不修改）">
                <Input.Password />
              </Form.Item>
            </>
          )}
        </Form>
      </Modal>

      {/* 数据看板弹窗 */}
      <MemberDataModal
        open={dataModal.open}
        userId={dataModal.userId}
        username={dataModal.username}
        displayName={dataModal.displayName}
        onClose={() => setDataModal({ open: false, userId: null })}
      />
    </div>
  );
}
