"use client";

import { useState, useEffect, useMemo, useCallback, useRef } from "react";
import {
  Card, Table, Tag, Typography, Spin, Empty,
  Space, DatePicker, Button, Tooltip, notification, Badge, App,
} from "antd";
import {
  TeamOutlined, UserOutlined, TrophyOutlined, ReloadOutlined, SyncOutlined,
  CloudSyncOutlined, ShopOutlined, ClockCircleOutlined, RocketOutlined,
} from "@ant-design/icons";
import dayjs, { Dayjs } from "dayjs";
import utc from "dayjs/plugin/utc";
import timezone from "dayjs/plugin/timezone";
import MemberDataModal from "@/components/team/MemberDataModal";
import AppPageHeader from "@/components/AppPageHeader";

dayjs.extend(utc);
dayjs.extend(timezone);
const TZ = "Asia/Shanghai";

const { Text } = Typography;
const { RangePicker } = DatePicker;

/** 自动刷新间隔（毫秒）—— 30 秒保证数据接近实时 */
const AUTO_REFRESH_INTERVAL = 30_000;

interface MemberRanking {
  user_id: string;
  username: string;
  display_name: string | null;
  status: string;
  today_merchants: number | null;
  today_ads: number | null;
  /** 是否已配置统一脚本（MCC sheet_url），false 时「今日投放」列显示备注 */
  script_configured?: boolean;
  active_merchants: number;
  cost: number;
  commission: number;
  rejected_commission: number;
  net_commission: number;
  roi: number;
  clicks: number;
}

interface TeamStats {
  member_count: number;
  active_merchants: number;
  today_ads: number;
  total_cost: number;
  total_commission: number;
  rejected_commission: number;
  net_commission: number;
  avg_roi: number;
}

