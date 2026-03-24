"use client";

import { useState, useEffect, useCallback } from "react";
import {
  Card, Table, Tag, Button, Space, Select, Modal, Form, Typography, Popconfirm, App,
} from "antd";
import {
  UnorderedListOutlined, DeleteOutlined, EyeOutlined, SendOutlined, CopyOutlined, LinkOutlined, SyncOutlined, ToolOutlined,
} from "@ant-design/icons";
import { sanitizeHtml } from "@/lib/sanitize";

const { Title, Text, Paragraph } = Typography;

interface Article {
  id: string; title: string | null; slug: string | null; content: string | null;
  language: string; keywords: string[] | null;
  status: string; published_at: string | null; published_url: string | null;
  user_merchant_id: string; publish_site_id: string | null; created_at: string;
  merchant_name: string | null;
  merchant_id: string | null;
  site_name: string | null;
  site_domain: string | null;
}

interface Site {
  id: string; site_name: string; domain: string; site_type: string | null; verified: number; status: string;
}

export default function ArticlesPage() {
  const { message } = App.useApp();
  const [articles, setArticles] = useState<Article[]>([]);
  const [sites, setSites] = useState<Site[]>([]);
  const [loading, setLoading] = useState(false);
  const [statusFilter, setStatusFilter] = useState<string>("");
  const [page, setPage] = useState(1);
  const [total, setTotal] = useState(0);

  // 预览 Modal
  const [previewOpen, setPreviewOpen] = useState(false);
  const [previewArticle, setPreviewArticle] = useState<Article | null>(null);

  // 发布选择
  const [publishModal, setPublishModal] = useState(false);
  const [publishArticle, setPublishArticle] = useState<Article | null>(null);
  const [publishForm] = Form.useForm();
  const [publishing, setPublishing] = useState(false);
  const [repairing, setRepairing] = useState(false);

  const fetchArticles = useCallback(async () => {
    setLoading(true);
    const params = new URLSearchParams({ page: String(page), pageSize: "20" });
    if (statusFilter) params.set("status", statusFilter);
    const res = await fetch(`/api/user/articles?${params}`).then((r) => r.json());
    if (res.code === 0) { setArticles(res.data.articles); setTotal(res.data.total); }
    setLoading(false);
  }, [statusFilter, page]);

  const fetchSites = async () => {
    const res = await fetch("/api/user/publish-sites").then((r) => r.json());
    if (res.code === 0) setSites(res.data);
  };

  useEffect(() => { fetchArticles(); }, [fetchArticles]);
  useEffect(() => { fetchSites(); }, []);

  const handleDelete = async (id: string) => {
    const res = await fetch("/api/user/articles", {
      method: "DELETE", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ id }),
    }).then((r) => r.json());
    if (res.code === 0) { message.success("删除成功"); fetchArticles(); } else message.error(res.message);
  };

  const handlePublish = (article: Article) => {
    setPublishArticle(article);
    publishForm.resetFields();
    setPublishModal(true);
  };

  const submitPublish = async () => {
    const values = await publishForm.validateFields();
    setPublishing(true);
    message.loading({ content: "正在发布，图片处理中，请耐心等待...", key: "publish", duration: 0 });
    try {
      const res = await fetch("/api/user/articles/publish-to-site", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ article_id: publishArticle?.id, site_id: values.publish_site_id }),
        signal: AbortSignal.timeout(180000),
      }).then((r) => r.json());
      if (res.code === 0) {
        message.success({ content: `发布成功${res.data?.url ? `，访问: ${res.data.url}` : ""}`, key: "publish" });
        setPublishModal(false);
        fetchArticles();
      } else {
        message.error({ content: res.message, key: "publish" });
      }
    } catch (err) {
      const errMsg = err instanceof Error && err.name === "TimeoutError"
        ? "发布超时，请稍后在列表中检查状态" : "发布请求失败";
      message.error({ content: errMsg, key: "publish" });
    } finally {
      setPublishing(false);
    }
  };

  // 同步文章
  const [syncing, setSyncing] = useState(false);
  const handleSyncArticles = async () => {
    setSyncing(true);
    try {
      const res = await fetch("/api/user/articles/sync", {
        method: "POST", headers: { "Content-Type": "application/json" }, body: "{}",
      }).then((r) => r.json());
      if (res.code === 0) {
        message.success(res.data?.message || "同步完成");
        fetchArticles();
      } else message.error(res.message);
    } catch { message.error("同步失败"); }
    finally { setSyncing(false); }
  };

  const copyUrl = (url: string) => {
    navigator.clipboard.writeText(url).then(() => message.success("已复制链接"));
  };

  const handleRepairPublishedArticles = async () => {
    const activeVerifiedSites = sites.filter((s) => s.status === "active" && s.verified === 1);
    if (activeVerifiedSites.length === 0) {
      message.warning("没有可修复的已验证站点，请先到站点管理完成验证");
      return;
    }

    setRepairing(true);
    message.loading({ content: "正在修复已发布文章，请耐心等待...", key: "repair", duration: 0 });
    try {
      const allPublishedArticles: Article[] = [];
      let currentPage = 1;
      let hasMore = true;

      while (hasMore) {
        const res = await fetch(`/api/user/articles?status=published&page=${currentPage}&pageSize=200`).then((r) => r.json());
        if (res.code !== 0) {
          throw new Error(res.message || "加载已发布文章失败");
        }

        const batch: Article[] = res.data?.articles || [];
        allPublishedArticles.push(...batch);
        const totalCount = Number(res.data?.total || 0);
        hasMore = allPublishedArticles.length < totalCount && batch.length > 0;
        currentPage += 1;
      }

      const publishedArticles = allPublishedArticles.filter((a) => a.publish_site_id);
      if (publishedArticles.length === 0) {
        message.info({ content: "当前没有可修复的已发布文章", key: "repair" });
        return;
      }

      const siteIds = [...new Set(publishedArticles.map((a) => a.publish_site_id).filter((v): v is string => Boolean(v)))];
      let repaired = 0;
      let failed = 0;
      const errors: string[] = [];

      for (const siteId of siteIds) {
        const articleIds = publishedArticles.filter((a) => a.publish_site_id === siteId).map((a) => a.id);
        const res = await fetch("/api/user/articles/repair-images", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ site_id: siteId, article_ids: articleIds }),
          signal: AbortSignal.timeout(10 * 60 * 1000),
        }).then((r) => r.json());

        if (res.code === 0) {
          repaired += res.data?.repaired || 0;
          failed += res.data?.failed || 0;
          if (Array.isArray(res.data?.errors)) {
            errors.push(...res.data.errors.slice(0, 10));
          }
        } else {
          failed += articleIds.length;
          errors.push(res.message || `站点 ${siteId} 修复失败`);
        }
      }

      if (failed === 0) {
        message.success({ content: `修复完成，共处理 ${repaired} 篇文章`, key: "repair" });
      } else {
        message.warning({ content: `修复完成：成功 ${repaired} 篇，失败 ${failed} 篇`, key: "repair" });
        if (errors.length > 0) {
          Modal.info({
            title: "部分文章修复失败",
            width: 720,
            content: (
              <div style={{ maxHeight: 320, overflowY: "auto", whiteSpace: "pre-wrap", fontSize: 12 }}>
                {errors.join("\n")}
              </div>
            ),
          });
        }
      }

      fetchArticles();
    } catch (err) {
      const errMsg = err instanceof Error && err.name === "TimeoutError"
        ? "修复超时，请稍后刷新文章列表查看结果"
        : (err instanceof Error ? err.message : "修复请求失败");
      message.error({ content: errMsg, key: "repair" });
    } finally {
      setRepairing(false);
    }
  };

  const statusColor: Record<string, string> = { generating: "processing", draft: "default", preview: "warning", published: "success", failed: "error" };
  const statusLabel: Record<string, string> = { generating: "生成中", draft: "草稿", preview: "待预览", published: "已发布", failed: "失败" };

  const articleColumns = [
    {
      title: "文章名", dataIndex: "title", ellipsis: true, width: 240,
      render: (v: string | null) => v || <Text type="secondary">生成中...</Text>,
    },
    {
      title: "发布网站", width: 140,
      render: (_: unknown, record: Article) => {
        if (record.site_name) return <Text style={{ fontSize: 12 }}>{record.site_name}</Text>;
        if (record.site_domain) return <Text style={{ fontSize: 12 }}>{record.site_domain}</Text>;
        return <Text type="secondary" style={{ fontSize: 12 }}>-</Text>;
      },
    },
    {
      title: "文章 URL", dataIndex: "published_url", width: 200,
      render: (v: string | null) => v ? (
        <Space size={4}>
          <a href={v} target="_blank" rel="noreferrer" style={{ fontSize: 12, maxWidth: 150, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", display: "inline-block" }}>
            <LinkOutlined /> {v.replace(/^https?:\/\//, "")}
          </a>
          <Button type="text" size="small" icon={<CopyOutlined />} onClick={() => copyUrl(v)} style={{ padding: 0, height: 20 }} />
        </Space>
      ) : <Text type="secondary" style={{ fontSize: 12 }}>-</Text>,
    },
    {
      title: "推广商家", dataIndex: "merchant_name", width: 140, ellipsis: true,
      render: (v: string | null) => v || <Text type="secondary">-</Text>,
    },
    {
      title: "MID", dataIndex: "merchant_id", width: 100, ellipsis: true,
      render: (v: string | null) => v || <Text type="secondary">-</Text>,
    },
    {
      title: "状态", dataIndex: "status", width: 80,
      render: (v: string) => <Tag color={statusColor[v]}>{statusLabel[v] || v}</Tag>,
    },
    {
      title: "创建时间", dataIndex: "created_at", width: 150,
      render: (v: string) => <Text style={{ fontSize: 12 }}>{new Date(v).toLocaleString("zh-CN", { timeZone: "Asia/Shanghai" })}</Text>,
    },
    {
      title: "操作", width: 200, render: (_: unknown, record: Article) => (
        <Space>
          <Button size="small" icon={<EyeOutlined />} onClick={() => { setPreviewArticle(record); setPreviewOpen(true); }}>预览</Button>
          {(record.status === "preview" || record.status === "draft") && (
            <Button size="small" type="primary" icon={<SendOutlined />} onClick={() => handlePublish(record)}>发布</Button>
          )}
          <Popconfirm title="确认删除？" onConfirm={() => handleDelete(record.id)}>
            <Button size="small" danger icon={<DeleteOutlined />}>删除</Button>
          </Popconfirm>
        </Space>
      ),
    },
  ];

  return (
    <div>
      <Title level={4}><UnorderedListOutlined /> 文章管理</Title>

      <Card>
        <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 16 }}>
          <Select
            placeholder="按状态筛选"
            allowClear
            style={{ width: 160 }}
            value={statusFilter || undefined}
            onChange={(v) => { setStatusFilter(v || ""); setPage(1); }}
            options={[
              { value: "generating", label: "生成中" },
              { value: "draft", label: "草稿" },
              { value: "preview", label: "待预览" },
              { value: "published", label: "已发布" },
              { value: "failed", label: "失败" },
            ]}
          />
          <Space>
            <Button icon={<ToolOutlined />} loading={repairing} onClick={handleRepairPublishedArticles}>
              修复已发布文章
            </Button>
            <Popconfirm title="确认清理所有失败/生成中的文章？" onConfirm={async () => {
              const res = await fetch("/api/user/articles", { method: "DELETE", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: "cleanup_failed" }) }).then(r => r.json());
              if (res.code === 0) { message.success(res.message); fetchArticles(); } else message.error(res.message);
            }}>
              <Button danger icon={<DeleteOutlined />}>清理失败文章</Button>
            </Popconfirm>
          </Space>
        </div>
        <Table
          columns={articleColumns} dataSource={articles} rowKey="id" loading={loading}
          pagination={{ current: page, pageSize: 20, total, onChange: setPage, showTotal: (t) => `共 ${t} 条` }}
          size="small"
          scroll={{ x: 1200 }}
        />
      </Card>

      {/* 文章预览 Modal */}
      <Modal title="文章预览" open={previewOpen} onCancel={() => setPreviewOpen(false)} footer={null} width={800}>
        {previewArticle && (
          <div>
            <Title level={4}>{previewArticle.title || "无标题"}</Title>
            <Space style={{ marginBottom: 16 }}>
              <Tag>{previewArticle.language}</Tag>
              <Tag color={statusColor[previewArticle.status]}>{statusLabel[previewArticle.status]}</Tag>
              {previewArticle.merchant_name && <Tag color="blue">{previewArticle.merchant_name}</Tag>}
            </Space>
            {previewArticle.keywords && (
              <div style={{ marginBottom: 16 }}>
                <Text strong>关键词：</Text>
                <Space wrap>{(previewArticle.keywords as string[]).map((k, i) => <Tag key={i}>{k}</Tag>)}</Space>
              </div>
            )}
            <Paragraph>
              <div dangerouslySetInnerHTML={{ __html: sanitizeHtml(previewArticle.content || "<p>内容生成中...</p>") }} />
            </Paragraph>
          </div>
        )}
      </Modal>

      {/* 发布弹窗 */}
      <Modal
        title="选择发布站点"
        open={publishModal}
        onOk={submitPublish}
        onCancel={() => !publishing && setPublishModal(false)}
        confirmLoading={publishing}
        okText={publishing ? "发布中..." : "确认发布"}
        cancelButtonProps={{ disabled: publishing }}
        closable={!publishing}
        maskClosable={!publishing}
      >
        <Form form={publishForm} layout="vertical">
          <Form.Item name="publish_site_id" label="发布到" rules={[{ required: true, message: "请选择站点" }]}>
            <Select disabled={publishing} options={sites.filter((s) => s.status === "active" && s.verified === 1).map((s) => ({ value: s.id, label: `${s.site_name} (${s.domain})` }))} />
          </Form.Item>
        </Form>
        {publishing && (
          <div style={{ color: "#888", fontSize: 12, marginTop: 8 }}>
            发布过程包含图片下载和本地化处理，可能需要 30-60 秒，请勿关闭此窗口。
          </div>
        )}
      </Modal>
    </div>
  );
}
