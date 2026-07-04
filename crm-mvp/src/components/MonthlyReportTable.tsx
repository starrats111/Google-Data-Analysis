"use client";

/**
 * R-02 月度收支报表 — 类 Excel 预览组件（组员页可编辑 / 组长页只读复用）
 *
 * 布局分两块：
 *   1. 广告费区：MCC 段（原币展示，组员可覆盖）+ 合计 + 核算广告费 + 在投广告数
 *   2. 佣金区：动态账号列（账面/失效/应收/实收/收款方式）+ 合计列 + 可分配利润
 */

import React, { useState } from "react";
import { Typography, InputNumber, Tooltip, Alert, Space, Tag } from "antd";
import { EditOutlined, UndoOutlined } from "@ant-design/icons";
import type { MemberMonthlyReport, MccSection, AccountColumn } from "@/lib/monthly-report";

const { Text } = Typography;

const fmt = (n: number | null | undefined, empty = "") =>
  n == null ? empty : n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });

// ─── 单元格样式 ───
const cellBase: React.CSSProperties = {
  border: "1px solid #d9d9d9",
  padding: "4px 8px",
  fontSize: 12,
  textAlign: "right",
  whiteSpace: "nowrap",
};
const headCell: React.CSSProperties = {
  ...cellBase,
  background: "#fafafa",
  textAlign: "center",
  fontWeight: 600,
};
const labelCell: React.CSSProperties = {
  ...cellBase,
  background: "#fafafa",
  textAlign: "left",
  fontWeight: 500,
};
const totalCell: React.CSSProperties = { ...cellBase, background: "#f6ffed", fontWeight: 600 };
const accountHeadCell: React.CSSProperties = { ...headCell, background: "#fff7e6" };

