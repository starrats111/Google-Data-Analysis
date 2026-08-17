"use client";

/**
 * D-239 表格自定义列展示
 *
 * 本模块是数据中心主表与组长「组员数据」弹窗共用的列注册层，包含：
 * 1. 指标计算函数（净利润 / EPC / AOV / 每百次点击费用 / CVR / CPA / 利润率）
 * 2. 共享指标列定义 buildMetricColumns —— 两处表格同一份，防止列定义漂移
 * 3. useTableColumnPrefs —— 列偏好读写（存 user_table_preferences，跟随账号）
 * 4. ColumnSettingsButton —— 列设置面板（显隐 + 拖拽排序 + 恢复默认）
 * 5. renderColumnSummary —— 汇总行按列 key 渲染，列怎么排合计就怎么对齐
 */

import { useCallback, useEffect, useRef, useState } from "react";
import type { ReactNode } from "react";
import { App, Button, Checkbox, Divider, Popover, Space, Tag, Tooltip, Typography } from "antd";
import { HolderOutlined, SettingOutlined } from "@ant-design/icons";
import type { ColumnType } from "antd/es/table";

const { Text } = Typography;

// ============================================================
// 指标计算
// ============================================================

export function formatInt(value: number | null | undefined): string {
  return (value ?? 0).toLocaleString("en-US");
}

export function calcNetProfit(commission: number, rejectedCommission: number, cost: number): number {
  return (commission || 0) - (rejectedCommission || 0) - (cost || 0);
}

/** EPC = 佣金 / 点击，与「平均CPC」同量纲，可直接比较。无点击时返回 null（不是 0） */
export function calcEpc(commission: number | null | undefined, clicks: number | null | undefined): number | null {
  if (!clicks) return null;
  return (commission || 0) / clicks;
}

/** AOV = 佣金 / 订单数（07 口径：我们的收入就是佣金）。无订单返回 null */
export function calcAov(commission: number | null | undefined, orders: number | null | undefined): number | null {
  if (!orders) return null;
  return (commission || 0) / orders;
}

/** 每百次点击费用 = 平均CPC × 100。无点击返回 null */
export function calcCostPer100Clicks(cpc: number | null | undefined, clicks: number | null | undefined): number | null {
  if (!clicks) return null;
  return (cpc || 0) * 100;
}

/** 转化率 CVR = 订单数 / 点击数（0-1 分数）。无点击返回 null */
export function calcCvr(orders: number | null | undefined, clicks: number | null | undefined): number | null {
  if (!clicks) return null;
  return (orders || 0) / clicks;
}

/** 单单成本 CPA = 花费 / 订单数。无订单返回 null */
export function calcCpa(cost: number | null | undefined, orders: number | null | undefined): number | null {
  if (!orders) return null;
  return (cost || 0) / orders;
}

/** 利润率 = 净利润 / 花费（0-1 分数，可为负）。无花费返回 null */
export function calcProfitRate(
  commission: number | null | undefined,
  rejectedCommission: number | null | undefined,
  cost: number | null | undefined,
): number | null {
  if (!cost) return null;
  return calcNetProfit(commission || 0, rejectedCommission || 0, cost) / cost;
}

// ============================================================
// 共享指标列定义
// ============================================================

/** 共享指标列需要的行字段（数据中心行与组员弹窗行都满足） */
export interface MetricRow {
  cost: number;
  clicks: number;
  impressions: number;
  cpc: number;
  commission: number;
  rejected_commission: number;
  orders: number;
  roi: number;
  mcc_currency?: string;
}

export type MetricColumnKey =
  | "impressions" | "clicks" | "orders" | "cpc" | "epc" | "cost_per_100_clicks"
  | "cost" | "cpa" | "commission" | "aov" | "rejected_commission"
  | "net_profit" | "profit_rate" | "roi" | "cvr";

