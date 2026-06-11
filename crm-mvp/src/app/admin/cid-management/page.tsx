"use client";

import { Table, Button, Tag, Space, Typography, App, Select, Card, Tooltip, Empty, Alert } from "antd";
import { ClusterOutlined, SyncOutlined, DeleteOutlined, ReloadOutlined } from "@ant-design/icons";
import { useState, useCallback } from "react";
import { useApi, mutateApi } from "@/lib/swr";
import AppPageHeader from "@/components/AppPageHeader";

const { Text } = Typography;

interface Employee {
  user_id: string;
  username: string;
  display_name: string | null;
  role: string;
  mcc_count: number;
}

interface Cid {
  id: string;
  customer_id: string;
  customer_name: string | null;
  status: string;
  is_available: string;
  last_synced_at: string | null;
  enabled_count: number;
  paused_count: number;
  removed_count: number;
}

interface MccGroup {
  mcc_account_id: string;
  mcc_id: string;
  mcc_name: string | null;
  currency: string;
  credentials_ready: boolean;
  cids: Cid[];
}

function formatCid(id: string): string {
  const d = (id || "").replace(/\D/g, "");
  if (d.length === 10) return `${d.slice(0, 3)}-${d.slice(3, 6)}-${d.slice(6)}`;
  return id;
}

function statusTag(status: string) {
  if (status === "cancelled") return <Tag color="red">已撤销</Tag>;
  if (status === "suspended") return <Tag color="orange">已暂停</Tag>;
  return <Tag color="green">有效</Tag>;
}

