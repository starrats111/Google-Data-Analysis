"use client";

import { Table, Button, Modal, Form, Input, Select, Tag, Space, Typography, App, Popconfirm, Tooltip } from "antd";
import { PlusOutlined, EditOutlined, DeleteOutlined, SyncOutlined, ShopOutlined, ToolOutlined } from "@ant-design/icons";
import { useState, useMemo, useCallback } from "react";
import { useApi, mutateApi } from "@/lib/swr";

const { Title, Text } = Typography;

interface User {
  id: string;
  username: string;
  role: string;
  status: string;
  team_id: string | null;
  display_name: string | null;
  plain_password: string | null;
  created_at: string;
  merchant_count: number;
}

export default function UsersPage() {
  const { message } = App.useApp();
  const [modalOpen, setModalOpen] = useState(false);
  const [editUser, setEditUser] = useState<User | null>(null);
  const [form] = Form.useForm();
  const [syncingId, setSyncingId] = useState<string | null>(null);
  const [syncResultModal, setSyncResultModal] = useState<{ open: boolean; title: string; content: string }>({ open: false, title: "", content: "" });
  const [fixCampModal, setFixCampModal] = useState<{ open: boolean; user: User | null; step: "confirm" | "preview" | "done"; loading: boolean; previewContent: string; resultContent: string }>({
    open: false, user: null, step: "confirm", loading: false, previewContent: "", resultContent: "",
  });

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
      mutate();
    } else {
      message.error(res.message);
    }
  }, [form, editUser, mutate]);

  const handleDelete = useCallback(async (id: string) => {
    const res = await mutateApi("/api/admin/users", { method: "DELETE", body: { id } });
    if (res.code === 0) { message.success("删除成功"); mutate(); }
    else message.error(res.message);
  }, [mutate]);

  // ─── 触发商家同步 ───
  const handleSync = useCallback(async (user: User) => {
    setSyncingId(user.id);
    const hide = message.loading(`正在同步 ${user.username} 的商家数据...`, 0);
    try {
      const res = await mutateApi("/api/admin/merchants/sync-user", { method: "POST", body: { userId: user.id } });
      hide();
      if (res.code === 0) {
        const d = res.data as { newCount: number; updatedCount: number; total: number; platformCounts: Record<string, number>; errors: string[] };
        const platformLines = Object.entries(d.platformCounts || {}).map(([p, c]) => `  ${p}: ${c} 条`).join("\n");
        const errLines = (d.errors || []).length ? `\n\n错误信息：\n${d.errors.join("\n")}` : "";
        setSyncResultModal({
          open: true,
          title: `${user.username} 同步完成`,
          content: `新增: ${d.newCount}  |  更新: ${d.updatedCount}  |  合计: ${d.total}\n\n各平台商家数：\n${platformLines}${errLines}`,
        });
        mutate(); // 刷新列表（更新商家数量）
      } else {
        message.error(res.message || "同步失败");
      }
    } catch {
      hide();
      message.error("同步请求失败，请稍后重试");
    } finally {
      setSyncingId(null);
    }
  }, [mutate]);

  // ─── 修复广告系列（删除非CF + 重编号）───
  const handleFixCampaigns = useCallback((user: User) => {
    setFixCampModal({ open: true, user, step: "confirm", loading: false, previewContent: "", resultContent: "" });
  }, []);

  const handleFixCampPreview = useCallback(async () => {
    const user = fixCampModal.user;
    if (!user) return;
    setFixCampModal((prev) => ({ ...prev, loading: true }));
    try {
      const res = await mutateApi("/api/admin/fix-user-platform-campaigns", {
        method: "POST",
        body: { username: user.username, keep_platform: "CF", dry_run: true },
      });
      if (res.code === 0) {
        const d = res.data as {
          delete_count: number; keep_count: number; release_merchant_count: number;
          campaigns_to_delete: { name: string; status: string }[];
          campaigns_to_rename: { old_name: string; new_name: string }[];
        };
        const deleteLines = (d.campaigns_to_delete || []).map((c) => `  [-] ${c.name}  (${c.status})`).join("\n");
        const renameLines = (d.campaigns_to_rename || []).map((r) => `  [→] ${r.old_name}\n      ↳ ${r.new_name}`).join("\n");
        const content = [
          `将删除非 CF 广告系列：${d.delete_count} 条`,
          deleteLines || "  （无）",
          "",
          `保留并重编号 CF 广告系列：${d.keep_count} 条`,
          renameLines || "  （无）",
          "",
          `关联商家将被释放：${d.release_merchant_count} 条`,
        ].join("\n");
        setFixCampModal((prev) => ({ ...prev, loading: false, step: "preview", previewContent: content }));
      } else {
        message.error(res.message || "预览失败");
        setFixCampModal((prev) => ({ ...prev, loading: false }));
      }
    } catch {
      message.error("请求失败，请稍后重试");
      setFixCampModal((prev) => ({ ...prev, loading: false }));
    }
  }, [fixCampModal.user, message]);

  const handleFixCampExecute = useCallback(async () => {
    const user = fixCampModal.user;
    if (!user) return;
    setFixCampModal((prev) => ({ ...prev, loading: true }));
    try {
      const res = await mutateApi("/api/admin/fix-user-platform-campaigns", {
        method: "POST",
        body: { username: user.username, keep_platform: "CF", dry_run: false },
      });
      if (res.code === 0) {
        const d = res.data as {
          deleted_campaigns: number; renamed_campaigns: number; released_merchants: number;
          details: { deleted: { name: string }[]; renamed: { old_name: string; new_name: string }[]; kept_unchanged: { name: string }[] };
        };
        const renamedLines = (d.details?.renamed || []).map((r) => `  ${r.old_name}\n  ↳ ${r.new_name}`).join("\n");
        const content = [
          `✅ 操作完成`,
          `  已删除非CF广告系列：${d.deleted_campaigns} 条`,
          `  已重命名CF广告系列：${d.renamed_campaigns} 条`,
          `  释放商家：${d.released_merchants} 条`,
          renamedLines ? `\n重命名详情：\n${renamedLines}` : "",
        ].filter(Boolean).join("\n");
        setFixCampModal((prev) => ({ ...prev, loading: false, step: "done", resultContent: content }));
        mutate();
      } else {
        message.error(res.message || "操作失败");
        setFixCampModal((prev) => ({ ...prev, loading: false }));
      }
    } catch {
      message.error("请求失败，请稍后重试");
      setFixCampModal((prev) => ({ ...prev, loading: false }));
    }
  }, [fixCampModal.user, message, mutate]);

  // ─── columns ───
  const columns = useMemo(() => [
    { title: "ID", dataIndex: "id", width: 70 },
    { title: "用户名", dataIndex: "username" },
    { title: "密码", dataIndex: "plain_password", width: 120, render: (v: string | null) => v ? <Text copyable style={{ fontSize: 12 }}>{v}</Text> : <Text type="secondary" style={{ fontSize: 12 }}>未记录</Text> },
    { title: "角色", dataIndex: "role", width: 90, render: (v: string) => {
      const colorMap: Record<string, string> = { admin: "red", leader: "orange", user: "blue" };
      const labelMap: Record<string, string> = { admin: "管理员", leader: "组长", user: "用户" };
      return <Tag color={colorMap[v] || "blue"}>{labelMap[v] || v}</Tag>;
    }},
    { title: "状态", dataIndex: "status", width: 80, render: (v: string) => <Tag color={v === "active" ? "green" : "default"}>{v === "active" ? "启用" : "禁用"}</Tag> },
    {
      title: "商家数", dataIndex: "merchant_count", width: 90,
      render: (v: number) => (
        <Tooltip title="已同步到该用户库的商家总数">
          <Tag icon={<ShopOutlined />} color={v > 0 ? "blue" : "default"} style={{ cursor: "default" }}>{v.toLocaleString()}</Tag>
        </Tooltip>
      ),
    },
    { title: "创建时间", dataIndex: "created_at", render: (v: string) => new Date(v).toLocaleString("zh-CN", { timeZone: "Asia/Shanghai" }) },
    {
      title: "操作", render: (_: unknown, record: User) => (
        <Space>
          <Button size="small" icon={<EditOutlined />} onClick={() => handleEdit(record)}>编辑</Button>
          <Tooltip title="触发该用户所有平台的商家同步（实时执行，稍等片刻）">
            <Button
              size="small"
              icon={<SyncOutlined spin={syncingId === record.id} />}
              onClick={() => handleSync(record)}
              loading={syncingId === record.id}
              disabled={!!syncingId && syncingId !== record.id}
            >
              同步商家
            </Button>
          </Tooltip>
          <Tooltip title="删除非CF平台广告系列，并对CF广告系列从001重新编号">
            <Button
              size="small"
              icon={<ToolOutlined />}
              onClick={() => handleFixCampaigns(record)}
            >
              修复广告系列
            </Button>
          </Tooltip>
          <Popconfirm title="确认删除？" onConfirm={() => handleDelete(record.id)}>
            <Button size="small" danger icon={<DeleteOutlined />}>删除</Button>
          </Popconfirm>
        </Space>
      ),
    },
  ], [handleEdit, handleDelete, handleSync, handleFixCampaigns, syncingId]);

  return (
    <div>
      <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 16 }}>
        <Title level={4} style={{ margin: 0 }}>用户管理</Title>
        <Button type="primary" icon={<PlusOutlined />} onClick={handleCreate}>创建用户</Button>
      </div>
      <Table
        columns={columns}
        dataSource={users}
        rowKey="id"
        loading={loading}
        pagination={{ pageSize: 20, showTotal: (t) => `共 ${t} 条` }}
        scroll={{ x: 900 }}
      />

      {/* 创建 / 编辑用户 Modal */}
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

      {/* 同步结果详情 Modal */}
      <Modal
        title={syncResultModal.title}
        open={syncResultModal.open}
        onOk={() => setSyncResultModal({ open: false, title: "", content: "" })}
        onCancel={() => setSyncResultModal({ open: false, title: "", content: "" })}
        cancelButtonProps={{ style: { display: "none" } }}
      >
        <pre style={{ whiteSpace: "pre-wrap", fontFamily: "monospace", fontSize: 13, background: "#f5f5f5", padding: 12, borderRadius: 4 }}>
          {syncResultModal.content}
        </pre>
      </Modal>

      {/* 修复广告系列 Modal */}
      <Modal
        title={`修复广告系列 — ${fixCampModal.user?.username}`}
        open={fixCampModal.open}
        onCancel={() => setFixCampModal((prev) => ({ ...prev, open: false }))}
        footer={
          fixCampModal.step === "confirm" ? (
            <Space>
              <Button onClick={() => setFixCampModal((prev) => ({ ...prev, open: false }))}>取消</Button>
              <Button type="primary" loading={fixCampModal.loading} onClick={handleFixCampPreview}>
                预览变更
              </Button>
            </Space>
          ) : fixCampModal.step === "preview" ? (
            <Space>
              <Button onClick={() => setFixCampModal((prev) => ({ ...prev, step: "confirm" }))}>返回</Button>
              <Button type="primary" danger loading={fixCampModal.loading} onClick={handleFixCampExecute}>
                确认执行
              </Button>
            </Space>
          ) : (
            <Button type="primary" onClick={() => setFixCampModal((prev) => ({ ...prev, open: false }))}>
              关闭
            </Button>
          )
        }
        width={680}
      >
        {fixCampModal.step === "confirm" && (
          <div>
            <p>将对用户 <strong>{fixCampModal.user?.username}</strong> 执行以下操作：</p>
            <ul style={{ paddingLeft: 20 }}>
              <li>软删除所有 <strong>非 CF 平台</strong>（如 LH1、LH11 等）的广告系列</li>
              <li>将保留的 CF 广告系列按创建顺序从 <strong>001</strong> 开始重新编号</li>
              <li>释放仅关联到被删除广告系列的商家</li>
            </ul>
            <p style={{ color: "#faad14" }}>⚠️ 此操作不可逆，建议先点击「预览变更」确认后再执行。</p>
          </div>
        )}
        {fixCampModal.step === "preview" && (
          <pre style={{ whiteSpace: "pre-wrap", fontFamily: "monospace", fontSize: 12, background: "#f5f5f5", padding: 12, borderRadius: 4, maxHeight: 420, overflow: "auto" }}>
            {fixCampModal.previewContent}
          </pre>
        )}
        {fixCampModal.step === "done" && (
          <pre style={{ whiteSpace: "pre-wrap", fontFamily: "monospace", fontSize: 12, background: "#f6ffed", padding: 12, borderRadius: 4, maxHeight: 420, overflow: "auto" }}>
            {fixCampModal.resultContent}
          </pre>
        )}
      </Modal>
    </div>
  );
}