/** 列设置面板里展示的名称（表头可能是缩写，这里写全称便于员工理解） */
export const METRIC_COLUMN_LABELS: Record<MetricColumnKey, string> = {
  impressions: "展示",
  clicks: "点击",
  orders: "订单",
  cpc: "平均CPC",
  epc: "EPC（单击佣金）",
  cost_per_100_clicks: "每百次点击费用",
  cost: "花费",
  cpa: "CPA（单单成本）",
  commission: "佣金",
  aov: "AOV（单单佣金）",
  rejected_commission: "拒付佣金",
  net_profit: "净利润",
  profit_rate: "利润率",
  roi: "ROI",
  cvr: "转化率 CVR",
};

const dash = <Text type="secondary" style={{ fontSize: 12 }}>—</Text>;

/** 生成两处表格共用的指标列（同一份定义，改这里两边同时生效） */
export function buildMetricColumns<T extends MetricRow>(): Record<MetricColumnKey, ColumnType<T>> {
  return {
    impressions: {
      key: "impressions",
      title: <Tooltip title="来自 Google Ads 的展示次数"><span>展示</span></Tooltip>,
      dataIndex: "impressions", width: 85, align: "right",
      sorter: (a, b) => (a.impressions ?? 0) - (b.impressions ?? 0),
      render: (v: number | null | undefined) => <Text style={{ fontSize: 12 }}>{formatInt(v)}</Text>,
    },
    clicks: {
      key: "clicks",
      title: <Tooltip title="来自 Google Ads，与「花费」同源"><span>点击</span></Tooltip>,
      dataIndex: "clicks", width: 85, align: "right",
      sorter: (a, b) => (a.clicks ?? 0) - (b.clicks ?? 0),
      render: (v: number | null | undefined) => <Text style={{ fontSize: 12 }}>{formatInt(v)}</Text>,
    },
    orders: {
      key: "orders",
      title: <Tooltip title="来自联盟平台交易，与「佣金」同源，按商家归到代表行"><span>订单</span></Tooltip>,
      dataIndex: "orders", width: 75, align: "right",
      sorter: (a, b) => (a.orders ?? 0) - (b.orders ?? 0),
      render: (v: number | null | undefined) => <Text style={{ fontSize: 12 }}>{formatInt(v)}</Text>,
    },
    cpc: {
      key: "cpc",
      title: <Tooltip title="平均CPC = 花费 / 点击，即每个点击花了多少"><span>平均CPC</span></Tooltip>,
      dataIndex: "cpc", width: 80, align: "right",
      sorter: (a, b) => (a.cpc ?? 0) - (b.cpc ?? 0),
      render: (v: number) => <Text style={{ fontSize: 12 }}>${(v ?? 0).toFixed(4)}</Text>,
    },
    epc: {
      key: "epc",
      title: <Tooltip title="EPC = 佣金 / 点击，即每个点击赚回多少。与「平均CPC」同量纲，EPC > 平均CPC 即为赚。无点击显示「—」"><span>EPC</span></Tooltip>,
      width: 80, align: "right",
      sorter: (a, b) => (calcEpc(a.commission, a.clicks) ?? -1) - (calcEpc(b.commission, b.clicks) ?? -1),
      render: (_: unknown, r: T) => {
        const value = calcEpc(r.commission, r.clicks);
        if (value === null) return dash;
        return <Text style={{ fontSize: 12, color: value > 0 ? "#389e0d" : undefined }}>${value.toFixed(4)}</Text>;
      },
    },
    cost_per_100_clicks: {
      key: "cost_per_100_clicks",
      title: <Tooltip title="每百次点击费用 = 平均CPC × 100，即每 100 个点击花多少。无点击显示「—」"><span>每百次点击费用</span></Tooltip>,
      width: 110, align: "right",
      sorter: (a, b) => (calcCostPer100Clicks(a.cpc, a.clicks) ?? -1) - (calcCostPer100Clicks(b.cpc, b.clicks) ?? -1),
      render: (_: unknown, r: T) => {
        const value = calcCostPer100Clicks(r.cpc, r.clicks);
        if (value === null) return dash;
        return <Text style={{ fontSize: 12 }}>${value.toFixed(2)}</Text>;
      },
    },
    cost: {
      key: "cost",
      title: "花费", dataIndex: "cost", width: 85, align: "right",
      sorter: (a, b) => (a.cost ?? 0) - (b.cost ?? 0),
      render: (v: number, r: T) => (
        <span>
          <Text style={{ fontSize: 12, color: v > 0 ? "#cf1322" : undefined }}>${(v ?? 0).toFixed(2)}</Text>
          {r.mcc_currency === "CNY" && <Tag color="orange" style={{ fontSize: 9, marginLeft: 2, padding: "0 3px", lineHeight: "14px" }}>CNY</Tag>}
        </span>
      ),
    },
    cpa: {
      key: "cpa",
      title: <Tooltip title="CPA（单单成本）= 花费 / 订单数，平均每个订单花了多少广告费。无订单显示「—」"><span>CPA</span></Tooltip>,
      width: 80, align: "right",
      sorter: (a, b) => (calcCpa(a.cost, a.orders) ?? -1) - (calcCpa(b.cost, b.orders) ?? -1),
      render: (_: unknown, r: T) => {
        const value = calcCpa(r.cost, r.orders);
        if (value === null) return dash;
        return <Text style={{ fontSize: 12 }}>${value.toFixed(2)}</Text>;
      },
    },
    commission: {
      key: "commission",
      title: "佣金", dataIndex: "commission", width: 70, align: "right",
      sorter: (a, b) => (a.commission ?? 0) - (b.commission ?? 0),
      render: (v: number) => (
        <Text style={{ fontSize: 12, color: v > 0 ? "#389e0d" : undefined }}>${(v ?? 0).toFixed(2)}</Text>
      ),
    },
    aov: {
      key: "aov",
      title: <Tooltip title="AOV（单单佣金）= 佣金 / 订单数，平均每单赚多少佣金。无订单显示「—」"><span>AOV</span></Tooltip>,
      width: 80, align: "right",
      sorter: (a, b) => (calcAov(a.commission, a.orders) ?? -1) - (calcAov(b.commission, b.orders) ?? -1),
      render: (_: unknown, r: T) => {
        const value = calcAov(r.commission, r.orders);
        if (value === null) return dash;
        return <Text style={{ fontSize: 12, color: value > 0 ? "#389e0d" : undefined }}>${value.toFixed(2)}</Text>;
      },
    },
    rejected_commission: {
      key: "rejected_commission",
      title: "拒付佣金", dataIndex: "rejected_commission", width: 95, align: "right",
      sorter: (a, b) => (a.rejected_commission || 0) - (b.rejected_commission || 0),
      render: (v: number) => <Text type={v > 0 ? "danger" : "secondary"} style={{ fontSize: 12 }}>${(v || 0).toFixed(2)}</Text>,
    },
    net_profit: {
      key: "net_profit",
      title: <Tooltip title="净利润 = 佣金 - 拒付佣金 - 花费"><span>净利润</span></Tooltip>,
      width: 85, align: "right",
      sorter: (a, b) =>
        calcNetProfit(a.commission, a.rejected_commission, a.cost) - calcNetProfit(b.commission, b.rejected_commission, b.cost),
      render: (_: unknown, r: T) => {
        const value = calcNetProfit(r.commission, r.rejected_commission, r.cost);
        return <Text style={{ fontSize: 12, color: value >= 0 ? "#389e0d" : "#cf1322" }}>${value.toFixed(2)}</Text>;
      },
    },
    profit_rate: {
      key: "profit_rate",
      title: <Tooltip title="利润率 = 净利润 / 花费（净利润 = 佣金 - 拒付佣金 - 花费）。无花费显示「—」"><span>利润率</span></Tooltip>,
      width: 80, align: "right",
      sorter: (a, b) =>
        (calcProfitRate(a.commission, a.rejected_commission, a.cost) ?? -Infinity) -
        (calcProfitRate(b.commission, b.rejected_commission, b.cost) ?? -Infinity),
      render: (_: unknown, r: T) => {
        const value = calcProfitRate(r.commission, r.rejected_commission, r.cost);
        if (value === null) return dash;
        return <Text style={{ fontSize: 12, color: value >= 0 ? "#389e0d" : "#cf1322" }}>{(value * 100).toFixed(1)}%</Text>;
      },
    },
    roi: {
      key: "roi",
      title: <Tooltip title="（佣金 - 花费）/ 花费，倍数口径，不扣拒付佣金。无花费显示「—」"><span>ROI</span></Tooltip>,
      dataIndex: "roi", width: 75, align: "right",
      sorter: (a, b) => (a.roi ?? 0) - (b.roi ?? 0),
      render: (v: number | null | undefined, r: T) => {
        if (!r.cost) return dash;
        const value = v ?? 0;
        return <Text style={{ fontSize: 12, color: value >= 0 ? "#389e0d" : "#cf1322" }}>{value.toFixed(2)}</Text>;
      },
    },
    cvr: {
      key: "cvr",
      title: <Tooltip title="转化率 CVR = 订单数 / 点击数。无点击显示「—」"><span>CVR</span></Tooltip>,
      width: 80, align: "right",
      sorter: (a, b) => (calcCvr(a.orders, a.clicks) ?? -1) - (calcCvr(b.orders, b.clicks) ?? -1),
      render: (_: unknown, r: T) => {
        const value = calcCvr(r.orders, r.clicks);
        if (value === null) return dash;
        return <Text style={{ fontSize: 12 }}>{(value * 100).toFixed(2)}%</Text>;
      },
    },
  };
}

