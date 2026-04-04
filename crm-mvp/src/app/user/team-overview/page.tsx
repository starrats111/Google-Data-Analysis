"use client";

import { useState, useEffect, useMemo, useCallback } from "react";
import {
  Card, Table, Tag, Statistic, Row, Col, Progress, Typography, Spin, Empty,
  Space, DatePicker, Button, Tooltip, notification,
} from "antd";
import {
  TeamOutlined, UserOutlined, TrophyOutlined, ReloadOutlined, SyncOutlined,
  CloudSyncOutlined,
} from "@ant-design/icons";
import dayjs, { Dayjs } from "dayjs";
import utc from "dayjs/plugin/utc";
import timezone from "dayjs/plugin/timezone";
import MemberDataModal from "@/components/team/MemberDataModal";

dayjs.extend(utc);
dayjs.extend(timezone);
const TZ = "Asia/Shanghai";

const { Title, Text } = Typography;
const { RangePicker } = DatePicker;

/** 自动刷新间隔（毫秒） */
const AUTO_REFRESH_INTERVAL = 60_000;

interface MemberRanking {
  user_id: string;
  username: string;
  display_name: string | null;
  cost: number;
  commission: number;
  rejected_commission: number;
  net_commission: number;
  roi: number;
  clicks: number;
}

