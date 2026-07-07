"use client";

/**
 * R-02 月度收支报表 — 类 Excel 预览组件（组员页可编辑 / 组长页只读复用）
 *
 * 布局分两块：
 *   1. 广告费区：MCC 段（原币展示，组员可覆盖）+ 合计 + 核算广告费 + 在投广告数
 *   2. 佣金区：动态账号列（账面/失效/应收/实收USD+CNY/收款方式）+ 合计列 + 可分配利润
 *
 * 可读性设计（2026-07 对眼睛友好版）：
 *   - 左侧行标签列、右侧「佣金合计」列滚动冻结，横向滚动不丢上下文
 *   - 账号列按奇偶做斑马纹，跨行竖向扫读不串列
 *   - 账面/应收/实收/收款/利润 区块之间用粗分隔线，行间留白加大
 *   - 配色收敛：仅保留 平台绿表头 / 合计绿 / 纠正蓝 / 利润绿 四种语义色
 */

import React, { useState } from "react";
import { Typography, InputNumber, Tooltip, Alert, Tag } from "antd";
import { EditOutlined, UndoOutlined } from "@ant-design/icons";
import type { MemberMonthlyReport, MccSection, AccountColumn, TeamMonthlySummary, TeamPlatformAgg } from "@/lib/monthly-report";

const { Text } = Typography;

const fmt = (n: number | null | undefined, empty = "") =>
  n == null ? empty : n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });

// ─── 调色板（收敛到语义色） ───
const C = {
  border: "#e8edf3",
  borderStrong: "#c9d6e4", // 区块分隔线
  labelBg: "#f5f8fb",
  labelText: "#42506b",
  headBg: "#eef3f9",
  platBg: "#e3f2e4", // 平台表头绿（对齐团队 Excel 习惯）
  platText: "#2f6b33",
  acctBg: "#fbfcfd",
  totalBg: "#f2faee",
  totalBorder: "#b7d9a0",
  subHeadBg: "#eef5ff",
  overrideBg: "#e6f4ff",
  profitBg: "#f0f9e8",
  zebra: "#f7fafd", // 偶数账号列底色
};

// 左侧冻结列宽（与 sticky 偏移量必须一致）
const LABEL_W = 148;
const SUB_W = 92;

