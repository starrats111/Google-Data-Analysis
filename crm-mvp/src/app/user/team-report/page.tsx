"use client";

import { useState, useEffect, useMemo, useCallback } from "react";
import {
  Card, Select, Button, Table, Typography, Space, Tabs, Spin, Empty,
  Statistic, Row, Col, Tag, Tooltip, App,
} from "antd";
import {
  FileExcelOutlined, ReloadOutlined, BarChartOutlined,
  DollarOutlined, MinusCircleOutlined, CheckCircleOutlined,
} from "@ant-design/icons";
import type { ColumnsType } from "antd/es/table";
import dayjs from "dayjs";
import AppPageHeader from "@/components/AppPageHeader";

const { Text } = Typography;
const { Option } = Select;

// ────────── 类型定义 ──────────────────────────────────────────────────────────
interface Member { id: string; username: string; display_name: string }
interface PlatformStat { total: number; rejected: number; active: number }
interface ReportData {
  year: number;
  members: Member[];
  platforms: string[];
  months: string[];
  data: Record<string, Record<string, Record<string, PlatformStat>>>;
  adSpend: Record<string, Record<string, number>>;
}

// 指标行定义
const METRICS = [
  { key: "adSpend",  label: "广告费",   color: "#595959" },
  { key: "total",    label: "总佣金收入", color: "#1677ff" },
  { key: "rejected", label: "拒付佣金",  color: "#cf1322" },
  { key: "active",   label: "有效佣金",  color: "#389e0d" },
  { key: "net",      label: "净收益",    color: "#fa8c16" },
] as const;

type MetricKey = typeof METRICS[number]["key"];

// ────────── 工具函数 ──────────────────────────────────────────────────────────
function fmt(n: number): string {
  if (!n) return "$0.00";
  return (n < 0 ? "-$" : "$") + Math.abs(n).toFixed(2);
}

function monthLabel(m: string): string {
  return m.slice(5).replace(/^0/, "") + "月";
}

