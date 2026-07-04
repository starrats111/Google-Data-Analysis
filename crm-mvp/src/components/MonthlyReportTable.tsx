"use client";

/**
 * R-02 月度收支报表 — 类 Excel 预览组件（组员页可编辑 / 组长页只读复用）
 *
 * 布局分两块：
 *   1. 广告费区：MCC 段（原币展示，组员可覆盖）+ 合计 + 核算广告费 + 在投广告数
 *   2. 佣金区：动态账号列（账面/失效/应收/实收USD+CNY/收款方式）+ 合计列 + 可分配利润
 */

import React, { useState } from "react";
import { Typography, InputNumber, Tooltip, Alert, Tag } from "antd";
import { EditOutlined, UndoOutlined } from "@ant-design/icons";
import type { MemberMonthlyReport, MccSection, AccountColumn } from "@/lib/monthly-report";

const { Text } = Typography;

const fmt = (n: number | null | undefined, empty = "") =>
  n == null ? empty : n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });

// ─── 调色板 ───
const C = {
  border: "#e5eaf0",
  labelBg: "#f7f9fc",
  labelText: "#3d4a5c",
  headBg: "#f0f4f9",
  platBg: "#e9f4ea",
  platText: "#2f6b33",
  acctBg: "#fbfcfd",
  totalBg: "#f4fbee",
  totalBorder: "#b7d9a0",
  recvBg: "#fffdf5",
  paidBg: "#f8fbff",
  subHeadBg: "#eef5ff",
  overrideBg: "#e6f4ff",
  profitBg: "#f0f9e8",
  zebra: "#fafbfd",
};

// ─── 单元格样式 ───
const cellBase: React.CSSProperties = {
  border: `1px solid ${C.border}`,
  padding: "6px 10px",
  fontSize: 12.5,
  textAlign: "right",
  whiteSpace: "nowrap",
  fontVariantNumeric: "tabular-nums",
  color: "#1f2937",
};
const headCell: React.CSSProperties = {
  ...cellBase,
  background: C.headBg,
  textAlign: "center",
  fontWeight: 600,
  color: C.labelText,
};
const labelCell: React.CSSProperties = {
  ...cellBase,
  background: C.labelBg,
  textAlign: "left",
  fontWeight: 600,
  color: C.labelText,
};
const subLabelCell: React.CSSProperties = { ...labelCell, fontWeight: 400, paddingLeft: 16 };
const totalCell: React.CSSProperties = {
  ...cellBase,
  background: C.totalBg,
  fontWeight: 600,
  borderLeft: `2px solid ${C.totalBorder}`,
};
const platHeadCell: React.CSSProperties = {
  ...cellBase,
  background: C.platBg,
  textAlign: "center",
  fontWeight: 700,
  color: C.platText,
  fontSize: 13,
};
const acctNameCell: React.CSSProperties = {
  ...cellBase,
  background: C.acctBg,
  textAlign: "center",
  fontWeight: 400,
  color: "#8a94a3",
  fontSize: 11.5,
};

/** 表格外壳：圆角 + 细边框 + 横向滚动 */
function TableShell({ title, hint, children }: { title: string; hint?: string; children: React.ReactNode }) {
  return (
    <div style={{ marginBottom: 20 }}>
      <div style={{ display: "flex", alignItems: "baseline", gap: 8, marginBottom: 8 }}>
        <span style={{ width: 4, height: 14, background: "#1677ff", borderRadius: 2, alignSelf: "center" }} />
        <Text strong style={{ fontSize: 13.5 }}>{title}</Text>
        {hint && <Text type="secondary" style={{ fontSize: 11.5 }}>{hint}</Text>}
      </div>
      <div style={{ overflowX: "auto", border: `1px solid ${C.border}`, borderRadius: 8 }}>
        {children}
      </div>
    </div>
  );
}

const tableStyle: React.CSSProperties = {
  borderCollapse: "collapse",
  width: "100%",
  minWidth: 720,
};