/** 可编辑数值单元格（onSave 传 null = 恢复系统值） */
function EditableCell({
  value,
  overridden,
  editable,
  onSave,
  systemValue,
}: {
  value: number;
  overridden: boolean;
  editable: boolean;
  onSave: (v: number | null) => Promise<void>;
  systemValue: number;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState<number | null>(value);
  const [saving, setSaving] = useState(false);

  if (!editable) {
    return (
      <td style={{ ...cellBase, background: overridden ? "#e6f4ff" : undefined }}>
        {overridden ? (
          <Tooltip title={`手工纠正值（系统计算 ${fmt(systemValue)}）`}>
            <span style={{ color: "#1677ff" }}>{fmt(value)}</span>
          </Tooltip>
        ) : fmt(value)}
      </td>
    );
  }

  if (editing) {
    return (
      <td style={{ ...cellBase, padding: 0 }}>
        <InputNumber
          autoFocus
          size="small"
          min={0}
          value={draft}
          disabled={saving}
          style={{ width: "100%" }}
          onChange={(v) => setDraft(v)}
          onPressEnter={async () => {
            setSaving(true);
            await onSave(draft ?? 0);
            setSaving(false);
            setEditing(false);
          }}
          onBlur={async () => {
            setSaving(true);
            await onSave(draft ?? 0);
            setSaving(false);
            setEditing(false);
          }}
        />
      </td>
    );
  }

  return (
    <td
      style={{ ...cellBase, cursor: "pointer", background: overridden ? "#e6f4ff" : undefined }}
      onClick={() => { setDraft(value); setEditing(true); }}
    >
      <Space size={4}>
        {overridden ? (
          <Tooltip title={`手工纠正值（系统计算 ${fmt(systemValue)}），点击修改`}>
            <span style={{ color: "#1677ff" }}>{fmt(value)}</span>
          </Tooltip>
        ) : (
          <span>{fmt(value)}</span>
        )}
        <EditOutlined style={{ fontSize: 10, color: "#bbb" }} />
        {overridden && (
          <Tooltip title="恢复系统计算值">
            <UndoOutlined
              style={{ fontSize: 10, color: "#faad14" }}
              onClick={async (e) => {
                e.stopPropagation();
                await onSave(null);
              }}
            />
          </Tooltip>
        )}
      </Space>
    </td>
  );
}

export default function MonthlyReportTable({
  report,
  editable,
  onOverride,
}: {
  report: MemberMonthlyReport;
  editable: boolean;
  /** 保存覆盖值（value=null 恢复系统值），成功后由调用方刷新 report */
  onOverride?: (scopeKey: string, value: number | null) => Promise<void>;
}) {
  const { mccs, accounts, totals, rate } = report;

  const save = async (scopeKey: string, value: number | null) => {
    if (onOverride) await onOverride(scopeKey, value);
  };

  return (
    <div style={{ overflowX: "auto" }}>
      {/* 汇率提示条 */}
      <Alert
        type={rate.locked ? "warning" : "info"}
        showIcon
        style={{ marginBottom: 12 }}
        message={
          rate.cnyToUsd > 0
            ? `汇率：1 USD = ${rate.usdToCny.toFixed(4)} CNY（${rate.date} ${rate.locked ? "月末锁定" : "实时"}）· 报表生成时间 ${report.generatedAt}`
            : "CNY 汇率快照缺失，人民币折算列不可用"
        }
      />

      {report.warnings.length > 0 && (
        <Alert
          type="warning"
          showIcon
          style={{ marginBottom: 12 }}
          message={
            <div>
              {report.warnings.map((w, i) => (
                <div key={i} style={{ fontSize: 12 }}>{w}</div>
              ))}
            </div>
          }
        />
      )}

      {/* ── 广告费区（MCC 段） ── */}
      <table style={{ borderCollapse: "collapse", marginBottom: 16, minWidth: 720 }}>
        <thead>
          <tr>
            <th style={headCell}>MCC</th>
            <th style={headCell}>币种</th>
            <th style={headCell}>库内广告费(原币)</th>
            <th style={headCell}>
              <Tooltip title="数据中心「MCC 误差费用」，USD 口径">补差额($)</Tooltip>
            </th>
            <th style={headCell}>
              <Tooltip title="点击修改：手动覆盖后按覆盖值(原币)计算，实时对组长可见">广告费(原币，可改)</Tooltip>
            </th>
            <th style={headCell}>折美金($)</th>
          </tr>
        </thead>
        <tbody>
          {mccs.length === 0 ? (
            <tr><td colSpan={6} style={{ ...cellBase, textAlign: "center", color: "#999" }}>本月无广告消耗</td></tr>
          ) : mccs.map((m: MccSection) => (
            <tr key={m.mccDbId}>
              <td style={{ ...cellBase, textAlign: "left" }}>{m.mccName}<br /><Text type="secondary" style={{ fontSize: 11 }}>({m.mccId})</Text></td>
              <td style={{ ...cellBase, textAlign: "center" }}>
                <Tag color={m.currency === "CNY" ? "blue" : "green"} style={{ margin: 0 }}>{m.currency === "CNY" ? "人民币" : "美金"}</Tag>
              </td>
              <td style={cellBase}>{fmt(m.costOriginal)}</td>
              <td style={cellBase}>{m.adjustment > 0 ? fmt(m.adjustment) : "—"}</td>
              <EditableCell
                value={m.effectiveOriginal}
                overridden={m.override != null}
                editable={editable}
                systemValue={m.costOriginal}
                onSave={(v) => save(`mcc:${m.mccDbId}`, v)}
              />
              <td style={cellBase}>{fmt(m.effectiveUsd)}</td>
            </tr>
          ))}
          <tr>
            <td style={totalCell} colSpan={2}>广告费合计</td>
            <td style={totalCell} colSpan={2}>
              $ {fmt(report.adCostTotalUsd)}{report.adCostTotalCny > 0 && <> ｜ ¥ {fmt(report.adCostTotalCny)}</>}
            </td>
            <td style={totalCell}>
              <Tooltip title="用于核算利润的广告费：人民币按报表汇率折美金 + 美金累计">核算广告费 $ {fmt(report.profitAdCostUsd)}</Tooltip>
            </td>
            <td style={totalCell}>在投广告数 {report.enabledCampaigns}</td>
          </tr>
        </tbody>
      </table>

      {/* ── 佣金区（动态账号列，每账号占 2 列；实收区拆 USD/CNY 双列） ── */}
      <table style={{ borderCollapse: "collapse", minWidth: 720 }}>
        <thead>
          <tr>
            <th style={headCell} colSpan={2}>项目</th>
            {accounts.map((a: AccountColumn) => (
              <th key={`${a.platform}-${a.accountName}`} style={accountHeadCell} colSpan={2}>{a.label}</th>
            ))}
            <th style={headCell}>佣金合计</th>
          </tr>
          <tr>
            <th style={headCell} colSpan={2}>账号名称</th>
            {accounts.map((a) => (
              <th key={`${a.platform}-${a.accountName}`} style={{ ...accountHeadCell, fontWeight: 400 }} colSpan={2}>{a.accountName || "—"}</th>
            ))}
            <th style={headCell}></th>
          </tr>
        </thead>
        <tbody>
          <tr>
            <td style={labelCell} colSpan={2}>账面佣金（美金）</td>
            {accounts.map((a) => <td key={a.label} style={cellBase} colSpan={2}>{fmt(a.book)}</td>)}
            <td style={totalCell}>{fmt(totals.book)}</td>
          </tr>
          <tr>
            <td style={labelCell} colSpan={2}>失效佣金（美金）</td>
            {accounts.map((a) => <td key={a.label} style={cellBase} colSpan={2}>{fmt(a.rejected)}</td>)}
            <td style={totalCell}>{fmt(totals.rejected)}</td>
          </tr>
          {/* 应收 */}
          <tr>
            <td style={{ ...labelCell }} rowSpan={3}>应收佣金（美金）</td>
            <td style={labelCell}>5号（上半月）</td>
            {accounts.map((a) => <td key={a.label} style={cellBase} colSpan={2}>{a.hasPayments ? fmt(a.recvH1) : ""}</td>)}
            <td style={totalCell}>{fmt(totals.recvH1)}</td>
          </tr>
          <tr>
            <td style={labelCell}>15号（下半月）</td>
            {accounts.map((a) => <td key={a.label} style={cellBase} colSpan={2}>{a.hasPayments ? fmt(a.recvH2) : ""}</td>)}
            <td style={totalCell}>{fmt(totals.recvH2)}</td>
          </tr>
          <tr>
            <td style={labelCell}>合计</td>
            {accounts.map((a) => <td key={a.label} style={{ ...cellBase, fontWeight: 600 }} colSpan={2}>{a.hasPayments ? fmt(a.recvH1 + a.recvH2) : ""}</td>)}
            <td style={totalCell}>{fmt(totals.recvTotal)}</td>
          </tr>
          {/* 实收（USD/CNY 双列，可编辑） */}
          <tr>
            <td style={labelCell} rowSpan={4}>
              实收佣金
              {editable && <div><Text type="secondary" style={{ fontSize: 10 }}>点击单元格可手工纠正</Text></div>}
            </td>
            <td style={labelCell}></td>
            {accounts.map((a) => (
              <React.Fragment key={a.label}>
                <td style={{ ...headCell, fontSize: 11 }}>USD</td>
                <td style={{ ...headCell, fontSize: 11 }}>
                  <Tooltip title="默认 = 打款日汇率 × 实收(USD)，逐笔折算；点击可手填实际到账人民币">CNY</Tooltip>
                </td>
              </React.Fragment>
            ))}
            <td style={{ ...headCell, fontSize: 11 }}>$ / ¥</td>
          </tr>
          <tr>
            <td style={labelCell}>10号（上半月）</td>
            {accounts.map((a) => (
              <React.Fragment key={a.label}>
                <EditableCell
                  value={a.paidH1Effective}
                  overridden={a.paidH1Override != null}
                  editable={editable && a.accountName !== "(历史账号)"}
                  systemValue={a.paidH1}
                  onSave={(v) => save(`recv:${a.platform}:${a.accountName}:H1`, v)}
                />
                <EditableCell
                  value={a.paidCnyH1Effective}
                  overridden={a.paidCnyH1Override != null}
                  editable={editable && a.accountName !== "(历史账号)"}
                  systemValue={a.paidCnyH1}
                  onSave={(v) => save(`recvcny:${a.platform}:${a.accountName}:H1`, v)}
                />
              </React.Fragment>
            ))}
            <td style={totalCell}>{fmt(totals.paidH1)}<br />¥{fmt(totals.paidCnyH1)}</td>
          </tr>
          <tr>
            <td style={labelCell}>20号（下半月）</td>
            {accounts.map((a) => (
              <React.Fragment key={a.label}>
                <EditableCell
                  value={a.paidH2Effective}
                  overridden={a.paidH2Override != null}
                  editable={editable && a.accountName !== "(历史账号)"}
                  systemValue={a.paidH2}
                  onSave={(v) => save(`recv:${a.platform}:${a.accountName}:H2`, v)}
                />
                <EditableCell
                  value={a.paidCnyH2Effective}
                  overridden={a.paidCnyH2Override != null}
                  editable={editable && a.accountName !== "(历史账号)"}
                  systemValue={a.paidCnyH2}
                  onSave={(v) => save(`recvcny:${a.platform}:${a.accountName}:H2`, v)}
                />
              </React.Fragment>
            ))}
            <td style={totalCell}>{fmt(totals.paidH2)}<br />¥{fmt(totals.paidCnyH2)}</td>
          </tr>
          <tr>
            <td style={labelCell}>合计</td>
            {accounts.map((a) => (
              <React.Fragment key={a.label}>
                <td style={{ ...cellBase, fontWeight: 600 }}>{fmt(a.paidH1Effective + a.paidH2Effective)}</td>
                <td style={{ ...cellBase, fontWeight: 600 }}>{fmt(a.paidCnyH1Effective + a.paidCnyH2Effective)}</td>
              </React.Fragment>
            ))}
            <td style={totalCell}>{fmt(totals.paidTotal)}<br />¥{fmt(totals.paidCnyTotal)}</td>
          </tr>
          {/* 收款方式 */}
          <tr>
            <td style={labelCell} colSpan={2}>收款人</td>
            {accounts.map((a) => <td key={a.label} style={{ ...cellBase, textAlign: "center" }} colSpan={2}>{a.payeeName}</td>)}
            <td style={cellBase}></td>
          </tr>
          <tr>
            <td style={labelCell} colSpan={2}>收款卡号</td>
            {accounts.map((a) => <td key={a.label} style={{ ...cellBase, textAlign: "center", fontSize: 11 }} colSpan={2}>{a.cardNo}</td>)}
            <td style={cellBase}></td>
          </tr>
          {/* 可分配利润 */}
          <tr>
            <td style={{ ...totalCell, textAlign: "left" }} colSpan={2}>可分配利润（实收佣金 − 核算广告费）</td>
            <td style={totalCell} colSpan={Math.max(accounts.length * 2, 1)}>
              $ {fmt(report.profit.usd)}{rate.cnyToUsd > 0 && <> ｜ ¥ {fmt(report.profit.cny)}</>}
            </td>
            <td style={totalCell}></td>
          </tr>
        </tbody>
      </table>
    </div>
  );
}