// ─── 单元格样式（separate 边框模型：每格只画右/下边，外框由外壳提供） ───
const cellBase: React.CSSProperties = {
  borderRight: `1px solid ${C.border}`,
  borderBottom: `1px solid ${C.border}`,
  padding: "7px 10px",
  fontSize: 12.5,
  textAlign: "right",
  whiteSpace: "nowrap",
  fontVariantNumeric: "tabular-nums",
  color: "#1f2937",
  minWidth: 88,
  background: "#fff",
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
const subLabelCell: React.CSSProperties = {
  ...labelCell,
  fontWeight: 400,
  paddingLeft: 14,
  width: SUB_W,
  minWidth: SUB_W,
  maxWidth: SUB_W,
};
const totalCell: React.CSSProperties = {
  ...cellBase,
  background: C.totalBg,
  fontWeight: 600,
  borderLeft: `2px solid ${C.totalBorder}`,
  minWidth: 108,
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

/** 冻结列公共类名 */
const FX0 = "mrt-fx0"; // 左 1 列（或 colSpan=2 的整块标签）
const FX1 = "mrt-fx1"; // 左 2 列（子标签）
const FXR = "mrt-fxr"; // 右侧合计列

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
  // sticky 冻结列与 border-collapse 不兼容，改用 separate + spacing 0
  borderCollapse: "separate",
  borderSpacing: 0,
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
  manualLabel = "手工纠正值",
  systemLabel = "系统计算",
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
  /** 手填值 / 系统值在 Tooltip 中的叫法（总计表用「组长手填 / 默认打款日汇率折算」） */
  manualLabel?: string;
  systemLabel?: string;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState<number | null>(value);
  const [saving, setSaving] = useState(false);

  const baseBg = overridden ? C.overrideBg : bg;
  const blank = !!blankZero && value === 0 && !overridden;
  const shown = blank ? "" : fmt(value);

  if (!editable) {
    return (
      <td style={{ ...cellBase, background: baseBg ?? cellBase.background }} colSpan={colSpan}>
        {overridden ? (
          <Tooltip title={`${manualLabel}（${systemLabel} ${fmt(systemValue)}）`}>
            <span style={{ color: "#1677ff", fontWeight: 500 }}>{fmt(value)}</span>
          </Tooltip>
        ) : <span style={{ color: valueColor }}>{shown}</span>}
      </td>
    );
  }

  if (editing) {
    return (
      <td style={{ ...cellBase, padding: 0, background: baseBg ?? cellBase.background }} colSpan={colSpan}>
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
      style={{ ...cellBase, cursor: "pointer", background: baseBg ?? cellBase.background }}
      colSpan={colSpan}
      onClick={() => { setDraft(value); setEditing(true); }}
    >
      <span style={{ display: "inline-flex", alignItems: "center", gap: 4 }}>
        {overridden ? (
          <Tooltip title={`${manualLabel}（${systemLabel} ${fmt(systemValue)}），点击修改`}>
            <span style={{ color: "#1677ff", fontWeight: 500 }}>{fmt(value)}</span>
          </Tooltip>
        ) : (
          <span style={{ color: valueColor }}>{shown}</span>
        )}
        <EditOutlined className="mrt-edit-ic" style={{ fontSize: 11, color: "#94a3b8" }} />
        {overridden && (
          <Tooltip title={`清除手填，恢复${systemLabel}值`}>
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

const MRT_CSS = `
  .mrt-edit .mrt-edit-ic { opacity: 0; transition: opacity .15s; }
  .mrt-edit:hover .mrt-edit-ic { opacity: 1; }
  .mrt-edit:hover { box-shadow: inset 0 0 0 1px #91caff; }
  /* 冻结列：左侧行标签 / 右侧合计 */
  .${FX0} { position: sticky; left: 0; z-index: 3; }
  .${FX1} { position: sticky; left: ${LABEL_W}px; z-index: 3; box-shadow: 2px 0 4px -2px rgba(15,40,80,.12); }
  .${FX0}[colspan] { box-shadow: 2px 0 4px -2px rgba(15,40,80,.12); }
  .${FXR} { position: sticky; right: 0; z-index: 3; box-shadow: -2px 0 4px -2px rgba(15,40,80,.12); }
  /* 区块分隔线（账面→应收→实收→收款→利润） */
  tr.mrt-sec > td, tr.mrt-sec > th { border-top: 2px solid ${C.borderStrong} !important; }
`;

/** 0 值弱化色（大表里大量 0.00 是主要视觉噪音） */
const muted = (v: number, strong?: string): string | undefined => (Math.abs(v) < 0.005 ? "#c3cad4" : strong);

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

  /** 账号列斑马纹：偶数账号列微底色，竖向扫读不串列（纠正蓝优先于斑马纹） */
  const zebra = (i: number): string | undefined => (i % 2 === 1 ? C.zebra : undefined);

  return (
    <div>
      <style>{MRT_CSS}</style>

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
              const rowBg = idx % 2 === 1 ? C.zebra : "#fff";
              return (
                <tr key={m.mccDbId}>
                  <td style={{ ...cellBase, background: rowBg, textAlign: "left" }}>
                    <Text strong style={{ fontSize: 12.5 }}>{m.mccName}</Text>
                    <Text type="secondary" style={{ fontSize: 11, marginLeft: 6 }}>{m.mccId}</Text>
                  </td>
                  <td style={{ ...cellBase, background: rowBg, textAlign: "center" }}>
                    <Tag color={m.currency === "CNY" ? "blue" : "green"} style={{ margin: 0 }}>{m.currency === "CNY" ? "人民币" : "美金"}</Tag>
                  </td>
                  <td style={{ ...cellBase, background: rowBg }}>{fmt(m.costOriginal)}</td>
                  <td style={{ ...cellBase, background: rowBg, color: m.adjustment > 0 ? undefined : "#c3cad4" }}>{m.adjustment > 0 ? fmt(m.adjustment) : "—"}</td>
                  <EditableCell
                    value={m.effectiveOriginal}
                    overridden={m.override != null}
                    editable={editable}
                    systemValue={m.costOriginal}
                    bg={rowBg}
                    onSave={(v) => save(`mcc:${m.mccDbId}`, v)}
                  />
                  <td style={{ ...cellBase, background: rowBg, fontWeight: 500 }}>{fmt(m.effectiveUsd)}</td>
                </tr>
              );
            })}
            <tr className="mrt-sec">
              <td style={{ ...totalCell, borderLeft: undefined, textAlign: "left" }} colSpan={2}>广告费合计</td>
              <td style={{ ...totalCell, borderLeft: undefined, textAlign: "center" }} colSpan={2}>
                $ {fmt(report.adCostTotalUsd)}{report.adCostTotalCny > 0 && <> ｜ ¥ {fmt(report.adCostTotalCny)}</>}
              </td>
              <td style={{ ...totalCell, borderLeft: undefined, textAlign: "center" }}>
                <Tooltip title="用于核算利润的广告费：人民币按报表汇率折美金 + 美金累计">核算广告费 $ {fmt(report.profitAdCostUsd)}</Tooltip>
              </td>
              <td style={{ ...totalCell, borderLeft: undefined, textAlign: "center" }}>在投广告数 {report.enabledCampaigns}</td>
            </tr>
          </tbody>
        </table>
      </TableShell>

      {/* ── 佣金区（动态账号列，每账号占 2 列；实收区拆 USD/CNY 双列） ── */}
      <TableShell
        title="佣金明细"
        hint={editable ? "所有数值均可点击手工纠正（蓝底为已纠正，↺ 恢复系统值）；左右两侧列已冻结" : "左右两侧列已冻结，可横向滚动"}
      >
        <table style={tableStyle}>
          <thead>
            <tr>
              <th className={FX0} style={{ ...headCell, textAlign: "left", width: LABEL_W + SUB_W, minWidth: LABEL_W + SUB_W }} colSpan={2}>广告联盟</th>
              {accounts.map((a: AccountColumn, i) => (
                <th key={`${a.platform}-${a.accountName}`} style={{ ...platHeadCell, background: i % 2 === 1 ? "#d8ecd9" : C.platBg }} colSpan={2}>{a.label}</th>
              ))}
              <th className={FXR} style={{ ...headCell, borderLeft: `2px solid ${C.totalBorder}` }}>佣金合计</th>
            </tr>
            <tr>
              <th className={FX0} style={{ ...acctNameCell, textAlign: "left", fontWeight: 600, color: C.labelText, background: C.labelBg }} colSpan={2}>账号名称</th>
              {accounts.map((a, i) => (
                <th key={`${a.platform}-${a.accountName}`} style={{ ...acctNameCell, background: zebra(i) ?? C.acctBg }} colSpan={2}>{a.accountName || "—"}</th>
              ))}
              <th className={FXR} style={{ ...acctNameCell, background: C.totalBg, borderLeft: `2px solid ${C.totalBorder}` }}></th>
            </tr>
          </thead>
          <tbody>
            <tr>
              <td className={FX0} style={labelCell} colSpan={2}>账面佣金（美金）</td>
              {accounts.map((a, i) => (
                <EditableCell
                  key={a.label}
                  colSpan={2}
                  value={a.bookEffective}
                  overridden={a.bookOverride != null}
                  editable={editable && a.accountName !== "(历史账号)"}
                  systemValue={a.book}
                  bg={zebra(i)}
                  onSave={(v) => save(`book:${a.platform}:${a.accountName}`, v)}
                />
              ))}
              <td className={FXR} style={totalCell}>{fmt(totals.book)}</td>
            </tr>
            <tr>
              <td className={FX0} style={labelCell} colSpan={2}>失效佣金（美金）</td>
              {accounts.map((a, i) => (
                <EditableCell
                  key={a.label}
                  colSpan={2}
                  value={a.rejectedEffective}
                  overridden={a.rejectedOverride != null}
                  editable={editable && a.accountName !== "(历史账号)"}
                  systemValue={a.rejected}
                  bg={zebra(i)}
                  valueColor={a.rejectedEffective > 0 ? "#cf1322" : "#c3cad4"}
                  onSave={(v) => save(`rejected:${a.platform}:${a.accountName}`, v)}
                />
              ))}
              <td className={FXR} style={{ ...totalCell, color: totals.rejected > 0 ? "#cf1322" : undefined }}>{fmt(totals.rejected)}</td>
            </tr>
            {/* 应收 */}
            <tr className="mrt-sec">
              <td className={FX0} rowSpan={3} style={{ ...labelCell, width: LABEL_W, minWidth: LABEL_W, maxWidth: LABEL_W }}>应收佣金（美金）</td>
              <td className={FX1} style={subLabelCell}>5号 · 上半月</td>
              {accounts.map((a, i) => (
                <EditableCell
                  key={a.label}
                  colSpan={2}
                  value={a.recvH1Effective}
                  overridden={a.recvH1Override != null}
                  editable={editable && a.accountName !== "(历史账号)"}
                  systemValue={a.recvH1}
                  bg={zebra(i)}
                  blankZero={!a.hasPayments}
                  onSave={(v) => save(`due:${a.platform}:${a.accountName}:H1`, v)}
                />
              ))}
              <td className={FXR} style={totalCell}>{fmt(totals.recvH1)}</td>
            </tr>
            <tr>
              <td className={FX1} style={subLabelCell}>15号 · 下半月</td>
              {accounts.map((a, i) => (
                <EditableCell
                  key={a.label}
                  colSpan={2}
                  value={a.recvH2Effective}
                  overridden={a.recvH2Override != null}
                  editable={editable && a.accountName !== "(历史账号)"}
                  systemValue={a.recvH2}
                  bg={zebra(i)}
                  blankZero={!a.hasPayments}
                  onSave={(v) => save(`due:${a.platform}:${a.accountName}:H2`, v)}
                />
              ))}
              <td className={FXR} style={totalCell}>{fmt(totals.recvH2)}</td>
            </tr>
            <tr>
              <td className={FX1} style={{ ...subLabelCell, fontWeight: 600 }}>合计</td>
              {accounts.map((a, i) => (
                <td key={a.label} style={{ ...cellBase, background: zebra(i) ?? "#fff", fontWeight: 600 }} colSpan={2}>
                  {a.hasPayments || a.recvH1Override != null || a.recvH2Override != null ? fmt(a.recvH1Effective + a.recvH2Effective) : ""}
                </td>
              ))}
              <td className={FXR} style={totalCell}>{fmt(totals.recvTotal)}</td>
            </tr>
            {/* 实收（USD/CNY 双列，可编辑） */}
            <tr className="mrt-sec">
              <td className={FX0} rowSpan={4} style={{ ...labelCell, width: LABEL_W, minWidth: LABEL_W, maxWidth: LABEL_W }}>
                实收佣金
                {editable && <div><Text type="secondary" style={{ fontSize: 10.5 }}>点击单元格手工纠正</Text></div>}
              </td>
              <td className={FX1} style={{ ...subLabelCell, background: C.subHeadBg }}></td>
              {accounts.map((a) => (
                <React.Fragment key={a.label}>
                  <td style={{ ...cellBase, background: C.subHeadBg, textAlign: "center", fontSize: 11, fontWeight: 600, color: "#0958d9" }}>USD</td>
                  <td style={{ ...cellBase, background: C.subHeadBg, textAlign: "center", fontSize: 11, fontWeight: 600, color: "#d46b08" }}>
                    <Tooltip title="默认 = 打款日汇率 × 实收(USD)，逐笔折算；点击可手填实际到账人民币">CNY</Tooltip>
                  </td>
                </React.Fragment>
              ))}
              <td className={FXR} style={{ ...totalCell, background: C.subHeadBg, textAlign: "center", fontSize: 11 }}>$ / ¥</td>
            </tr>
            <tr>
              <td className={FX1} style={subLabelCell}>10号 · 上半月</td>
              {accounts.map((a, i) => (
                <React.Fragment key={a.label}>
                  <EditableCell
                    value={a.paidH1Effective}
                    overridden={a.paidH1Override != null}
                    editable={editable && a.accountName !== "(历史账号)"}
                    systemValue={a.paidH1}
                    bg={zebra(i)}
                    blankZero={!a.hasPayments}
                    onSave={(v) => save(`recv:${a.platform}:${a.accountName}:H1`, v)}
                  />
                  <EditableCell
                    value={a.paidCnyH1Effective}
                    overridden={a.paidCnyH1Override != null}
                    editable={editable && a.accountName !== "(历史账号)"}
                    systemValue={a.paidCnyH1}
                    bg={zebra(i)}
                    blankZero={!a.hasPayments}
                    onSave={(v) => save(`recvcny:${a.platform}:${a.accountName}:H1`, v)}
                  />
                </React.Fragment>
              ))}
              <td className={FXR} style={totalCell}>
                <div>{fmt(totals.paidH1)}</div>
                <div style={{ color: "#d46b08", fontWeight: 500 }}>¥{fmt(totals.paidCnyH1)}</div>
              </td>
            </tr>
            <tr>
              <td className={FX1} style={subLabelCell}>20号 · 下半月</td>
              {accounts.map((a, i) => (
                <React.Fragment key={a.label}>
                  <EditableCell
                    value={a.paidH2Effective}
                    overridden={a.paidH2Override != null}
                    editable={editable && a.accountName !== "(历史账号)"}
                    systemValue={a.paidH2}
                    bg={zebra(i)}
                    blankZero={!a.hasPayments}
                    onSave={(v) => save(`recv:${a.platform}:${a.accountName}:H2`, v)}
                  />
                  <EditableCell
                    value={a.paidCnyH2Effective}
                    overridden={a.paidCnyH2Override != null}
                    editable={editable && a.accountName !== "(历史账号)"}
                    systemValue={a.paidCnyH2}
                    bg={zebra(i)}
                    blankZero={!a.hasPayments}
                    onSave={(v) => save(`recvcny:${a.platform}:${a.accountName}:H2`, v)}
                  />
                </React.Fragment>
              ))}
              <td className={FXR} style={totalCell}>
                <div>{fmt(totals.paidH2)}</div>
                <div style={{ color: "#d46b08", fontWeight: 500 }}>¥{fmt(totals.paidCnyH2)}</div>
              </td>
            </tr>
            <tr>
              <td className={FX1} style={{ ...subLabelCell, fontWeight: 600 }}>合计</td>
              {accounts.map((a, i) => {
                const hasPaid = a.hasPayments || a.paidH1Override != null || a.paidH2Override != null
                  || a.paidCnyH1Override != null || a.paidCnyH2Override != null;
                return (
                  <React.Fragment key={a.label}>
                    <td style={{ ...cellBase, background: zebra(i) ?? "#fff", fontWeight: 600 }}>{hasPaid ? fmt(a.paidH1Effective + a.paidH2Effective) : ""}</td>
                    <td style={{ ...cellBase, background: zebra(i) ?? "#fff", fontWeight: 600, color: "#d46b08" }}>{hasPaid ? fmt(a.paidCnyH1Effective + a.paidCnyH2Effective) : ""}</td>
                  </React.Fragment>
                );
              })}
              <td className={FXR} style={totalCell}>
                <div>{fmt(totals.paidTotal)}</div>
                <div style={{ color: "#d46b08", fontWeight: 500 }}>¥{fmt(totals.paidCnyTotal)}</div>
              </td>
            </tr>
            {/* 收款方式 */}
            <tr className="mrt-sec">
              <td className={FX0} style={labelCell} colSpan={2}>收款人</td>
              {accounts.map((a, i) => <td key={a.label} style={{ ...cellBase, background: zebra(i) ?? "#fff", textAlign: "center" }} colSpan={2}>{a.payeeName}</td>)}
              <td className={FXR} style={totalCell}></td>
            </tr>
            <tr>
              <td className={FX0} style={labelCell} colSpan={2}>收款卡号</td>
              {accounts.map((a, i) => <td key={a.label} style={{ ...cellBase, background: zebra(i) ?? "#fff", textAlign: "center", fontSize: 11, color: "#6b7686" }} colSpan={2}>{a.cardNo}</td>)}
              <td className={FXR} style={totalCell}></td>
            </tr>
            {/* 可分配利润 */}
            <tr className="mrt-sec">
              <td className={FX0} style={{ ...labelCell, background: C.profitBg, fontSize: 13 }} colSpan={2}>可分配利润<div><Text type="secondary" style={{ fontSize: 10.5 }}>实收佣金 − 核算广告费</Text></div></td>
              <td style={{ ...cellBase, background: C.profitBg, textAlign: "center", fontSize: 14, fontWeight: 700, color: report.profit.usd >= 0 ? "#389e0d" : "#cf1322" }} colSpan={Math.max(accounts.length * 2, 1)}>
                $ {fmt(report.profit.usd)}{rate.cnyToUsd > 0 && <span style={{ marginLeft: 16 }}>¥ {fmt(report.profit.cny)}</span>}
              </td>
              <td className={FXR} style={{ ...totalCell, background: C.profitBg }}></td>
            </tr>
          </tbody>
        </table>
      </TableShell>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────
// 组长端总计表（R-04.6）：与导出 Excel「总计表」同构 —— 平台做列（每平台
// 占 $ / ¥ 两列），指标做行；沿用成员表的冻结列 / 斑马纹 / 语义色体系。
// 仅实收区的 ¥ 列可编辑（组长手填实际到账，未填默认成员实收CNY累计）。
// ─────────────────────────────────────────────────────────────

export function TeamSummaryTable({
  summary,
  onSavePlatCny,
}: {
  summary: TeamMonthlySummary;
  /** 保存某平台上/下半月实收(¥)手填，value=null 清除恢复默认 */
  onSavePlatCny?: (platform: string, half: "H1" | "H2", value: number | null) => Promise<void>;
}) {
  const plats = summary.platforms;
  const { totals } = summary;
  const zebra = (i: number): string | undefined => (i % 2 === 1 ? C.zebra : undefined);
  const editable = !!onSavePlatCny;

  /** 账面/失效/应收：平台占 2 列合并的只读数值行 */
  const mergedRow = (
    key: string,
    get: (p: TeamPlatformAgg) => number,
    total: number,
    opts?: { bold?: boolean; red?: boolean },
  ) => (
    <>
      {plats.map((p, i) => {
        const v = get(p);
        return (
          <td key={`${key}-${p.platform}`} colSpan={2} style={{
            ...cellBase,
            background: zebra(i) ?? "#fff",
            fontWeight: opts?.bold ? 600 : undefined,
            color: muted(v, opts?.red && v > 0 ? "#cf1322" : undefined),
          }}>
            {fmt(v)}
          </td>
        );
      })}
      <td className={FXR} style={{ ...totalCell, color: opts?.red && total > 0 ? "#cf1322" : undefined }}>{fmt(total)}</td>
    </>
  );

  /** 实收行：平台拆 $（支付数据，只读）/ ¥ 两列。
   *  ¥ 取值优先级：组长手填(蓝) > 银行流水登记(绿) > 成员默认CNY累计(灰) */
  const paidRow = (
    half: "H1" | "H2",
    getUsd: (p: TeamPlatformAgg) => number,
    getCnyManual: (p: TeamPlatformAgg) => number | null,
    getCnyBank: (p: TeamPlatformAgg) => number | null,
    getCnyDefault: (p: TeamPlatformAgg) => number,
    totalUsd: number,
  ) => {
    const totalCny = plats.reduce((s, p) => s + (getCnyManual(p) ?? getCnyBank(p) ?? getCnyDefault(p)), 0);
    return (
      <>
        {plats.map((p, i) => {
          const usd = getUsd(p);
          const manual = getCnyManual(p);
          const bank = getCnyBank(p);
          return (
            <React.Fragment key={`paid-${half}-${p.platform}`}>
              <td style={{ ...cellBase, background: zebra(i) ?? "#fff", color: muted(usd) }}>{fmt(usd)}</td>
              <EditableCell
                value={manual ?? bank ?? getCnyDefault(p)}
                overridden={manual != null}
                editable={editable}
                systemValue={bank ?? getCnyDefault(p)}
                bg={zebra(i)}
                valueColor={bank != null ? "#389e0d" : muted(getCnyDefault(p), "#8a94a3")}
                manualLabel="组长手填实际到账(¥)"
                systemLabel={bank != null ? "银行流水登记合计(¥)" : "默认值·成员实收CNY累计(打款日汇率)"}
                onSave={(v) => onSavePlatCny!(p.platform, half, v)}
              />
            </React.Fragment>
          );
        })}
        <td className={FXR} style={totalCell}>
          <div>{fmt(totalUsd)}</div>
          <div style={{ color: "#d46b08", fontWeight: 500 }}>¥{fmt(totalCny)}</div>
        </td>
      </>
    );
  };

  const cnyTotal = (half: "H1" | "H2") =>
    plats.reduce((s, p) => s + ((half === "H1"
      ? p.paidCnyH1 ?? p.bankCnyH1 ?? p.memberCnyH1
      : p.paidCnyH2 ?? p.bankCnyH2 ?? p.memberCnyH2)), 0);

  return (
    <div>
      <style>{MRT_CSS}</style>
      <TableShell
        title="总计表 · 按平台聚合（全员累计）"
        hint={editable ? "实收 ¥ 列可点击手填实际到账（蓝字为已手填，↺ 恢复默认）；左右两侧列已冻结" : "左右两侧列已冻结，可横向滚动"}
      >
        <table style={tableStyle}>
          <thead>
            <tr>
              <th className={FX0} style={{ ...headCell, textAlign: "left", width: LABEL_W + SUB_W, minWidth: LABEL_W + SUB_W }} colSpan={2}>广告联盟</th>
              {plats.map((p, i) => (
                <th key={p.platform} style={{ ...platHeadCell, background: i % 2 === 1 ? "#d8ecd9" : C.platBg }} colSpan={2}>{p.platform}</th>
              ))}
              <th className={FXR} style={{ ...headCell, borderLeft: `2px solid ${C.totalBorder}` }}>佣金合计</th>
            </tr>
          </thead>
          <tbody>
            <tr>
              <td className={FX0} style={labelCell} colSpan={2}>账面佣金（美金）</td>
              {mergedRow("book", (p) => p.book, totals.book)}
            </tr>
            <tr>
              <td className={FX0} style={labelCell} colSpan={2}>失效佣金（美金）</td>
              {mergedRow("rejected", (p) => p.rejected, totals.rejected, { red: true })}
            </tr>
            {/* 应收 */}
            <tr className="mrt-sec">
              <td className={FX0} rowSpan={3} style={{ ...labelCell, width: LABEL_W, minWidth: LABEL_W, maxWidth: LABEL_W }}>应收佣金（美金）</td>
              <td className={FX1} style={subLabelCell}>5号 · 上半月</td>
              {mergedRow("recvH1", (p) => p.recvH1, totals.recvH1)}
            </tr>
            <tr>
              <td className={FX1} style={subLabelCell}>15号 · 下半月</td>
              {mergedRow("recvH2", (p) => p.recvH2, totals.recvH2)}
            </tr>
            <tr>
              <td className={FX1} style={{ ...subLabelCell, fontWeight: 600 }}>合计</td>
              {mergedRow("recvTotal", (p) => p.recvH1 + p.recvH2, totals.recvTotal, { bold: true })}
            </tr>
            {/* 实收（$ 只读 / ¥ 可手填） */}
            <tr className="mrt-sec">
              <td className={FX0} rowSpan={4} style={{ ...labelCell, width: LABEL_W, minWidth: LABEL_W, maxWidth: LABEL_W }}>
                实收佣金
                {editable && <div><Text type="secondary" style={{ fontSize: 10.5 }}>¥ 列可点击手填</Text></div>}
              </td>
              <td className={FX1} style={{ ...subLabelCell, background: C.subHeadBg }}></td>
              {plats.map((p) => (
                <React.Fragment key={`head-${p.platform}`}>
                  <td style={{ ...cellBase, background: C.subHeadBg, textAlign: "center", fontSize: 11, fontWeight: 600, color: "#0958d9" }}>
                    <Tooltip title="支付数据累计（USD），只读">USD</Tooltip>
                  </td>
                  <td style={{ ...cellBase, background: C.subHeadBg, textAlign: "center", fontSize: 11, fontWeight: 600, color: "#d46b08" }}>
                    <Tooltip title="实际到账人民币。取值优先级：组长手填(蓝) > 银行流水登记自动同步(绿) > 成员实收CNY累计·打款日汇率(灰)">CNY</Tooltip>
                  </td>
                </React.Fragment>
              ))}
              <td className={FXR} style={{ ...totalCell, background: C.subHeadBg, textAlign: "center", fontSize: 11 }}>$ / ¥</td>
            </tr>
            <tr>
              <td className={FX1} style={subLabelCell}>10号 · 上半月</td>
              {paidRow("H1", (p) => p.paidH1, (p) => p.paidCnyH1, (p) => p.bankCnyH1, (p) => p.memberCnyH1, totals.paidH1)}
            </tr>
            <tr>
              <td className={FX1} style={subLabelCell}>20号 · 下半月</td>
              {paidRow("H2", (p) => p.paidH2, (p) => p.paidCnyH2, (p) => p.bankCnyH2, (p) => p.memberCnyH2, totals.paidH2)}
            </tr>
            <tr>
              <td className={FX1} style={{ ...subLabelCell, fontWeight: 600 }}>合计</td>
              {plats.map((p, i) => {
                const usd = p.paidH1 + p.paidH2;
                const cny = (p.paidCnyH1 ?? p.bankCnyH1 ?? p.memberCnyH1) + (p.paidCnyH2 ?? p.bankCnyH2 ?? p.memberCnyH2);
                const hasManual = p.paidCnyH1 != null || p.paidCnyH2 != null || p.bankCnyH1 != null || p.bankCnyH2 != null;
                return (
                  <React.Fragment key={`paid-sum-${p.platform}`}>
                    <td style={{ ...cellBase, background: zebra(i) ?? "#fff", fontWeight: 600, color: muted(usd) }}>{fmt(usd)}</td>
                    <td style={{ ...cellBase, background: zebra(i) ?? "#fff", fontWeight: 600, color: muted(cny, hasManual ? "#1677ff" : "#d46b08") }}>{fmt(cny)}</td>
                  </React.Fragment>
                );
              })}
              <td className={FXR} style={totalCell}>
                <div>{fmt(totals.paidTotal)}</div>
                <div style={{ color: "#d46b08", fontWeight: 500 }}>¥{fmt(cnyTotal("H1") + cnyTotal("H2"))}</div>
              </td>
            </tr>
            {/* 收款人 / 收款卡号 */}
            <tr className="mrt-sec">
              <td className={FX0} style={labelCell} colSpan={2}>收款人</td>
              {plats.map((p, i) => (
                <td key={`payee-${p.platform}`} colSpan={2} style={{ ...cellBase, background: zebra(i) ?? "#fff", textAlign: "center", whiteSpace: "normal", fontSize: 11.5, lineHeight: 1.7 }}>
                  {p.payees.length === 0 ? <span style={{ color: "#c3cad4" }}>—</span> : p.payees.map((pe) => <div key={pe.name}>{pe.name}</div>)}
                </td>
              ))}
              <td className={FXR} style={totalCell}></td>
            </tr>
            <tr>
              <td className={FX0} style={labelCell} colSpan={2}>收款卡号</td>
              {plats.map((p, i) => (
                <td key={`card-${p.platform}`} colSpan={2} style={{ ...cellBase, background: zebra(i) ?? "#fff", textAlign: "center", whiteSpace: "normal", fontSize: 11, color: "#6b7686", lineHeight: 1.7 }}>
                  {p.payees.length === 0 ? <span style={{ color: "#c3cad4" }}>—</span> : p.payees.map((pe) => <div key={pe.name}>{pe.cards.join("、") || "—"}</div>)}
                </td>
              ))}
              <td className={FXR} style={totalCell}></td>
            </tr>
          </tbody>
        </table>
      </TableShell>
    </div>
  );
}