/** 可编辑数值单元格（onSave 传 null = 恢复系统值） */
function EditableCell({
  value,
  overridden,
  editable,
  onSave,
  systemValue,
  bg,
  colSpan,
  blankZero,
  valueColor,
}: {
  value: number;
  overridden: boolean;
  editable: boolean;
  onSave: (v: number | null) => Promise<void>;
  systemValue: number;
  bg?: string;
  colSpan?: number;
  /** true 时值为 0 且无手工纠正显示为空白（如当月无打款记录） */
  blankZero?: boolean;
  /** 无纠正时数值颜色（如失效佣金红色） */
  valueColor?: string;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState<number | null>(value);
  const [saving, setSaving] = useState(false);

  const baseBg = overridden ? C.overrideBg : bg;
  const blank = !!blankZero && value === 0 && !overridden;
  const shown = blank ? "" : fmt(value);

  if (!editable) {
    return (
      <td style={{ ...cellBase, background: baseBg }} colSpan={colSpan}>
        {overridden ? (
          <Tooltip title={`手工纠正值（系统计算 ${fmt(systemValue)}）`}>
            <span style={{ color: "#1677ff", fontWeight: 500 }}>{fmt(value)}</span>
          </Tooltip>
        ) : <span style={{ color: valueColor }}>{shown}</span>}
      </td>
    );
  }

  if (editing) {
    return (
      <td style={{ ...cellBase, padding: 0, background: baseBg }} colSpan={colSpan}>
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
      className="mrt-edit"
      style={{ ...cellBase, cursor: "pointer", background: baseBg }}
      colSpan={colSpan}
      onClick={() => { setDraft(value); setEditing(true); }}
    >
      <span style={{ display: "inline-flex", alignItems: "center", gap: 4 }}>
        {overridden ? (
          <Tooltip title={`手工纠正值（系统计算 ${fmt(systemValue)}），点击修改`}>
            <span style={{ color: "#1677ff", fontWeight: 500 }}>{fmt(value)}</span>
          </Tooltip>
        ) : (
          <span style={{ color: valueColor }}>{shown}</span>
        )}
        <EditOutlined className="mrt-edit-ic" style={{ fontSize: 11, color: "#94a3b8" }} />
        {overridden && (
          <Tooltip title="恢复系统计算值">
            <UndoOutlined
              style={{ fontSize: 11, color: "#faad14" }}
              onClick={async (e) => {
                e.stopPropagation();
                await onSave(null);
              }}
            />
          </Tooltip>
        )}
      </span>
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
    <div>
      <style>{`
        .mrt-edit .mrt-edit-ic { opacity: 0; transition: opacity .15s; }
        .mrt-edit:hover .mrt-edit-ic { opacity: 1; }
        .mrt-edit:hover { box-shadow: inset 0 0 0 1px #91caff; }
      `}</style>

      {/* 汇率提示条 */}
      <div style={{
        display: "flex", flexWrap: "wrap", alignItems: "center", gap: 12,
        padding: "7px 12px", marginBottom: 14,
        background: "#fafcff", border: `1px solid ${C.border}`, borderRadius: 8,
      }}>
        <Tag color={rate.locked ? "orange" : "blue"} style={{ margin: 0 }}>
          {rate.locked ? "月末锁定汇率" : "实时汇率"}
        </Tag>
        <Text style={{ fontSize: 12.5 }}>
          {rate.cnyToUsd > 0 ? <>1 USD = <Text strong>{rate.usdToCny.toFixed(4)}</Text> CNY（{rate.date}）</> : "CNY 汇率快照缺失，人民币折算列不可用"}
        </Text>
        <Text type="secondary" style={{ fontSize: 11.5, marginLeft: "auto" }}>生成于 {report.generatedAt}</Text>
      </div>

      {report.warnings.length > 0 && (
        <Alert
          type="warning"
          showIcon
          style={{ marginBottom: 14 }}
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
      <TableShell title="广告费" hint={editable ? "「广告费(原币)」列可点击修改" : undefined}>
        <table style={tableStyle}>
          <thead>
            <tr>
              <th style={{ ...headCell, textAlign: "left" }}>MCC</th>
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
              <tr><td colSpan={6} style={{ ...cellBase, textAlign: "center", color: "#999", padding: 16 }}>本月无广告消耗</td></tr>
            ) : mccs.map((m: MccSection, idx) => {
              const rowBg = idx % 2 === 1 ? C.zebra : undefined;
              return (
                <tr key={m.mccDbId} style={{ background: rowBg }}>
                  <td style={{ ...cellBase, textAlign: "left" }}>
                    <Text strong style={{ fontSize: 12.5 }}>{m.mccName}</Text>
                    <Text type="secondary" style={{ fontSize: 11, marginLeft: 6 }}>{m.mccId}</Text>
                  </td>
                  <td style={{ ...cellBase, textAlign: "center" }}>
                    <Tag color={m.currency === "CNY" ? "blue" : "green"} style={{ margin: 0 }}>{m.currency === "CNY" ? "人民币" : "美金"}</Tag>
                  </td>
                  <td style={cellBase}>{fmt(m.costOriginal)}</td>
                  <td style={{ ...cellBase, color: m.adjustment > 0 ? undefined : "#c3cad4" }}>{m.adjustment > 0 ? fmt(m.adjustment) : "—"}</td>
                  <EditableCell
                    value={m.effectiveOriginal}
                    overridden={m.override != null}
                    editable={editable}
                    systemValue={m.costOriginal}
                    onSave={(v) => save(`mcc:${m.mccDbId}`, v)}
                  />
                  <td style={{ ...cellBase, fontWeight: 500 }}>{fmt(m.effectiveUsd)}</td>
                </tr>
              );
            })}
            <tr>
              <td style={{ ...totalCell, borderLeft: `1px solid ${C.border}`, textAlign: "left" }} colSpan={2}>广告费合计</td>
              <td style={{ ...totalCell, borderLeft: `1px solid ${C.border}`, textAlign: "center" }} colSpan={2}>
                $ {fmt(report.adCostTotalUsd)}{report.adCostTotalCny > 0 && <> ｜ ¥ {fmt(report.adCostTotalCny)}</>}
              </td>
              <td style={{ ...totalCell, borderLeft: `1px solid ${C.border}`, textAlign: "center" }}>
                <Tooltip title="用于核算利润的广告费：人民币按报表汇率折美金 + 美金累计">核算广告费 $ {fmt(report.profitAdCostUsd)}</Tooltip>
              </td>
              <td style={{ ...totalCell, borderLeft: `1px solid ${C.border}`, textAlign: "center" }}>在投广告数 {report.enabledCampaigns}</td>
            </tr>
          </tbody>
        </table>
      </TableShell>

      {/* ── 佣金区（动态账号列，每账号占 2 列；实收区拆 USD/CNY 双列） ── */}
      <TableShell title="佣金明细" hint={editable ? "所有数值均可点击手工纠正（蓝底为已纠正，↺ 恢复系统值）" : undefined}>
        <table style={tableStyle}>
          <thead>
            <tr>
              <th style={{ ...headCell, textAlign: "left" }} colSpan={2}>广告联盟</th>
              {accounts.map((a: AccountColumn) => (
                <th key={`${a.platform}-${a.accountName}`} style={platHeadCell} colSpan={2}>{a.label}</th>
              ))}
              <th style={{ ...headCell, borderLeft: `2px solid ${C.totalBorder}` }}>佣金合计</th>
            </tr>
            <tr>
              <th style={{ ...acctNameCell, textAlign: "left", fontWeight: 600, color: C.labelText, background: C.labelBg }} colSpan={2}>账号名称</th>
              {accounts.map((a) => (
                <th key={`${a.platform}-${a.accountName}`} style={acctNameCell} colSpan={2}>{a.accountName || "—"}</th>
              ))}
              <th style={{ ...acctNameCell, borderLeft: `2px solid ${C.totalBorder}` }}></th>
            </tr>
          </thead>
          <tbody>
            <tr>
              <td style={labelCell} colSpan={2}>账面佣金（美金）</td>
              {accounts.map((a) => (
                <EditableCell
                  key={a.label}
                  colSpan={2}
                  value={a.bookEffective}
                  overridden={a.bookOverride != null}
                  editable={editable && a.accountName !== "(历史账号)"}
                  systemValue={a.book}
                  onSave={(v) => save(`book:${a.platform}:${a.accountName}`, v)}
                />
              ))}
              <td style={totalCell}>{fmt(totals.book)}</td>
            </tr>
            <tr>
              <td style={labelCell} colSpan={2}>失效佣金（美金）</td>
              {accounts.map((a) => (
                <EditableCell
                  key={a.label}
                  colSpan={2}
                  value={a.rejectedEffective}
                  overridden={a.rejectedOverride != null}
                  editable={editable && a.accountName !== "(历史账号)"}
                  systemValue={a.rejected}
                  valueColor={a.rejectedEffective > 0 ? "#cf1322" : undefined}
                  onSave={(v) => save(`rejected:${a.platform}:${a.accountName}`, v)}
                />
              ))}
              <td style={{ ...totalCell, color: totals.rejected > 0 ? "#cf1322" : undefined }}>{fmt(totals.rejected)}</td>
            </tr>
            {/* 应收 */}
            <tr>
              <td style={labelCell} rowSpan={3}>应收佣金（美金）</td>
              <td style={subLabelCell}>5号 · 上半月</td>
              {accounts.map((a) => (
                <EditableCell
                  key={a.label}
                  colSpan={2}
                  value={a.recvH1Effective}
                  overridden={a.recvH1Override != null}
                  editable={editable && a.accountName !== "(历史账号)"}
                  systemValue={a.recvH1}
                  bg={C.recvBg}
                  blankZero={!a.hasPayments}
                  onSave={(v) => save(`due:${a.platform}:${a.accountName}:H1`, v)}
                />
              ))}
              <td style={totalCell}>{fmt(totals.recvH1)}</td>
            </tr>
            <tr>
              <td style={subLabelCell}>15号 · 下半月</td>
              {accounts.map((a) => (
                <EditableCell
                  key={a.label}
                  colSpan={2}
                  value={a.recvH2Effective}
                  overridden={a.recvH2Override != null}
                  editable={editable && a.accountName !== "(历史账号)"}
                  systemValue={a.recvH2}
                  bg={C.recvBg}
                  blankZero={!a.hasPayments}
                  onSave={(v) => save(`due:${a.platform}:${a.accountName}:H2`, v)}
                />
              ))}
              <td style={totalCell}>{fmt(totals.recvH2)}</td>
            </tr>
            <tr>
              <td style={{ ...subLabelCell, fontWeight: 600 }}>合计</td>
              {accounts.map((a) => (
                <td key={a.label} style={{ ...cellBase, background: C.recvBg, fontWeight: 600 }} colSpan={2}>
                  {a.hasPayments || a.recvH1Override != null || a.recvH2Override != null ? fmt(a.recvH1Effective + a.recvH2Effective) : ""}
                </td>
              ))}
              <td style={totalCell}>{fmt(totals.recvTotal)}</td>
            </tr>
            {/* 实收（USD/CNY 双列，可编辑） */}
            <tr>
              <td style={labelCell} rowSpan={4}>
                实收佣金
                {editable && <div><Text type="secondary" style={{ fontSize: 10.5 }}>点击单元格手工纠正</Text></div>}
              </td>
              <td style={{ ...subLabelCell, background: C.subHeadBg }}></td>
              {accounts.map((a) => (
                <React.Fragment key={a.label}>
                  <td style={{ ...cellBase, background: C.subHeadBg, textAlign: "center", fontSize: 11, fontWeight: 600, color: "#0958d9" }}>USD</td>
                  <td style={{ ...cellBase, background: C.subHeadBg, textAlign: "center", fontSize: 11, fontWeight: 600, color: "#d46b08" }}>
                    <Tooltip title="默认 = 打款日汇率 × 实收(USD)，逐笔折算；点击可手填实际到账人民币">CNY</Tooltip>
                  </td>
                </React.Fragment>
              ))}
              <td style={{ ...totalCell, background: C.subHeadBg, textAlign: "center", fontSize: 11 }}>$ / ¥</td>
            </tr>
            <tr>
              <td style={subLabelCell}>10号 · 上半月</td>
              {accounts.map((a) => (
                <React.Fragment key={a.label}>
                  <EditableCell
                    value={a.paidH1Effective}
                    overridden={a.paidH1Override != null}
                    editable={editable && a.accountName !== "(历史账号)"}
                    systemValue={a.paidH1}
                    bg={C.paidBg}
                    blankZero={!a.hasPayments}
                    onSave={(v) => save(`recv:${a.platform}:${a.accountName}:H1`, v)}
                  />
                  <EditableCell
                    value={a.paidCnyH1Effective}
                    overridden={a.paidCnyH1Override != null}
                    editable={editable && a.accountName !== "(历史账号)"}
                    systemValue={a.paidCnyH1}
                    bg={C.paidBg}
                    blankZero={!a.hasPayments}
                    onSave={(v) => save(`recvcny:${a.platform}:${a.accountName}:H1`, v)}
                  />
                </React.Fragment>
              ))}
              <td style={totalCell}>
                <div>{fmt(totals.paidH1)}</div>
                <div style={{ color: "#d46b08", fontWeight: 500 }}>¥{fmt(totals.paidCnyH1)}</div>
              </td>
            </tr>
            <tr>
              <td style={subLabelCell}>20号 · 下半月</td>
              {accounts.map((a) => (
                <React.Fragment key={a.label}>
                  <EditableCell
                    value={a.paidH2Effective}
                    overridden={a.paidH2Override != null}
                    editable={editable && a.accountName !== "(历史账号)"}
                    systemValue={a.paidH2}
                    bg={C.paidBg}
                    blankZero={!a.hasPayments}
                    onSave={(v) => save(`recv:${a.platform}:${a.accountName}:H2`, v)}
                  />
                  <EditableCell
                    value={a.paidCnyH2Effective}
                    overridden={a.paidCnyH2Override != null}
                    editable={editable && a.accountName !== "(历史账号)"}
                    systemValue={a.paidCnyH2}
                    bg={C.paidBg}
                    blankZero={!a.hasPayments}
                    onSave={(v) => save(`recvcny:${a.platform}:${a.accountName}:H2`, v)}
                  />
                </React.Fragment>
              ))}
              <td style={totalCell}>
                <div>{fmt(totals.paidH2)}</div>
                <div style={{ color: "#d46b08", fontWeight: 500 }}>¥{fmt(totals.paidCnyH2)}</div>
              </td>
            </tr>
            <tr>
              <td style={{ ...subLabelCell, fontWeight: 600 }}>合计</td>
              {accounts.map((a) => {
                const hasPaid = a.hasPayments || a.paidH1Override != null || a.paidH2Override != null
                  || a.paidCnyH1Override != null || a.paidCnyH2Override != null;
                return (
                  <React.Fragment key={a.label}>
                    <td style={{ ...cellBase, background: C.paidBg, fontWeight: 600 }}>{hasPaid ? fmt(a.paidH1Effective + a.paidH2Effective) : ""}</td>
                    <td style={{ ...cellBase, background: C.paidBg, fontWeight: 600, color: "#d46b08" }}>{hasPaid ? fmt(a.paidCnyH1Effective + a.paidCnyH2Effective) : ""}</td>
                  </React.Fragment>
                );
              })}
              <td style={totalCell}>
                <div>{fmt(totals.paidTotal)}</div>
                <div style={{ color: "#d46b08", fontWeight: 500 }}>¥{fmt(totals.paidCnyTotal)}</div>
              </td>
            </tr>
            {/* 收款方式 */}
            <tr>
              <td style={labelCell} colSpan={2}>收款人</td>
              {accounts.map((a) => <td key={a.label} style={{ ...cellBase, textAlign: "center" }} colSpan={2}>{a.payeeName}</td>)}
              <td style={totalCell}></td>
            </tr>
            <tr>
              <td style={labelCell} colSpan={2}>收款卡号</td>
              {accounts.map((a) => <td key={a.label} style={{ ...cellBase, textAlign: "center", fontSize: 11, color: "#6b7686" }} colSpan={2}>{a.cardNo}</td>)}
              <td style={totalCell}></td>
            </tr>
            {/* 可分配利润 */}
            <tr>
              <td style={{ ...labelCell, background: C.profitBg, fontSize: 13 }} colSpan={2}>可分配利润<div><Text type="secondary" style={{ fontSize: 10.5 }}>实收佣金 − 核算广告费</Text></div></td>
              <td style={{ ...cellBase, background: C.profitBg, textAlign: "center", fontSize: 14, fontWeight: 700, color: report.profit.usd >= 0 ? "#389e0d" : "#cf1322" }} colSpan={Math.max(accounts.length * 2, 1)}>
                $ {fmt(report.profit.usd)}{rate.cnyToUsd > 0 && <span style={{ marginLeft: 16 }}>¥ {fmt(report.profit.cny)}</span>}
              </td>
              <td style={{ ...totalCell, background: C.profitBg }}></td>
            </tr>
          </tbody>
        </table>
      </TableShell>
    </div>
  );
}
