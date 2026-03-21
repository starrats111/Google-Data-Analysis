"use client";

import { useState, useEffect, useCallback, useRef } from "react";
import {
  Card, Table, Button, Space, Modal, Form, Input, Select, Typography, App,
  Popconfirm, Tag, Tooltip, Progress, Badge, Upload, Tabs, Spin, Divider, Flex,
} from "antd";
import {
  GlobalOutlined, PlusOutlined, EditOutlined, DeleteOutlined,
  SafetyCertificateOutlined, CheckCircleOutlined, CloseCircleOutlined,
  CloudDownloadOutlined, GithubOutlined, CloudOutlined, ReloadOutlined,
  CloudServerOutlined, SaveOutlined, UploadOutlined, KeyOutlined,
  SyncOutlined, InboxOutlined, DatabaseOutlined,
} from "@ant-design/icons";

const { Title, Text } = Typography;
const { Password } = Input;
const { Dragger } = Upload;

// === PLACEHOLDER:TYPES ===

const SITE_TYPE_LABELS: Record<string, string> = {
  posts_assets_js: "A1: posts/assets/js",
  posts_assets: "A2: posts/assets",
  articles_index: "B1: articles-index",
  articles_inline: "B2: articles-inline",
  articles_data_win: "C1: window.__ARTICLES__",
  blogposts_data: "C2: blogPosts",
  posts_scripts: "D: scripts/POSTS",
};

const STATUS_COLORS: Record<string, string> = {
  pending: "default", cloning: "processing", dns: "processing",
  ssl: "processing", verifying: "processing", done: "success", failed: "error",
};
const STATUS_LABELS: Record<string, string> = {
  pending: "等待中", cloning: "下载文件", dns: "配置DNS",
  ssl: "申请SSL", verifying: "验证中", done: "完成", failed: "失败",
};

interface Site {
  id: string;
  site_name: string;
  domain: string;
  site_path: string;
  site_type: string | null;
  data_js_path: string | null;
  deploy_type: string;
  verified: number;
  status: string;
  created_at: string;
}

interface MigrationTask {
  id: string;
  domain: string;
  source_type: string;
  source_ref: string | null;
  status: string;
  progress: number;
  step_detail: string | null;
  error_message: string | null;
  created_at: string;
  finished_at: string | null;
}

// === PLACEHOLDER:SERVER_CONFIG ===