// ============================================================
// 汇总行：按列 key 渲染合计内容
// ============================================================

export interface TableSummaryTotals {
  totalImpressions: number;
  totalClicks: number;
  totalOrders: number;
  avgCpc: number;
  totalCost: number;
  totalCommission: number;
  totalRejectedCommission: number;
  roi: number;
}

const strongDash = <Text strong type="secondary">—</Text>;

/** 汇总行内容按列 key 取值；无合计意义的列（预算/出价/操作列等）返回 null 显示空单元格 */
export function renderColumnSummary(key: string, t: TableSummaryTotals): ReactNode {
  switch (key) {
    case "impressions": return <Text strong>{formatInt(t.totalImpressions)}</Text>;
    case "clicks": return <Text strong>{formatInt(t.totalClicks)}</Text>;
    case "orders": return <Text strong>{formatInt(t.totalOrders)}</Text>;
    case "cpc": return <Text strong>${t.avgCpc.toFixed(4)}</Text>;
    case "epc": {
      const v = calcEpc(t.totalCommission, t.totalClicks);
      return v === null ? strongDash : <Text strong style={{ color: "#389e0d" }}>${v.toFixed(4)}</Text>;
    }
    case "cost_per_100_clicks": {
      const v = calcCostPer100Clicks(t.avgCpc, t.totalClicks);
      return v === null ? strongDash : <Text strong>${v.toFixed(2)}</Text>;
    }
    case "cost": return <Text strong style={{ color: "#cf1322" }}>${t.totalCost.toFixed(2)}</Text>;
    case "cpa": {
      const v = calcCpa(t.totalCost, t.totalOrders);
      return v === null ? strongDash : <Text strong>${v.toFixed(2)}</Text>;
    }
    case "commission": return <Text strong style={{ color: "#389e0d" }}>${t.totalCommission.toFixed(2)}</Text>;
    case "aov": {
      const v = calcAov(t.totalCommission, t.totalOrders);
      return v === null ? strongDash : <Text strong style={{ color: "#389e0d" }}>${v.toFixed(2)}</Text>;
    }
    case "rejected_commission": return <Text strong type="danger">${t.totalRejectedCommission.toFixed(2)}</Text>;
    case "net_profit": {
      const v = calcNetProfit(t.totalCommission, t.totalRejectedCommission, t.totalCost);
      return <Text strong style={{ color: v >= 0 ? "#389e0d" : "#cf1322" }}>${v.toFixed(2)}</Text>;
    }
    case "profit_rate": {
      const v = calcProfitRate(t.totalCommission, t.totalRejectedCommission, t.totalCost);
      return v === null ? strongDash : <Text strong style={{ color: v >= 0 ? "#389e0d" : "#cf1322" }}>{(v * 100).toFixed(1)}%</Text>;
    }
    case "roi": return <Text strong style={{ color: t.roi >= 0 ? "#389e0d" : "#cf1322" }}>{t.roi.toFixed(2)}</Text>;
    case "cvr": {
      const v = calcCvr(t.totalOrders, t.totalClicks);
      return v === null ? strongDash : <Text strong>{(v * 100).toFixed(2)}%</Text>;
    }
    default: return null;
  }
}