export default function TeamOverviewPage() {
  const [memberRanking, setMemberRanking] = useState<MemberRanking[]>([]);
  const [memberCount, setMemberCount] = useState(0);
  const [loading, setLoading] = useState(false);
  const [syncing, setSyncing] = useState(false);
  const [lastUpdated, setLastUpdated] = useState<Dayjs | null>(null);
  const [dateRange, setDateRange] = useState<[Dayjs, Dayjs]>([
    dayjs().tz(TZ).startOf("month"),
    dayjs().tz(TZ),
  ]);

  // 数据看板弹窗
  const [modalState, setModalState] = useState<{
    open: boolean; userId: string | null; username?: string; displayName?: string;
  }>({ open: false, userId: null });

  // 团队汇总数据从员工数据派生，确保与排行榜数据完全一致
  const teamStats = useMemo(() => {
    if (memberRanking.length === 0 && memberCount === 0) return null;
    const total_cost = memberRanking.reduce((s, m) => s + m.cost, 0);
    const total_commission = memberRanking.reduce((s, m) => s + m.commission, 0);
    const rejected_commission = memberRanking.reduce((s, m) => s + m.rejected_commission, 0);
    const net_commission = memberRanking.reduce((s, m) => s + m.net_commission, 0);
    const avg_roi = total_cost > 0 ? (net_commission / total_cost) * 100 : 0;
    return {
      member_count: memberCount,
      total_cost: Math.round(total_cost * 100) / 100,
      total_commission: Math.round(total_commission * 100) / 100,
      rejected_commission: Math.round(rejected_commission * 100) / 100,
      net_commission: Math.round(net_commission * 100) / 100,
      avg_roi: Math.round(avg_roi * 10) / 10,
    };
  }, [memberRanking, memberCount]);

  const loadData = useCallback(async () => {
    setLoading(true);
    try {
      const params = new URLSearchParams({
        start_date: dateRange[0].format("YYYY-MM-DD"),
        end_date: dateRange[1].format("YYYY-MM-DD"),
      });
      const res = await fetch(`/api/user/team/stats?${params}`).then((r) => r.json());
      if (res.code === 0) {
        setMemberRanking(res.data.member_ranking);
        // 成员人数来自服务端（包含零数据成员）
        setMemberCount(res.data.team_stats?.member_count ?? res.data.member_ranking.length);
        setLastUpdated(dayjs().tz(TZ));
      }
    } catch (e) {
      console.error("加载小组数据失败:", e);
    } finally {
      setLoading(false);
    }
  }, [dateRange]);

  /** 同步所有组员今日费用 + 近 7 天佣金，完成后刷新统计 */
  const handleSync = useCallback(async () => {
    setSyncing(true);
    const key = "team-sync";
    notification.open({
      key,
      message: "正在同步数据",
      description: "正在拉取全员今日广告费用和近 7 天佣金，请稍候…",
      icon: <SyncOutlined spin style={{ color: "#1677ff" }} />,
      duration: 0,
    });
    try {
      const res = await fetch("/api/user/team/sync", { method: "POST" }).then((r) => r.json());
      if (res.code === 0) {
        const { summary } = res.data;
        notification.success({
          key,
          message: "同步完成",
          description: `已同步 ${summary.member_count} 名成员：广告数据 ${summary.ads_synced} 条，佣金数据 ${summary.txn_synced} 条`,
          duration: 5,
        });
      } else {
        notification.error({
          key,
          message: "同步失败",
          description: res.message || "未知错误",
          duration: 5,
        });
      }
    } catch (e) {
      console.error("同步失败:", e);
      notification.error({
        key,
        message: "同步失败",
        description: "网络错误，请稍后重试",
        duration: 5,
      });
    } finally {
      setSyncing(false);
      // 同步完成后刷新统计数据
      await loadData();
    }
  }, [loadData]);

  useEffect(() => { loadData(); }, [loadData]);

  // 自动轮询刷新
  useEffect(() => {
    const timer = setInterval(() => { loadData(); }, AUTO_REFRESH_INTERVAL);
    return () => clearInterval(timer);
  }, [loadData]);

  const handleViewMember = useCallback((record: MemberRanking) => {
    setModalState({
      open: true,
      userId: record.user_id,
      username: record.username,
      displayName: record.display_name || undefined,
    });
  }, []);

  const columns = useMemo(() => [
    {
      title: "排名", key: "rank", width: 70,
      render: (_: unknown, __: unknown, index: number) => {
        if (index === 0) return <Tag color="gold">1</Tag>;
        if (index === 1) return <Tag color="default">2</Tag>;
        if (index === 2) return <Tag color="orange">3</Tag>;
        return <Tag>{index + 1}</Tag>;
      },
    },
    {
      title: "组员", dataIndex: "username", key: "username",
      render: (text: string, record: MemberRanking) => (
        <Button type="link" style={{ padding: 0 }} onClick={() => handleViewMember(record)}>
          <Space>
            <UserOutlined />
            <Text strong>{record.display_name || text}</Text>
          </Space>
        </Button>
      ),
    },
    {
      title: "费用", dataIndex: "cost", key: "cost", align: "right" as const, width: 110,
      sorter: (a: MemberRanking, b: MemberRanking) => a.cost - b.cost,
      render: (v: number) => <Text style={{ color: "#cf1322" }}>${v.toFixed(2)}</Text>,
    },
    {
      title: "总佣金", dataIndex: "commission", key: "commission", align: "right" as const, width: 110,
      sorter: (a: MemberRanking, b: MemberRanking) => a.commission - b.commission,
      render: (v: number) => <Text style={{ color: "#4DA6FF" }}>${v.toFixed(2)}</Text>,
    },
    {
      title: "拒付", dataIndex: "rejected_commission", key: "rejected_commission", align: "right" as const, width: 100,
      sorter: (a: MemberRanking, b: MemberRanking) => a.rejected_commission - b.rejected_commission,
      render: (v: number) => <Text type="danger">${v.toFixed(2)}</Text>,
    },
    {
      title: "净佣金", dataIndex: "net_commission", key: "net_commission", align: "right" as const, width: 110,
      sorter: (a: MemberRanking, b: MemberRanking) => a.net_commission - b.net_commission,
      render: (v: number) => (
        <Text style={{ color: v >= 0 ? "#52c41a" : "#ff4d4f", fontWeight: 600 }}>
          {v >= 0 ? "+" : ""}${v.toFixed(2)}
        </Text>
      ),
    },
    {
      title: "ROI", dataIndex: "roi", key: "roi", align: "right" as const, width: 100,
      sorter: (a: MemberRanking, b: MemberRanking) => a.roi - b.roi,
      defaultSortOrder: "descend" as const,
      render: (v: number) => (
        <Tag color={v >= 20 ? "success" : v >= 0 ? "processing" : "error"} style={{ fontSize: 14 }}>
          {v >= 0 ? "+" : ""}{v.toFixed(1)}%
        </Tag>
      ),
    },
  ], [handleViewMember]);

  return (
    <div>
      <Title level={3}>
        <TeamOutlined style={{ marginRight: 12 }} />
        小组总览
      </Title>

      {/* 筛选栏 */}
      <Card size="small" style={{ marginBottom: 16 }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", flexWrap: "wrap", gap: 8 }}>
          <Space>
            <Text>日期范围：</Text>
            <RangePicker
              value={dateRange}
              onChange={(v) => { if (v?.[0] && v?.[1]) setDateRange([v[0], v[1]]); }}
              allowClear={false}
            />
            <Tooltip title="同步全员今日广告费用 + 近 7 天佣金数据">
              <Button
                type="primary"
                icon={<CloudSyncOutlined />}
                onClick={handleSync}
                loading={syncing}
                disabled={loading}
              >
                同步数据
              </Button>
            </Tooltip>
            <Button icon={<ReloadOutlined />} onClick={loadData} loading={loading} disabled={syncing}>
              刷新
            </Button>
          </Space>
          {lastUpdated && (
            <Tooltip title={`每 ${AUTO_REFRESH_INTERVAL / 1000} 秒自动刷新`}>
              <Space style={{ color: "#8c8c8c", fontSize: 12, cursor: "default" }}>
                <SyncOutlined spin={loading} />
                <span>上次更新：{lastUpdated.format("HH:mm:ss")}</span>
              </Space>
            </Tooltip>
          )}
        </div>
      </Card>

      <Spin spinning={loading}>
        {/* 小组统计卡片 */}
        {teamStats && (
          <Card
            style={{
              marginBottom: 24,
              borderLeft: `4px solid ${teamStats.avg_roi >= 0 ? "#52c41a" : "#ff4d4f"}`,
            }}
          >
            <Row gutter={16}>
              <Col xs={12} sm={8} md={4}>
                <Statistic title="小组成员" value={teamStats.member_count} suffix="人" prefix={<TeamOutlined />} />
              </Col>
              <Col xs={12} sm={8} md={4}>
                <Statistic title="总费用" value={teamStats.total_cost} precision={2} prefix="$"
                  styles={{ content: { color: "#cf1322" } }} />
              </Col>
              <Col xs={12} sm={8} md={4}>
                <Statistic title="总佣金" value={teamStats.total_commission} precision={2} prefix="$"
                  styles={{ content: { color: "#4DA6FF" } }} />
              </Col>
              <Col xs={12} sm={8} md={4}>
                <Statistic title="拒付佣金" value={teamStats.rejected_commission} precision={2} prefix="$"
                  styles={{ content: { color: "#ff4d4f" } }} />
              </Col>
              <Col xs={12} sm={8} md={4}>
                <Statistic title="净佣金" value={teamStats.net_commission} precision={2} prefix="$"
                  styles={{ content: { color: teamStats.net_commission >= 0 ? "#52c41a" : "#cf1322" } }} />
              </Col>
            </Row>
            <div style={{ marginTop: 16 }}>
              <Text type="secondary">平均 ROI</Text>
              <Progress
                percent={Math.min(Math.abs(teamStats.avg_roi), 200)}
                status={teamStats.avg_roi >= 0 ? "success" : "exception"}
                format={() => `${teamStats.avg_roi >= 0 ? "+" : ""}${teamStats.avg_roi}%`}
                strokeWidth={12}
              />
            </div>
          </Card>
        )}

        {/* 组员排行榜 */}
        <Card title={<><TrophyOutlined style={{ marginRight: 8, color: "#faad14" }} />组员排行榜 (按ROI)</>}>
          {memberRanking.length > 0 ? (
            <Table
              dataSource={memberRanking}
              rowKey="user_id"
              pagination={false}
              columns={columns}
            />
          ) : (
            <Empty description="暂无数据" />
          )}
        </Card>
      </Spin>

      <MemberDataModal
        open={modalState.open}
        userId={modalState.userId}
        username={modalState.username}
        displayName={modalState.displayName}
        onClose={() => setModalState({ open: false, userId: null })}
      />
    </div>
  );
}