export default function CidManagementPage() {
  const { message, modal } = App.useApp();
  const [selectedUser, setSelectedUser] = useState<string | undefined>(undefined);
  const [syncingMcc, setSyncingMcc] = useState<string | null>(null);
  const [revoking, setRevoking] = useState<string | null>(null);

  const { data: empData, isLoading: empLoading } = useApi<{ employees: Employee[] }>("/api/admin/cid-management");
  const employees = empData?.employees || [];

  const { data: treeData, isLoading: treeLoading, mutate: treeMutate } = useApi<{
    user: { user_id: string; username: string; display_name: string | null } | null;
    mccs: MccGroup[];
  }>(selectedUser ? `/api/admin/cid-management?user_id=${selectedUser}` : null);

  const doSync = useCallback(async (mcc: MccGroup) => {
    setSyncingMcc(mcc.mcc_account_id);
    try {
      const res = await mutateApi("/api/admin/cid-management/sync", { method: "POST", body: { mcc_account_id: mcc.mcc_account_id } });
      if (res.code === 0) {
        const d = res.data as { created: number; updated: number; cancelled: number; total: number };
        message.success(`同步完成：新增 ${d.created} / 更新 ${d.updated} / 标撤销 ${d.cancelled}（Google 当前 ${d.total} 个）`);
        treeMutate();
      } else {
        message.error(res.message || "同步失败");
      }
    } catch (e) {
      message.error(e instanceof Error ? e.message : "同步失败");
    } finally {
      setSyncingMcc(null);
    }
  }, [message, treeMutate]);

  const doRevoke = useCallback((mcc: MccGroup, cid: Cid) => {
    modal.confirm({
      title: "确认撤销该 CID？此操作不可逆",
      width: 540,
      okText: "确认撤销",
      okButtonProps: { danger: true },
      cancelText: "取消",
      content: (
        <div style={{ fontSize: 13 }}>
          <p style={{ margin: "8px 0" }}>
            将把 CID <Text strong>{formatCid(cid.customer_id)}</Text>
            {cid.customer_name ? `（${cid.customer_name}）` : ""} 从 MCC
            <Text strong> {mcc.mcc_name || mcc.mcc_id}</Text> 解绑，并通过 Google Ads API 同步移除该关联。
          </p>
          {cid.enabled_count > 0 && (
            <Alert
              type="warning"
              showIcon
              style={{ margin: "8px 0" }}
              message={`该 CID 下当前有 ${cid.enabled_count} 个 ENABLED 在投广告系列`}
              description="确认后将先把这些广告系列在本地标记为暂停/已移除，再执行解绑。"
            />
          )}
          <Alert
            type="error"
            showIcon
            style={{ margin: "8px 0" }}
            message="解绑不可逆"
            description="解绑后该 MCC 不再管理此账户、也拉不到其数据；如需恢复，需在 Google Ads 重新邀请并由对方接受。"
          />
        </div>
      ),
      onOk: async () => {
        setRevoking(cid.id);
        try {
          const res = await mutateApi("/api/admin/cid-management/revoke", {
            method: "POST",
            body: { mcc_account_id: mcc.mcc_account_id, customer_id: cid.customer_id },
          });
          if (res.code === 0) {
            const d = res.data as { message?: string };
            message.success(d?.message || "撤销成功");
            treeMutate();
          } else {
            message.error(res.message || "撤销失败");
            return Promise.reject(new Error(res.message || "撤销失败"));
          }
        } catch (e) {
          message.error(e instanceof Error ? e.message : "撤销失败");
          return Promise.reject(e);
        } finally {
          setRevoking(null);
        }
      },
    });
  }, [modal, message, treeMutate]);

  const buildColumns = useCallback((mcc: MccGroup) => [
    { title: "CID", dataIndex: "customer_id", width: 140, render: (v: string) => <Text copyable={{ text: v }} style={{ fontFamily: "monospace" }}>{formatCid(v)}</Text> },
    { title: "账户名称", dataIndex: "customer_name", ellipsis: true, render: (v: string | null) => v || <Text type="secondary">-</Text> },
    { title: "状态", dataIndex: "status", width: 90, align: "center" as const, render: (v: string) => statusTag(v) },
    { title: "在投", dataIndex: "enabled_count", width: 70, align: "center" as const, render: (v: number) => v > 0 ? <Text strong style={{ color: "#52c41a" }}>{v}</Text> : <Text type="secondary">0</Text> },
    { title: "暂停", dataIndex: "paused_count", width: 70, align: "center" as const, render: (v: number) => <Text type="secondary">{v || 0}</Text> },
    { title: "已移除", dataIndex: "removed_count", width: 80, align: "center" as const, render: (v: number) => <Text type="secondary">{v || 0}</Text> },
    {
      title: "操作", width: 110, align: "center" as const, render: (_: unknown, cid: Cid) => {
        if (cid.status === "cancelled") return <Text type="secondary">已撤销</Text>;
        if (!mcc.credentials_ready) {
          return <Tooltip title="该 MCC 未配置服务账号/Developer Token，无法解绑"><Button size="small" danger disabled>撤销</Button></Tooltip>;
        }
        return (
          <Button size="small" danger icon={<DeleteOutlined />} loading={revoking === cid.id} onClick={() => doRevoke(mcc, cid)}>撤销</Button>
        );
      },
    },
  ], [doRevoke, revoking]);

  return (
    <div>
      <AppPageHeader
        icon={<ClusterOutlined />}
        title="员工 CID 管理"
        subtitle="按员工 MCC 维度查看与管理 CID，可一键撤销并同步从 Google Ads 解绑"
        extra={
          <Space>
            <Select
              showSearch
              allowClear
              placeholder={empLoading ? "加载中..." : "选择员工"}
              style={{ width: 260 }}
              value={selectedUser}
              onChange={(v) => setSelectedUser(v)}
              optionFilterProp="label"
              options={employees.map((e) => ({
                value: e.user_id,
                label: `${e.display_name || e.username}（${e.username}）· ${e.mcc_count} MCC`,
              }))}
            />
          </Space>
        }
      />

      {!selectedUser && (
        <Card>
          <Empty description="请选择一个员工以查看其 MCC 与 CID" />
        </Card>
      )}

      {selectedUser && treeLoading && (
        <Card loading />
      )}

      {selectedUser && !treeLoading && (treeData?.mccs?.length || 0) === 0 && (
        <Card><Empty description="该员工暂无有效 MCC" /></Card>
      )}

      {selectedUser && !treeLoading && (treeData?.mccs || []).map((mcc) => (
        <Card
          key={mcc.mcc_account_id}
          style={{ marginBottom: 16 }}
          title={
            <Space wrap>
              <Text strong>{mcc.mcc_name || "（未命名 MCC）"}</Text>
              <Text type="secondary" style={{ fontFamily: "monospace" }}>{formatCid(mcc.mcc_id)}</Text>
              <Tag>{mcc.currency}</Tag>
              {!mcc.credentials_ready && <Tag color="orange">未配置凭证</Tag>}
            </Space>
          }
          extra={
            <Tooltip title={mcc.credentials_ready ? "从 Google Ads 重新拉取该 MCC 下的 CID 列表" : "该 MCC 未配置服务账号/Developer Token"}>
              <Button
                size="small"
                icon={syncingMcc === mcc.mcc_account_id ? <SyncOutlined spin /> : <ReloadOutlined />}
                disabled={!mcc.credentials_ready || syncingMcc === mcc.mcc_account_id}
                onClick={() => doSync(mcc)}
              >
                同步 CID
              </Button>
            </Tooltip>
          }
        >
          <Table
            rowKey="id"
            size="small"
            dataSource={mcc.cids}
            columns={buildColumns(mcc)}
            pagination={mcc.cids.length > 20 ? { pageSize: 20, showSizeChanger: false } : false}
            locale={{ emptyText: <Empty description="该 MCC 下暂无 CID，点击右上角「同步 CID」拉取" /> }}
          />
        </Card>
      ))}
    </div>
  );
}