// ────────── 主页面 ─────────────────────────────────────────────────────────────
export default function TeamReportPage() {
  const { message } = App.useApp();
  const [year, setYear] = useState<number>(dayjs().year());
  const [loading, setLoading] = useState(false);
  const [report, setReport] = useState<ReportData | null>(null);
  const [activeMonth, setActiveMonth] = useState<string>("annual");

  // 年份选项（近5年）
  const yearOptions = useMemo(() => {
    const cur = dayjs().year();
    return Array.from({ length: 5 }, (_, i) => cur - i);
  }, []);

  // ── 拉取数据 ────────────────────────────────────────────────────────
  const fetchReport = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch(`/api/user/team/report?year=${year}`).then((r) => r.json());
      if (res.code === 0) {
        setReport(res.data);
      } else {
        message.error(res.message || "获取报表失败");
      }
    } catch {
      message.error("网络错误");
    } finally {
      setLoading(false);
    }
  }, [year, message]);

  useEffect(() => { fetchReport(); }, [fetchReport]);

  // ── 计算汇总值 ──────────────────────────────────────────────────────
  const getStat = useCallback((
    metric: MetricKey,
    monthKey: string | null,  // null = 全年
    userId: string | null,    // null = 全组
    platform: string | null   // null = 全平台
  ): number => {
    if (!report) return 0;
    if (metric === "net") {
      // 平台列：只显示有效佣金（广告费无法按平台拆分，不在此扣）
      // 小计/合计列（platform===null）：有效佣金 - 广告费 = 真实净收益
      const active = getStat("active", monthKey, userId, platform);
      const spend  = platform === null ? getStat("adSpend", monthKey, userId, null) : 0;
      return active - spend;
    }

    const months = monthKey ? [monthKey] : report.months;
    const userIds = userId ? [userId] : report.members.map((m) => m.id);
    let total = 0;

    for (const m of months) {
      for (const uid of userIds) {
        if (metric === "adSpend") {
          // 广告费无平台维度：只有"全平台汇总"(platform===null)才返回实际值
          if (platform !== null) return 0;
          total += report.adSpend[m]?.[uid] || 0;
          continue;
        }
        const userData = report.data[m]?.[uid];
        if (!userData) continue;
        const platforms = platform ? [platform] : Object.keys(userData);
        for (const p of platforms) {
          const stat = userData[p];
          if (!stat) continue;
          if (metric === "total")    total += stat.total;
          if (metric === "rejected") total += stat.rejected;
          if (metric === "active")   total += stat.active;
        }
      }
    }
    return total;
  }, [report]);

  // ── 月度选项卡 ──────────────────────────────────────────────────────
  const tabItems = useMemo(() => {
    if (!report) return [];
    return [
      { key: "annual", label: "全年汇总" },
      ...report.months.map((m) => ({ key: m, label: monthLabel(m) })),
    ];
  }, [report]);

  // ── 生成月度表格（按指标×用户 pivot） ──────────────────────────────
  const monthlyTableData = useMemo(() => {
    if (!report) return { columns: [], dataSource: [] };
    const isAnnual = activeMonth === "annual";
    const months = isAnnual ? report.months : [activeMonth];

    // 列：指标 | 合计[平台...+小计] | 成员1[平台...+小计] | ...
    const fixedCol: ColumnsType<Record<string, number | string>> = [
      {
        title: "指标",
        dataIndex: "metric",
        key: "metric",
        fixed: "left" as const,
        width: 110,
        render: (v: string) => {
          const m = METRICS.find((x) => x.key === v);
          return m ? <Text strong style={{ color: m.color }}>{m.label}</Text> : v;
        },
      },
    ];

    // 动态列：全年汇总时列是每月；单月时列是平台
    let dynamicCols: ColumnsType<Record<string, number | string>>;

    if (isAnnual) {
      // 全年视图：列 = 每月 + 年合计
      dynamicCols = [
        ...report.months.map((m) => ({
          title: monthLabel(m),
          dataIndex: m,
          key: m,
          width: 90,
          align: "right" as const,
          render: (v: number) => (
            <Text style={{ fontSize: 12, color: v < 0 ? "#cf1322" : undefined }}>
              {fmt(v)}
            </Text>
          ),
        })),
        {
          title: "年合计",
          dataIndex: "_year",
          key: "_year",
          width: 110,
          fixed: "right" as const,
          align: "right" as const,
          render: (v: number) => (
            <Text strong style={{ color: v < 0 ? "#cf1322" : "#1677ff" }}>{fmt(v)}</Text>
          ),
        },
      ];

      const dataSource = METRICS.map(({ key }) => {
        const row: Record<string, number | string> = { metric: key, _key: key };
        let yearTotal = 0;
        for (const m of report.months) {
          const val = getStat(key as MetricKey, m, null, null);
          row[m] = val;
          yearTotal += key === "net" ? val : val;
        }
        // net 是 active - adSpend，已在 getStat 中计算，不能累加
        if (key === "net") {
          row["_year"] = getStat("net", null, null, null);
        } else {
          row["_year"] = yearTotal;
        }
        return row;
      });

      return { columns: [...fixedCol, ...dynamicCols], dataSource };
    }

    // 单月视图：列 = 合计列组 | 成员列组...
    const buildMemberCols = (uid: string | null, labelPrefix: string): ColumnsType<Record<string, number | string>> => {
      const platformCols = report.platforms.map((p) => ({
        title: p,
        dataIndex: `${uid ?? "_all"}_${p}`,
        key: `${uid ?? "_all"}_${p}`,
        width: 80,
        align: "right" as const,
        render: (v: number) => v ? <Text style={{ fontSize: 12 }}>{fmt(v)}</Text> : <Text type="secondary" style={{ fontSize: 11 }}>—</Text>,
      }));
      const subtotalCol = {
        title: "小计",
        dataIndex: `${uid ?? "_all"}_sub`,
        key: `${uid ?? "_all"}_sub`,
        width: 95,
        align: "right" as const,
        render: (v: number) => (
          <Text strong style={{ color: v < 0 ? "#cf1322" : undefined }}>{fmt(v)}</Text>
        ),
      };
      return [{
        title: labelPrefix,
        children: [...platformCols, subtotalCol],
      } as ColumnsType<Record<string, number | string>>[number]];
    };

    dynamicCols = [
      ...buildMemberCols(null, "合计"),
      ...report.members.map((mem) => buildMemberCols(mem.id, mem.display_name)),
    ].flat();

    const dataSource = METRICS.map(({ key }) => {
      const row: Record<string, number | string> = { metric: key, _key: key };
      // 合计列
      for (const p of report.platforms) {
        const val = getStat(key as MetricKey, activeMonth, null, p);
        row[`_all_${p}`] = val;
      }
      row["_all_sub"] = getStat(key as MetricKey, activeMonth, null, null);

      // 各成员列
      for (const mem of report.members) {
        for (const p of report.platforms) {
          const val = getStat(key as MetricKey, activeMonth, mem.id, p);
          row[`${mem.id}_${p}`] = val;
        }
        row[`${mem.id}_sub`] = getStat(key as MetricKey, activeMonth, mem.id, null);
      }
      return row;
    });

    return { columns: [...fixedCol, ...dynamicCols], dataSource };
  }, [report, activeMonth, getStat]);

  // ── Excel 导出（调用服务端，保留完整格式） ──────────────────────────
  const handleExport = useCallback(async () => {
    if (!report) return;
    const hide = message.loading("正在生成 Excel，请稍候...", 0);
    try {
      const res = await fetch(`/api/user/team/report/export?year=${year}`);
      if (!res.ok) throw new Error(await res.text());
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `${year}年度收支报表.xlsx`;
      a.click();
      URL.revokeObjectURL(url);
      hide();
      message.success("Excel 已导出");
    } catch (e) {
      hide();
      message.error("导出失败：" + String(e));
    }
  }, [report, year, message]);

  // ── 顶部汇总卡片 ────────────────────────────────────────────────────
  const summaryStats = useMemo(() => {
    if (!report) return null;
    const mKey = activeMonth === "annual" ? null : activeMonth;
    return {
      adSpend:  getStat("adSpend",  mKey, null, null),
      total:    getStat("total",    mKey, null, null),
      rejected: getStat("rejected", mKey, null, null),
      active:   getStat("active",   mKey, null, null),
      net:      getStat("net",      mKey, null, null),
    };
  }, [report, activeMonth, getStat]);

  // ── 渲染 ────────────────────────────────────────────────────────────
  return (
    <div style={{ padding: "16px 24px" }}>
      <Space direction="vertical" style={{ width: "100%" }} size={16}>
        <AppPageHeader
          icon={<BarChartOutlined />}
          title="团队收支报表"
          marginBottom={0}
          extra={
            <Space>
              <Select value={year} onChange={(v) => setYear(v)} style={{ width: 100 }}>
                {yearOptions.map((y) => <Option key={y} value={y}>{y}年</Option>)}
              </Select>
              <Button icon={<ReloadOutlined />} onClick={fetchReport} loading={loading}>刷新</Button>
              <Button
                type="primary"
                icon={<FileExcelOutlined />}
                onClick={handleExport}
                disabled={!report}
                style={{ background: "#217346", borderColor: "#217346" }}
              >
                导出 Excel
              </Button>
            </Space>
          }
        />

        {/* 汇总卡片 */}
        {summaryStats && (
          <Row gutter={[12, 12]}>
            {[
              { label: "广告费", value: summaryStats.adSpend, icon: <DollarOutlined />, color: "#595959" },
              { label: "总佣金", value: summaryStats.total,   icon: <BarChartOutlined />, color: "#1677ff" },
              { label: "拒付佣金", value: summaryStats.rejected, icon: <MinusCircleOutlined />, color: "#cf1322" },
              { label: "有效佣金", value: summaryStats.active,  icon: <CheckCircleOutlined />, color: "#389e0d" },
              { label: "净收益",  value: summaryStats.net,   icon: <DollarOutlined />, color: summaryStats.net >= 0 ? "#fa8c16" : "#cf1322" },
            ].map(({ label, value, icon, color }) => (
              <Col key={label} xs={12} sm={8} md={4} lg={4}>
                <Card size="small" styles={{ body: { padding: "10px 14px" } }}>
                  <Statistic
                    title={<Text style={{ fontSize: 12 }}>{icon} {label}</Text>}
                    value={Math.abs(value)}
                    prefix={value < 0 ? "-$" : "$"}
                    precision={2}
                    valueStyle={{ fontSize: 18, color }}
                  />
                </Card>
              </Col>
            ))}
          </Row>
        )}

        {/* 月份选项卡 + 表格 */}
        <Card
          size="small"
          styles={{ body: { padding: "12px 8px" } }}
          title={
            <Tabs
              activeKey={activeMonth}
              onChange={setActiveMonth}
              size="small"
              items={tabItems}
              tabBarStyle={{ marginBottom: 0 }}
              style={{ marginBottom: -4 }}
            />
          }
        >
          {loading ? (
            <div style={{ textAlign: "center", padding: 40 }}><Spin /></div>
          ) : !report ? (
            <Empty description="暂无数据" />
          ) : (
            <Table
              columns={monthlyTableData.columns}
              dataSource={monthlyTableData.dataSource}
              rowKey="_key"
              pagination={false}
              size="small"
              scroll={{ x: "max-content" }}
              bordered
              rowClassName={(row) => {
                const k = row._key as string;
                if (k === "adSpend") return "row-adspend";
                if (k === "rejected") return "row-rejected";
                if (k === "net") return "row-net";
                return "";
              }}
              summary={() => null}
            />
          )}

          {/* 成员明细折叠区 */}
          {report && activeMonth !== "annual" && (
            <div style={{ marginTop: 16 }}>
              <Text type="secondary" style={{ fontSize: 12 }}>
                * 广告费来源：Google Ads 每日同步数据；佣金来源：各联盟平台 API 实时拉取数据
              </Text>
            </div>
          )}
        </Card>

        {/* 成员分平台明细（单月视图） */}
        {report && activeMonth !== "annual" && (
          <Card title="成员明细" size="small">
            <Row gutter={[12, 12]}>
              {report.members.map((mem) => {
                const totalComm = getStat("total",    activeMonth, mem.id, null);
                const rejected  = getStat("rejected", activeMonth, mem.id, null);
                const active    = getStat("active",   activeMonth, mem.id, null);
                const spend     = getStat("adSpend",  activeMonth, mem.id, null);
                const net       = active - spend;
                return (
                  <Col key={mem.id} xs={24} sm={12} md={8} lg={6}>
                    <Card
                      size="small"
                      title={
                        <Space>
                          <Text strong>{mem.display_name}</Text>
                          <Tag color="blue" style={{ fontSize: 11 }}>{mem.username}</Tag>
                        </Space>
                      }
                      styles={{ body: { padding: "8px 12px" } }}
                    >
                      <div style={{ fontSize: 12, lineHeight: 2 }}>
                        <div><Text type="secondary">广告费：</Text><Text>${spend.toFixed(2)}</Text></div>
                        <div><Text type="secondary">总佣金：</Text><Text style={{ color: "#1677ff" }}>${totalComm.toFixed(2)}</Text></div>
                        <div><Text type="secondary">拒付：</Text><Text type="danger">${rejected.toFixed(2)}</Text></div>
                        <div><Text type="secondary">有效佣金：</Text><Text style={{ color: "#389e0d" }}>${active.toFixed(2)}</Text></div>
                        <div>
                          <Text type="secondary">净收益：</Text>
                          <Text strong style={{ color: net >= 0 ? "#fa8c16" : "#cf1322" }}>
                            {net < 0 ? "-" : ""}${Math.abs(net).toFixed(2)}
                          </Text>
                        </div>
                      </div>
                      {/* 各平台明细 */}
                      <div style={{ marginTop: 8, borderTop: "1px solid #f0f0f0", paddingTop: 6 }}>
                        {report.platforms.map((p) => {
                          const stat = report.data[activeMonth]?.[mem.id]?.[p];
                          if (!stat || stat.total === 0) return null;
                          return (
                            <div key={p} style={{ fontSize: 11, display: "flex", justifyContent: "space-between" }}>
                              <Tag style={{ fontSize: 10, margin: "1px 0" }}>{p}</Tag>
                              <Tooltip title={`拒付 $${stat.rejected.toFixed(2)}`}>
                                <Text style={{ color: "#389e0d" }}>${stat.active.toFixed(2)}</Text>
                                {stat.rejected > 0 && <Text type="danger" style={{ marginLeft: 4, fontSize: 10 }}>-${stat.rejected.toFixed(2)}</Text>}
                              </Tooltip>
                            </div>
                          );
                        })}
                      </div>
                    </Card>
                  </Col>
                );
              })}
            </Row>
          </Card>
        )}
      </Space>

      <style>{`
        .row-adspend td { background: #fafafa !important; }
        .row-rejected td { background: #fff1f0 !important; }
        .row-net td { background: #fffbe6 !important; font-weight: 600; }
      `}</style>
    </div>
  );
}