// ============================================================
// 列偏好 Hook
// ============================================================

export interface TableColumnPrefsOptions {
  /** 后端 table_key，如 data-center-campaigns / team-member-modal */
  tableKey: string;
  /** 该表格全部可用列 key（注册表顺序） */
  allKeys: string[];
  /** 固定列（不可隐藏，始终排最前） */
  lockedKeys: string[];
  /** 员工未配置时的默认可见列 */
  defaultKeys: string[];
}

export function useTableColumnPrefs(opts: TableColumnPrefsOptions) {
  const { tableKey } = opts;
  // 用 join 后的字符串做依赖，调用方直接传字面量数组也不会引起 effect 反复触发
  const allKeysStr = opts.allKeys.join(",");
  const lockedStr = opts.lockedKeys.join(",");
  const defaultStr = opts.defaultKeys.join(",");

  /** 清洗：去掉未知列、去重，固定列强制放最前 */
  const sanitize = useCallback((keys: string[]): string[] => {
    const all = new Set(allKeysStr.split(","));
    const locked = lockedStr.split(",");
    const lockedSet = new Set(locked);
    const rest: string[] = [];
    for (const k of keys) {
      if (all.has(k) && !lockedSet.has(k) && !rest.includes(k)) rest.push(k);
    }
    return [...locked, ...rest];
  }, [allKeysStr, lockedStr]);

  const [visibleKeys, setVisibleKeys] = useState<string[]>(() => sanitize(defaultStr.split(",")));

  useEffect(() => {
    let cancelled = false;
    fetch(`/api/user/table-preferences?table=${encodeURIComponent(tableKey)}`)
      .then((r) => r.json())
      .then((res) => {
        if (cancelled || res?.code !== 0) return;
        const cols: unknown = res?.data?.config?.columns;
        if (Array.isArray(cols) && cols.length > 0) {
          setVisibleKeys(sanitize(cols.filter((c): c is string => typeof c === "string")));
        }
      })
      .catch(() => { /* 读失败时静默用默认列，不阻塞页面 */ });
    return () => { cancelled = true; };
  }, [tableKey, sanitize]);

  const save = useCallback(async (keys: string[]): Promise<boolean> => {
    const next = sanitize(keys);
    setVisibleKeys(next); // 乐观更新，表格立即变
    try {
      const res = await fetch("/api/user/table-preferences", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ table: tableKey, columns: next }),
      }).then((r) => r.json());
      return res?.code === 0;
    } catch {
      return false;
    }
  }, [tableKey, sanitize]);

  const reset = useCallback(() => save(defaultStr.split(",")), [save, defaultStr]);

  return { visibleKeys, save, reset };
}

