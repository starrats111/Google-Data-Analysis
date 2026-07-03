"use client";

/**
 * R-02 组员端 — 结算月报（单月收支统计表）
 * 月份选择 + 类 Excel 预览 + 广告费/实收内联编辑 + xlsx 导出
 */

import { useState, useEffect, useCallback } from "react";
import { Card, DatePicker, Button, Space, Spin, Empty, App } from "antd";
import { AccountBookOutlined, DownloadOutlined, ReloadOutlined } from "@ant-design/icons";
import dayjs, { type Dayjs } from "dayjs";
import AppPageHeader from "@/components/AppPageHeader";
import MonthlyReportTable from "@/components/MonthlyReportTable";
import type { MemberMonthlyReport } from "@/lib/monthly-report";

export default function SettlementReportPage() {
  const { message } = App.useApp();
  const [month, setMonth] = useState<Dayjs>(dayjs());
  const [report, setReport] = useState<MemberMonthlyReport | null>(null);
  const [loading, setLoading] = useState(false);
  const [exporting, setExporting] = useState(false);

  const monthStr = month.format("YYYY-MM");

  const fetchReport = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch(`/api/user/report/monthly?month=${monthStr}`).then((r) => r.json());
      if (res.code === 0) setReport(res.data);
      else message.error(res.message || "加载失败");
    } catch {
      message.error("加载失败");
    } finally {
      setLoading(false);
    }
  }, [monthStr, message]);

  useEffect(() => { fetchReport(); }, [fetchReport]);

  const handleOverride = async (scopeKey: string, value: number | null) => {
    const res = await fetch("/api/user/report/override", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ month: monthStr, scope_key: scopeKey, value }),
    }).then((r) => r.json()).catch(() => null);
    if (res?.code === 0) {
      message.success(res.message || "已保存");
      fetchReport();
    } else {
      message.error(res?.message || "保存失败");
    }
  };

  const handleExport = async () => {
    setExporting(true);
    try {
      const resp = await fetch(`/api/user/report/monthly/export?month=${monthStr}`);
      if (!resp.ok) {
        const err = await resp.json().catch(() => null);
        message.error(err?.message || "导出失败");
        return;
      }
      const blob = await resp.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `收支统计-${monthStr}.xlsx`;
      a.click();
      URL.revokeObjectURL(url);
    } finally {
      setExporting(false);
    }
  };

  return (
    <div>
      <AppPageHeader
        icon={<AccountBookOutlined />}
        title="结算月报"
        subtitle="单月收支统计表 — 广告费与实收佣金可手工纠正，改动实时对组长可见"
      />
      <Card size="small">
        <Space style={{ marginBottom: 16 }} wrap>
          <DatePicker
            picker="month"
            value={month}
            allowClear={false}
            onChange={(v) => v && setMonth(v)}
            disabledDate={(d) => d.isAfter(dayjs(), "month")}
          />
          <Button icon={<ReloadOutlined />} onClick={fetchReport} loading={loading}>刷新</Button>
          <Button type="primary" icon={<DownloadOutlined />} onClick={handleExport} loading={exporting}>
            导出 Excel
          </Button>
        </Space>
        <Spin spinning={loading}>
          {report ? (
            <MonthlyReportTable report={report} editable onOverride={handleOverride} />
          ) : (
            !loading && <Empty description="暂无数据" />
          )}
        </Spin>
      </Card>
    </div>
  );
}