// ─── 服务器配置组件（宝塔SSH + 部署凭证）───
function ServerConfigCard({ onConfigLoaded }: { onConfigLoaded?: () => void }) {
  const { message } = App.useApp();
  const [form] = Form.useForm();
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [syncing, setSyncing] = useState(false);
  const [keyUploaded, setKeyUploaded] = useState(false);
  const [keyFilename, setKeyFilename] = useState<string>("");

  const fetchConfig = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch("/api/admin/deploy-config").then(r => r.json());
      if (res.code === 0 && res.data?.config) {
        const cfg = res.data.config;
        form.setFieldsValue(cfg);
        if (cfg.bt_ssh_key_content) {
          setKeyUploaded(true);
          setKeyFilename("已上传密钥");
        }
      }
    } catch { /* ignore */ }
    setLoading(false);
  }, [form]);

  useEffect(() => { fetchConfig(); }, [fetchConfig]);

  const handleSave = async () => {
    const values = await form.validateFields();
    setSaving(true);
    try {
      const res = await fetch("/api/admin/deploy-config", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(values),
      }).then(r => r.json());
      if (res.code === 0) {
        message.success("服务器配置已保存");
        onConfigLoaded?.();
      } else {
        message.error(res.message);
      }
    } catch {
      message.error("保存失败");
    } finally {
      setSaving(false);
    }
  };

  // 从数据分析平台同步配置
  const handleSync = async () => {
    setSyncing(true);
    try {
      const res = await fetch("/api/admin/deploy-config/sync", {
        method: "POST",
      }).then(r => r.json());
      if (res.code === 0) {
        // 同步成功，用返回的配置填充表单
        if (res.data?.config) {
          form.setFieldsValue(res.data.config);
        }
        message.success(res.message || "同步成功");
        onConfigLoaded?.();
      } else {
        message.error(res.message || "同步失败");
      }
    } catch {
      message.error("同步失败，请检查后端连接");
    } finally {
      setSyncing(false);
    }
  };

  const handleKeyUpload = async (file: File) => {
    const formData = new FormData();
    formData.append("file", file);
    try {
      const res = await fetch("/api/admin/deploy-config/ssh-key", {
        method: "POST",
        body: formData,
      }).then(r => r.json());
      if (res.code === 0) {
        message.success(`密钥文件 ${res.data.filename} 已上传`);
        setKeyUploaded(true);
        setKeyFilename(res.data.filename);
      } else {
        message.error(res.message);
      }
    } catch {
      message.error("上传失败");
    }
    return false; // 阻止 antd 默认上传
  };

  const handleKeyDelete = async () => {
    const res = await fetch("/api/admin/deploy-config/ssh-key", { method: "DELETE" }).then(r => r.json());
    if (res.code === 0) {
      message.success("密钥已删除");
      setKeyUploaded(false);
      setKeyFilename("");
    }
  };

  return (
    <Spin spinning={loading}>
      <Card
        title={<Space><CloudServerOutlined /><span>服务器配置</span></Space>}
        extra={
          <Space>
            <Button icon={<SyncOutlined />} loading={syncing} onClick={handleSync}>
              从数据分析平台同步
            </Button>
            <Button type="primary" icon={<SaveOutlined />} loading={saving} onClick={handleSave}>
              保存
            </Button>
          </Space>
        }
        style={{ marginBottom: 16 }}
      >
        <Text type="secondary" style={{ display: "block", marginBottom: 16 }}>
          宝塔服务器 SSH 连接和部署凭证。这些配置与数据分析平台共用，点击「从数据分析平台同步」可自动填充。
        </Text>

        <Form form={form} layout="vertical" style={{ maxWidth: 720 }}>
          <Divider titlePlacement="left" plain>宝塔服务器 SSH</Divider>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "0 24px" }}>
            <Form.Item name="bt_ssh_host" label="服务器 IP" rules={[{ required: true, message: "请输入服务器 IP" }]}>
              <Input placeholder="如：1.2.3.4" />
            </Form.Item>
            <Form.Item name="bt_ssh_port" label="SSH 端口">
              <Input placeholder="22" />
            </Form.Item>
            <Form.Item name="bt_ssh_user" label="SSH 用户名">
              <Input placeholder="ubuntu" />
            </Form.Item>
            <Form.Item name="bt_ssh_password" label="SSH 密码" extra="密码和密钥二选一">
              <Password placeholder="留空则使用密钥" />
            </Form.Item>
          </div>

          <Form.Item label={<Space><KeyOutlined />SSH 密钥文件</Space>} extra={keyUploaded ? `当前密钥：${keyFilename}` : "拖动或点击上传 SSH 私钥文件（如 id_rsa）"}>
            <Flex vertical style={{ width: "100%" }}>
              <Dragger
                accept=".pem,.key,.rsa,*"
                maxCount={1}
                showUploadList={false}
                beforeUpload={(file) => { handleKeyUpload(file); return false; }}
                style={{ padding: "8px 0" }}
              >
                <p className="ant-upload-drag-icon" style={{ marginBottom: 4 }}>
                  <InboxOutlined />
                </p>
                <p className="ant-upload-text" style={{ fontSize: 13 }}>
                  {keyUploaded ? "重新上传密钥文件" : "拖动密钥文件到此处，或点击选择"}
                </p>
              </Dragger>
              {keyUploaded && (
                <Button size="small" danger onClick={handleKeyDelete}>删除已上传密钥</Button>
              )}
            </Flex>
          </Form.Item>

          <Form.Item name="bt_site_root" label="网站根目录">
            <Input placeholder="/www/wwwroot" style={{ maxWidth: 320 }} />
          </Form.Item>

          <Divider titlePlacement="left" plain>部署凭证</Divider>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "0 24px" }}>
            <Form.Item label="GitHub Token">
              <Space.Compact style={{ width: "100%" }}>
                <Form.Item name="github_token" noStyle>
                  <Password placeholder="ghp_..." style={{ flex: 1 }} />
                </Form.Item>
                <Tooltip title="清除 Token">
                  <Button
                    danger
                    icon={<DeleteOutlined />}
                    onClick={() => { form.setFieldValue("github_token", ""); message.info("已清除 GitHub Token，保存后生效"); }}
                  />
                </Tooltip>
              </Space.Compact>
            </Form.Item>
            <Form.Item name="github_org" label="GitHub 组织/用户名">
              <Input placeholder="如：starrats111" />
            </Form.Item>
            <Form.Item label="Cloudflare API Token">
              <Space.Compact style={{ width: "100%" }}>
                <Form.Item name="cf_token" noStyle>
                  <Password placeholder="Bearer Token" style={{ flex: 1 }} />
                </Form.Item>
                <Tooltip title="清除 Token">
                  <Button
                    danger
                    icon={<DeleteOutlined />}
                    onClick={() => { form.setFieldValue("cf_token", ""); message.info("已清除 Cloudflare Token，保存后生效"); }}
                  />
                </Tooltip>
              </Space.Compact>
            </Form.Item>
            <Form.Item name="bt_server_ip" label="宝塔服务器公网 IP" rules={[{ required: true, message: "请输入公网 IP" }]}>
              <Input placeholder="如：52.74.221.116" />
            </Form.Item>
          </div>
        </Form>
      </Card>
    </Spin>
  );
}