// ============================================================
// 列设置按钮 + 面板
// ============================================================

export interface ColumnMetaItem {
  key: string;
  label: string;
}

interface ColumnSettingsButtonProps {
  /** 全部列（注册表顺序），面板里未勾选的列按此顺序排在后面 */
  columnsMeta: ColumnMetaItem[];
  lockedKeys: string[];
  visibleKeys: string[];
  onSave: (keys: string[]) => Promise<boolean>;
  onReset: () => Promise<boolean>;
}

interface DraftItem {
  key: string;
  label: string;
  checked: boolean;
  locked: boolean;
}

export function ColumnSettingsButton({ columnsMeta, lockedKeys, visibleKeys, onSave, onReset }: ColumnSettingsButtonProps) {
  const { message } = App.useApp();
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState<DraftItem[]>([]);
  const [saving, setSaving] = useState(false);
  const dragIndexRef = useRef<number | null>(null);
  const lockedCount = lockedKeys.length;

  const buildDraft = useCallback((): DraftItem[] => {
    const metaMap = new Map(columnsMeta.map((m) => [m.key, m]));
    const visible = visibleKeys.filter((k) => metaMap.has(k));
    const hidden = columnsMeta.map((m) => m.key).filter((k) => !visible.includes(k));
    return [...visible, ...hidden].map((k) => ({
      key: k,
      label: metaMap.get(k)!.label,
      checked: visible.includes(k),
      locked: lockedKeys.includes(k),
    }));
  }, [columnsMeta, visibleKeys, lockedKeys]);

  const handleOpenChange = (next: boolean) => {
    if (next) setDraft(buildDraft());
    setOpen(next);
  };

  const toggleChecked = (key: string) => {
    setDraft((prev) => prev.map((it) => (it.key === key && !it.locked ? { ...it, checked: !it.checked } : it)));
  };

  const handleDragOver = (targetIndex: number) => {
    const from = dragIndexRef.current;
    if (from === null || from === targetIndex || targetIndex < lockedCount) return;
    setDraft((prev) => {
      const next = [...prev];
      const [moved] = next.splice(from, 1);
      next.splice(targetIndex, 0, moved);
      return next;
    });
    dragIndexRef.current = targetIndex;
  };

  const handleSave = async () => {
    setSaving(true);
    try {
      const ok = await onSave(draft.filter((it) => it.checked).map((it) => it.key));
      if (ok) {
        message.success("列设置已保存");
        setOpen(false);
      } else {
        message.warning("列设置已应用，但保存到账号失败，刷新后可能还原");
        setOpen(false);
      }
    } finally {
      setSaving(false);
    }
  };

  const handleReset = async () => {
    setSaving(true);
    try {
      await onReset();
      message.success("已恢复默认列");
      setOpen(false);
    } finally {
      setSaving(false);
    }
  };

  const content = (
    <div style={{ width: 230 }}>
      <div style={{ maxHeight: 340, overflowY: "auto", paddingRight: 2 }}>
        {draft.map((it, idx) => (
          <div
            key={it.key}
            draggable={!it.locked}
            onDragStart={() => { dragIndexRef.current = idx; }}
            onDragOver={(e) => { e.preventDefault(); handleDragOver(idx); }}
            onDrop={(e) => e.preventDefault()}
            onDragEnd={() => { dragIndexRef.current = null; }}
            style={{
              display: "flex", alignItems: "center", gap: 6,
              padding: "3px 4px", borderRadius: 4,
              cursor: it.locked ? "default" : "move",
            }}
          >
            {it.locked
              ? <span style={{ width: 14, display: "inline-block" }} />
              : <HolderOutlined style={{ color: "#bbb", fontSize: 12 }} />}
            <Checkbox checked={it.checked} disabled={it.locked} onChange={() => toggleChecked(it.key)} />
            <span style={{ fontSize: 12, flex: 1, userSelect: "none" }}>{it.label}</span>
            {it.locked && <Tag style={{ fontSize: 10, margin: 0, lineHeight: "16px" }}>固定</Tag>}
          </div>
        ))}
      </div>
      <Divider style={{ margin: "8px 0" }} />
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
        <Button type="link" size="small" style={{ padding: 0, fontSize: 12 }} disabled={saving} onClick={handleReset}>
          恢复默认
        </Button>
        <Space size={6}>
          <Button size="small" onClick={() => setOpen(false)}>取消</Button>
          <Button size="small" type="primary" loading={saving} onClick={handleSave}>保存</Button>
        </Space>
      </div>
    </div>
  );

  return (
    <Popover
      open={open}
      onOpenChange={handleOpenChange}
      content={content}
      trigger="click"
      placement="bottomRight"
      title={<span style={{ fontSize: 13 }}>列设置（勾选显示，拖动排序）</span>}
    >
      <Button size="small" icon={<SettingOutlined />}>列设置</Button>
    </Popover>
  );
}
