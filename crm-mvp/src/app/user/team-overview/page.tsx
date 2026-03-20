"use client";

import { useState, useEffect, useMemo, useCallback } from "react";
import {
  Card, Table, Tag, Statistic, Row, Col, Progress, Typography, Spin, Empty,
  Space, DatePicker, Button,
} from "antd";
import {
  TeamOutlined, UserOutlined, TrophyOutlined, ReloadOutlined,
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

interface TeamStats {
  member_count: number;
  total_cost: number;
  total_commission: number;
  rejected_commission: number;
  net_commission: number;
  total_profit: number;
  avg_roi: number;
}

interface MemberRanking {
  user_id: string;
  username: string;
  display_name: string | null;
  cost: number;
  commission: number;
  rejected_commission: number;
  net_commission: number;
  profit: number;
  roi: number;
  clicks: number;
}

export default function TeamOverviewPage() {
  const [teamStats, setTeamStats] = useState<TeamStats | null>(null);
  const [memberRanking, setMemberRanking] = useState<MemberRanking[]>([]);
  const [loading, setLoading] = useState(false);
  const [dateRange, setDateRange] = useState<[Dayjs, Dayjs]>([
    dayjs().tz(TZ).startOf("month"),
    dayjs().tz(TZ),
  ]);

  // 数据看板弹窗
  const [modalState, setModalState] = useState<{
    open: boolean; userId: string | null; username?: string; displayName?: string;
  }>({ open: false, userId: null });

  const loadData = useCallback(async () => {
    setLoading(true);
    try {
      const params = new URLSearchParams({
        start_date: dateRange[0].format("YYYY-MM-DD"),
        end_date: dateRange[1].format("YYYY-MM-DD"),
      });
      const res = await fetch(`/api/user/team/stats?${params}`).then((r) => r.json());
      if (res.code === 0) {
        setTeamStats(res.data.team_stats);
        setMemberRanking(res.data.member_ranking);
      }
    } catch (e) {
      console.error("加载小组数据失败:", e);
    } finally {
      setLoading(false);
    }
  }, [dateRange]);

  useEffect(() => { loadData(); }, [loadData]);

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
        <Space>
          <Text>日期范围：</Text>
          <RangePicker
            value={dateRange}
            onChange={(v) => { if (v?.[0] && v?.[1]) setDateRange([v[0], v[1]]); }}
            allowClear={false}
          />
          <Button icon={<ReloadOutlined />} onClick={loadData} loading={loading}>刷新</Button>
        </Space>
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
                  styles={{ content: { color: "#52c41a" } }} />
              </Col>
              <Col xs={12} sm={8} md={4}>
                <Statistic title="总利润" value={teamStats.total_profit} precision={2} prefix="$"
                  styles={{ content: { color: teamStats.total_profit >= 0 ? "#3f8600" : "#cf1322" } }} />
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