// === PLACEHOLDER:SITES_PAGE ===

export default function AdminSitesPage() {
  const { message } = App.useApp();
  const [sites, setSites] = useState<Site[]>([]);
  const [migrations, setMigrations] = useState<MigrationTask[]>([]);
  const [loading, setLoading] = useState(false);
  const [siteModalOpen, setSiteModalOpen] = useState(false);
  const [migrateModalOpen, setMigrateModalOpen] = useState(false);
  const [editSite, setEditSite] = useState<Site | null>(null);
  const [siteForm] = Form.useForm();
  const [migrateForm] = Form.useForm();
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const fetchSites = useCallback(async () => {
    setLoading(true);
    try {
      const r = await fetch("/api/admin/sites");
      if (!r.ok) { setLoading(false); return; }
      const res = await r.json();
      if (res.code === 0) setSites(res.data || []);
    } catch { /* ignore */ }
    setLoading(false);
  }, []);

  const fetchMigrations = useCallback(async () => {
    try {
      const r = await fetch("/api/admin/sites/migrate");
      if (!r.ok) return;
      const res = await r.json();
      if (res.code === 0) setMigrations(res.data || []);
    } catch { /* ignore */ }
  }, []);

  useEffect(() => {
    fetchSites();
    fetchMigrations();
  }, [fetchSites, fetchMigrations]);

  // 轮询进行中的迁移任务
  useEffect(() => {
    const hasRunning = migrations.some((m) => !["done", "failed"].includes(m.status));
    if (hasRunning && !pollRef.current) {
      pollRef.current = setInterval(() => {
        fetchMigrations();
        fetchSites();
      }, 3000);
    } else if (!hasRunning && pollRef.current) {
      clearInterval(pollRef.current);
      pollRef.current = null;
    }
    return () => { if (pollRef.current) clearInterval(pollRef.current); };
  }, [migrations, fetchMigrations, fetchSites]);

  // 站点 CRUD
  const handleAddSite = () => { setEditSite(null); siteForm.resetFields(); setSiteModalOpen(true); };
  const handleEditSite = (site: Site) => { setEditSite(site); siteForm.setFieldsValue(site); setSiteModalOpen(true); };

  const handleSiteSubmit = async () => {
    const values = await siteForm.validateFields();
    const method = editSite ? "PUT" : "POST";
    const body = editSite ? { id: editSite.id, ...values } : values;
    const res = await fetch("/api/admin/sites", {
      method, headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
    }).then((r) => r.json());
    if (res.code === 0) {
      message.success(editSite ? "更新成功" : "站点已创建");
      setSiteModalOpen(false);
      fetchSites();
    } else {
      message.error(res.message);
    }
  };

  const handleDeleteSite = async (id: string) => {
    const res = await fetch("/api/admin/sites", {
      method: "DELETE", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ id }),
    }).then((r) => r.json());
    if (res.code === 0) { message.success("删除成功"); fetchSites(); } else message.error(res.message);
  };

  const handleVerifySite = async (site: Site) => {
    message.loading({ content: "验证中...", key: "verify" });
    const res = await fetch("/api/user/publish-sites/verify", {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ id: site.id }),
    }).then((r) => r.json());
    if (res.code === 0 && res.data?.checks?.valid) {
      message.success({ content: "验证通过", key: "verify" });
    } else {
      message.error({ content: "验证失败", key: "verify" });
    }
    fetchSites();
  };

  // 迁移
  const handleMigrate = () => { migrateForm.resetFields(); setMigrateModalOpen(true); };

  const handleMigrateSubmit = async () => {
    const values = await migrateForm.validateFields();
    const res = await fetch("/api/admin/sites/migrate", {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(values),
    }).then((r) => r.json());
    if (res.code === 0) {
      message.success("迁移任务已创建");
      setMigrateModalOpen(false);
      fetchMigrations();
    } else {
      message.error(res.message);
    }
  };



  const siteColumns = [
    {
      title: "站点名称", dataIndex: "site_name", width: 140,
      render: (text: string) => <Space><GlobalOutlined /><span style={{ fontWeight: 500 }}>{text}</span></Space>,
    },
    {
      title: "域名", dataIndex: "domain", width: 200,
      render: (v: string) => v ? <a href={`https://${v}`} target="_blank" rel="noopener noreferrer">{v}</a> : "-",
    },
    {
      title: "架构类型", dataIndex: "site_type", width: 150,
      render: (v: string | null) => v ? <Tag color="blue">{SITE_TYPE_LABELS[v] || v}</Tag> : <Tag>未检测</Tag>,
    },
    {
      title: "验证", dataIndex: "verified", width: 60,
      render: (v: number) => v ? <CheckCircleOutlined style={{ color: "#52c41a", fontSize: 16 }} /> : <CloseCircleOutlined style={{ color: "#ff4d4f", fontSize: 16 }} />,
    },
    {
      title: "状态", dataIndex: "status", width: 70,
      render: (v: string) => <Tag color={v === "active" ? "success" : "default"}>{v === "active" ? "启用" : "禁用"}</Tag>,
    },
    {
      title: "创建时间", dataIndex: "created_at", width: 150,
      render: (v: string) => new Date(v).toLocaleString("zh-CN", { timeZone: "Asia/Shanghai" }),
    },
    {
      title: "操作", width: 160,
      render: (_: unknown, record: Site) => (
        <Space size="small">
          <Tooltip title="验证"><Button type="link" size="small" icon={<SafetyCertificateOutlined />} onClick={() => handleVerifySite(record)} /></Tooltip>
          <Tooltip title="编辑"><Button type="link" size="small" icon={<EditOutlined />} onClick={() => handleEditSite(record)} /></Tooltip>
          <Popconfirm title="确认删除？" onConfirm={() => handleDeleteSite(record.id)}>
            <Button type="link" size="small" danger icon={<DeleteOutlined />} />
          </Popconfirm>
        </Space>
      ),
    },
  ];

  const migrationColumns = [
    { title: "域名", dataIndex: "domain", width: 180 },
    {
      title: "来源", dataIndex: "source_type", width: 100,
      render: (v: string) => v === "github" ? <Tag icon={<GithubOutlined />} color="default">GitHub</Tag> : <Tag icon={<CloudOutlined />} color="orange">Cloudflare</Tag>,
    },
    {
      title: "状态", dataIndex: "status", width: 100,
      render: (v: string) => <Badge status={STATUS_COLORS[v] as "default" | "processing" | "success" | "error"} text={STATUS_LABELS[v] || v} />,
    },
    {
      title: "进度", dataIndex: "progress", width: 180,
      render: (v: number, record: MigrationTask) => (
        <Progress
          percent={v}
          size="small"
          status={record.status === "failed" ? "exception" : record.status === "done" ? "success" : "active"}
        />
      ),
    },
    {
      title: "详情", dataIndex: "step_detail", ellipsis: true,
      render: (v: string | null, record: MigrationTask) => record.error_message ? <Text type="danger">{record.error_message}</Text> : <Text type="secondary">{v || "-"}</Text>,
    },
    {
      title: "时间", dataIndex: "created_at", width: 150,
      render: (v: string) => new Date(v).toLocaleString("zh-CN", { timeZone: "Asia/Shanghai" }),
    },
  ];

  return (
    <div>
      <Title level={4} style={{ marginBottom: 16 }}><GlobalOutlined /> 站点管理</Title>

      <Tabs
        defaultActiveKey="sites"
        items={[
          {
            key: "sites",
            label: <><GlobalOutlined /> 站点列表</>,
            children: (
              <>
                <Card
                  title="所有站点"
                  extra={
                    <Space>
                      <Button icon={<CloudDownloadOutlined />} onClick={handleMigrate}>迁移站点</Button>
                      <Button type="primary" icon={<PlusOutlined />} onClick={handleAddSite}>添加站点</Button>
                    </Space>
                  }
                  style={{ marginBottom: 16 }}
                >
                  <Table columns={siteColumns} dataSource={sites} rowKey="id" loading={loading} size="small" pagination={false} scroll={{ x: 1000 }} />
                </Card>

                {migrations.length > 0 && (
                  <Card
                    title="迁移任务"
                    extra={<Button size="small" icon={<ReloadOutlined />} onClick={fetchMigrations}>刷新</Button>}
                  >
                    <Table columns={migrationColumns} dataSource={migrations} rowKey="id" size="small" pagination={{ pageSize: 10 }} />
                  </Card>
                )}
              </>
            ),
          },
          {
            key: "server",
            label: <><CloudServerOutlined /> 服务器配置</>,
            children: <ServerConfigCard onConfigLoaded={fetchSites} />,
          },
        ]}
      />

      {/* 添加/编辑站点弹窗 */}
      <Modal title={editSite ? "编辑站点" : "添加站点"} open={siteModalOpen} onOk={handleSiteSubmit} onCancel={() => setSiteModalOpen(false)} destroyOnHidden width={480}>
        <Form form={siteForm} layout="vertical" style={{ marginTop: 16 }}>
          <Form.Item name="site_name" label="站点名称" rules={[{ required: true, message: "请输入站点名称" }]}>
            <Input placeholder="如：AlluraHub" />
          </Form.Item>
          <Form.Item name="domain" label="网站域名" rules={[{ required: true, message: "请输入网站域名" }]} extra="系统会自动在宝塔服务器上检测对应目录和架构类型">
            <Input placeholder="如：allurahub.com" />
          </Form.Item>
          {editSite && (
            <Form.Item name="status" label="状态">
              <Select options={[{ value: "active", label: "启用" }, { value: "inactive", label: "禁用" }]} />
            </Form.Item>
          )}
        </Form>
      </Modal>

      {/* 迁移站点弹窗 */}
      <Modal title="迁移站点到宝塔" open={migrateModalOpen} onOk={handleMigrateSubmit} onCancel={() => setMigrateModalOpen(false)} okText="开始迁移" destroyOnHidden width={520}>
        <Form form={migrateForm} layout="vertical" style={{ marginTop: 16 }}>
          <Form.Item name="domain" label="域名" rules={[{ required: true, message: "请输入域名" }]}>
            <Input placeholder="如：kaizenflowshop.top" />
          </Form.Item>
          <Form.Item name="site_name" label="站点名称">
            <Input placeholder="可选，默认取域名前缀" />
          </Form.Item>
          <Form.Item name="source_type" label="来源" rules={[{ required: true, message: "请选择来源" }]}>
            <Select placeholder="选择迁移来源" options={[
              { value: "github", label: <Space><GithubOutlined />GitHub 仓库</Space> },
              { value: "cloudflare", label: <Space><CloudOutlined />Cloudflare Pages</Space> },
            ]} />
          </Form.Item>
          <Form.Item name="source_ref" label="来源地址" extra="GitHub: 仓库名或完整URL；Cloudflare: pages.dev 地址（可选）">
            <Input placeholder="如：kaizenflowshop 或 https://kaizenflowshop.pages.dev" />
          </Form.Item>
        </Form>
        <Text type="secondary" style={{ fontSize: 12 }}>
          迁移流程：下载文件 → 配置 DNS → 申请 SSL → 验证站点。整个过程约 2-5 分钟。
        </Text>
      </Modal>

    </div>
  );
}