export default function TeamOverviewPage() {
  const { message } = App.useApp();
  const [memberRanking, setMemberRanking] = useState<MemberRanking[]>([]);
  const [memberCount, setMemberCount] = useState(0);
  const [teamActiveMerchants, setTeamActiveMerchants] = useState(0);
  const [teamTodayAds, setTeamTodayAds] = useState(0);
  const [loading, setLoading] = useState(false);
  const [syncing, setSyncing] = useState(false);
  const [lastUpdated, setLastUpdated] = useState<Dayjs | null>(null);
  const [countdown, setCountdown] = useState(AUTO_REFRESH_INTERVAL / 1000);
  const [dateRange, setDateRange] = useState<[Dayjs, Dayjs]>([
    dayjs().tz(TZ).startOf("month"),
    dayjs().tz(TZ),
  ]);

  // 数据看板弹窗
  const [modalState, setModalState] = useState<{
    open: boolean; userId: string | null; username?: string; displayName?: string;
  }>({ open: false, userId: null });

  // 团队汇总数据从员工数据派生，确保与排行榜数据完全一致
  const teamStats = useMemo((): TeamStats | null => {
    if (memberRanking.length === 0 && memberCount === 0) return null;
    const total_cost = memberRanking.reduce((s, m) => s + m.cost, 0);
    const total_commission = memberRanking.reduce((s, m) => s + m.commission, 0);
    const rejected_commission = memberRanking.reduce((s, m) => s + m.rejected_commission, 0);
    const net_commission = memberRanking.reduce((s, m) => s + m.net_commission, 0);
    const avg_roi = total_cost > 0 ? (net_commission / total_cost) * 100 : 0;
    return {
      member_count: memberCount,
      active_merchants: teamActiveMerchants,
      today_ads: teamTodayAds,
      total_cost: Math.round(total_cost * 100) / 100,
      total_commission: Math.round(total_commission * 100) / 100,
      rejected_commission: Math.round(rejected_commission * 100) / 100,
      net_commission: Math.round(net_commission * 100) / 100,
      avg_roi: Math.round(avg_roi * 10) / 10,
    };
  }, [memberRanking, memberCount, teamActiveMerchants, teamTodayAds]);

  const loadData = useCallback(async (opts?: { silent?: boolean }) => {
    const silent = opts?.silent === true;
    setLoading(true);
    try {
      const params = new URLSearchParams({
        start_date: dateRange[0].format("YYYY-MM-DD"),
        end_date: dateRange[1].format("YYYY-MM-DD"),
      });
      const res = await fetch(`/api/user/team/stats?${params}`).then((r) => r.json());
      if (res.code === 0) {
        setMemberRanking(res.data.member_ranking);
        setMemberCount(res.data.team_stats?.member_count ?? res.data.member_ranking.length);
        setTeamActiveMerchants(res.data.team_stats?.active_merchants ?? 0);
        setTeamTodayAds(res.data.team_stats?.today_ads ?? 0);
        setLastUpdated(dayjs().tz(TZ));
        setCountdown(AUTO_REFRESH_INTERVAL / 1000);
      } else if (!silent) {
        message.error(res.message || "加载小组数据失败");
      }
    } catch (e) {
      console.error("加载小组数据失败:", e);
      if (!silent) message.error("加载小组数据失败，请重试");
    } finally {
      setLoading(false);
    }
  }, [dateRange, message]);

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
      await loadData();
    }
  }, [loadData]);

  useEffect(() => { loadData(); }, [loadData]);

  // 自动轮询刷新（30 秒）
  const loadDataRef = useRef(loadData);
  loadDataRef.current = loadData;
  useEffect(() => {
    const timer = setInterval(() => { loadDataRef.current({ silent: true }); }, AUTO_REFRESH_INTERVAL);
    return () => clearInterval(timer);
  }, []);

  // 倒计时显示
  useEffect(() => {
    const tick = setInterval(() => {
      setCountdown((c) => (c <= 1 ? AUTO_REFRESH_INTERVAL / 1000 : c - 1));
    }, 1000);
    return () => clearInterval(tick);
  }, []);

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
      title: "排名", key: "rank", width: 60,
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
            {record.status === "inactive" && <Tag color="default" style={{ fontSize: 11 }}>停用</Tag>}
          </Space>
        </Button>
      ),
    },
    {
      title: (
        <Tooltip title="每 30 分钟从 Google Sheet 同步，统计今日新建（CST）且历史没出现过同名系列的广告数量">
          今日投放广告
        </Tooltip>
      ),
      dataIndex: "today_ads",
      key: "today_ads",
      align: "center" as const,
      width: 140,
      sorter: (a: MemberRanking, b: MemberRanking) =>
        (a.today_ads ?? -1) - (b.today_ads ?? -1),
      render: (v: number | null, record: MemberRanking) => {
        if (record.script_configured === false) {
          return (
            <Tooltip title="该成员没有已配置 Google Sheet 的 MCC 统一脚本，无法统计今日投放">
              <Text style={{ fontSize: 11, color: "#fa8c16" }}>脚本未同步，需同步配置脚本</Text>
            </Tooltip>
          );
        }
        if (v === null) return <Text type="secondary" style={{ fontSize: 11 }}>未同步</Text>;
        return v > 0
          ? <Badge count={v} color="#1677ff" overflowCount={999} style={{ fontSize: 12 }} />
          : <Text type="secondary">—</Text>;
      },
    },
    {
      title: "在跑商家",
      dataIndex: "active_merchants",
      key: "active_merchants",
      align: "center" as const,
      width: 100,
      sorter: (a: MemberRanking, b: MemberRanking) => a.active_merchants - b.active_merchants,
      render: (v: number) => (
        v > 0
          ? <Badge count={v} color="#52c41a" overflowCount={99} style={{ fontSize: 12 }} />
          : <Text type="secondary">—</Text>
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
      <AppPageHeader icon={<TeamOutlined />} title="小组总览" />

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
            <Button icon={<ReloadOutlined />} onClick={() => loadData()} loading={loading} disabled={syncing}>
              刷新
            </Button>
          </Space>
          <Space style={{ color: "#8c8c8c", fontSize: 12 }}>
            {lastUpdated && (
              <>
                <SyncOutlined spin={loading} />
                <span>上次更新：{lastUpdated.format("HH:mm:ss")}</span>
                <Tooltip title={`每 ${AUTO_REFRESH_INTERVAL / 1000} 秒自动刷新`}>
                  <Space style={{ cursor: "default" }}>
                    <ClockCircleOutlined />
                    <span style={{ color: countdown <= 5 ? "#faad14" : "#8c8c8c" }}>
                      {countdown}s 后刷新
                    </span>
                  </Space>
                </Tooltip>
              </>
            )}
          </Space>
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
            <div
              style={{
                display: "flex",
                flexWrap: "wrap",
                alignItems: "center",
                gap: "8px 0",
              }}
            >
              {[
                {
                  key: "members",
                  title: <><TeamOutlined /> 小组成员</>,
                  value: `${teamStats.member_count} 人`,
                  color: undefined as string | undefined,
                  tooltip: undefined as string | undefined,
                },
                {
                  key: "today_ads",
                  title: <><RocketOutlined /> 今日投放</>,
                  value: `${teamStats.today_ads} 条`,
                  color: teamStats.today_ads > 0 ? "#1677ff" : "#8c8c8c",
                  tooltip: "全组今日新建（CST）且历史没出现过同名系列的广告数量，每 30 分钟同步",
                },
                {
                  key: "active_merchants",
                  title: <><ShopOutlined /> 在跑商家</>,
                  value: `${teamStats.active_merchants} 家`,
                  color: teamStats.active_merchants > 0 ? "#52c41a" : "#8c8c8c",
                  tooltip: "全组正在跑广告的商家数（跨成员去重）",
                },
                {
                  key: "cost",
                  title: "总费用",
                  value: `$${teamStats.total_cost.toFixed(2)}`,
                  color: "#cf1322",
                  tooltip: undefined,
                },
                {
                  key: "commission",
                  title: "总佣金",
                  value: `$${teamStats.total_commission.toFixed(2)}`,
                  color: "#4DA6FF",
                  tooltip: undefined,
                },
                {
                  key: "rejected",
                  title: "拒付佣金",
                  value: `$${teamStats.rejected_commission.toFixed(2)}`,
                  color: "#ff4d4f",
                  tooltip: undefined,
                },
                {
                  key: "net",
                  title: "净佣金",
                  value: `$${teamStats.net_commission.toFixed(2)}`,
                  color: teamStats.net_commission >= 0 ? "#52c41a" : "#cf1322",
                  tooltip: undefined,
                },
                {
                  key: "roi",
                  title: "平均 ROI",
                  value: `${teamStats.avg_roi >= 0 ? "+" : ""}${teamStats.avg_roi}%`,
                  color: teamStats.avg_roi >= 0 ? "#52c41a" : "#ff4d4f",
                  tooltip: "净佣金 / 总费用",
                },
              ].map((item, idx) => {
                const cell = (
                  <div
                    key={item.key}
                    style={{
                      flex: "1 1 0",
                      minWidth: 110,
                      textAlign: "center",
                      borderLeft: idx > 0 ? "1px solid #f0f0f0" : "none",
                      padding: "0 8px",
                    }}
                  >
                    <div style={{ fontSize: 13, color: "#8c8c8c", marginBottom: 4, whiteSpace: "nowrap" }}>
                      {item.title}
                    </div>
                    <div
                      style={{
                        fontSize: 20,
                        fontWeight: 600,
                        color: item.color ?? "rgba(0,0,0,0.88)",
                        whiteSpace: "nowrap",
                      }}
                    >
                      {item.value}
                    </div>
                  </div>
                );
                return item.tooltip ? (
                  <Tooltip key={item.key} title={item.tooltip}>{cell}</Tooltip>
                ) : cell;
              })}
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
              rowClassName={(record) => record.active_merchants > 0 ? "" : "row-no-active"}
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
