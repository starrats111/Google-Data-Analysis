"use client";

/**
 * R-02 月度收支报表 — 类 Excel 预览组件（组员页可编辑 / 组长页只读复用）
 *
 * 布局分两块：
 *   1. 广告费区：MCC 段（原币展示，组员可覆盖）+ 合计 + 核算广告费 + 在投广告数
 *   2. 佣金区：动态账号列（账面/失效/应收/实收 USD|CNY/收款方式）+ 合计列 + 可分配利润
 */

import React, { useState } from "react";
import { InputNumber, Tooltip, Alert, Tag } from "antd";
import { EditOutlined, UndoOutlined } from "@ant-design/icons";
import type { MemberMonthlyReport, MccSection, AccountColumn } from "@/lib/monthly-report";

const fmt = (n: number | null | undefined, empty = "") =>
  n == null ? empty : n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });

const CSS = `
.mrt { overflow-x: auto; }
.mrt table { border-collapse: collapse; min-width: 720px; font-size: 12.5px; color: #344054; }
.mrt th, .mrt td { border: 1px solid #e4e8ee; padding: 6px 12px; white-space: nowrap; height: 20px; }
.mrt .n { text-align: right; font-variant-numeric: tabular-nums; }
.mrt .c { text-align: center; }
.mrt-head { background: #f5f7fa; text-align: center; font-weight: 600; color: #475467; }
.mrt-plat { background: #e5f1d8; text-align: center; font-weight: 700; color: #48682a; }
.mrt-acct { background: #f4f9ee; text-align: center; font-weight: 400; color: #8b97a8; font-size: 11px; }
.mrt-label { background: #fafbfc; font-weight: 600; text-align: left; color: #475467; }
.mrt-sub { background: #fcfdfe; color: #667085; text-align: left; }
.mrt-subhead { background: #f8fafc; color: #98a2b3; font-size: 10.5px; text-align: center; padding: 2px 8px; letter-spacing: 0.5px; }
.mrt-total { background: #f2f9ec; font-weight: 600; }
.mrt-rowtotal td { background: #fbfdf8; font-weight: 600; }
.mrt-cur { color: #98a2b3; font-size: 10.5px; margin-right: 2px; font-weight: 400; }
.mrt-sec { color: #98a2b3; font-size: 10.5px; font-weight: 400; }
.mrt-ed { cursor: pointer; transition: background 0.15s; }
.mrt-ed:hover { background: #f0f7ff; }
.mrt-ed-ic { font-size: 10px; color: #b6c2d1; opacity: 0; margin-left: 5px; transition: opacity 0.15s; }
.mrt-ed:hover .mrt-ed-ic { opacity: 1; }
.mrt-ovr { background: #eef6ff; }
.mrt-ovr-v { color: #1677ff; font-weight: 600; }
.mrt-undo { font-size: 10px; color: #faad14; margin-left: 5px; }
.mrt-profit td { background: #e9f6e2; font-weight: 700; font-size: 13px; color: #3a5a20; padding: 8px 12px; }
.mrt-meta { display: flex; align-items: center; gap: 10px; margin-bottom: 12px; font-size: 12px; color: #667085; }
.mrt-hint { font-size: 10px; color: #98a2b3; font-weight: 400; }
`;

/** 可编辑数值单元格（onSave 传 null = 恢复系统值） */
function EditableCell({
  value,
  overridden,
  editable,
  onSave,
  systemValue,
  cur,
}: {
  value: number;
  overridden: boolean;
  editable: boolean;
  onSave: (v: number | null) => Promise<void>;
  systemValue: number;
  cur?: string;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState<number | null>(value);
  const [saving, setSaving] = useState(false);

  const body = (
    <>
      {cur && <span className="mrt-cur">{cur}</span>}
      {overridden ? (
        <Tooltip title={`手工纠正值（系统计算 ${fmt(systemValue)}）${editable ? "，点击修改" : ""}`}>
          <span className="mrt-ovr-v">{fmt(value)}</span>
        </Tooltip>
      ) : (
        <span>{fmt(value)}</span>
      )}
    </>
  );

  if (!editable) {
    return <td className={`n${overridden ? " mrt-ovr" : ""}`}>{body}</td>;
  }

  if (editing) {
    const commit = async () => {
      setSaving(true);
      await onSave(draft ?? 0);
      setSaving(false);
      setEditing(false);
    };
    return (
      <td style={{ padding: 0, minWidth: 90 }}>
        <InputNumber
          autoFocus
          size="small"
          min={0}
          value={draft}
          disabled={saving}
          style={{ width: "100%" }}
          onChange={(v) => setDraft(v)}
          onPressEnter={commit}
          onBlur={commit}
        />
      </td>
    );
  }

  return (
    <td
      className={`n mrt-ed${overridden ? " mrt-ovr" : ""}`}
      onClick={() => { setDraft(value); setEditing(true); }}
    >
      {body}
      <EditOutlined className="mrt-ed-ic" />
      {overridden && (
        <Tooltip title="恢复系统计算值">
          <UndoOutlined
            className="mrt-undo"
            onClick={async (e) => {
              e.stopPropagation();
              await onSave(null);
            }}
          />
        </Tooltip>
      )}
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
    <div className="mrt">
      <style>{CSS}</style>

      {/* 汇率 / 生成时间（低调元信息条） */}
      <div className="mrt-meta">
        {rate.cnyToUsd > 0 ? (
          <>
            <Tag color={rate.locked ? "gold" : "blue"} style={{ margin: 0 }}>
              {rate.locked ? "月末锁定" : "实时汇率"}
            </Tag>
            <span>1 USD = {rate.usdToCny.toFixed(4)} CNY（{rate.date}）</span>
          </>
        ) : (
          <Tag color="red" style={{ margin: 0 }}>CNY 汇率快照缺失，人民币折算列不可用</Tag>
        )}
        <span>报表生成 {report.generatedAt}</span>
      </div>

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
      <table style={{ marginBottom: 16 }}>
        <thead>
          <tr>
            <th className="mrt-head">MCC</th>
            <th className="mrt-head">币种</th>
            <th className="mrt-head">库内广告费(原币)</th>
            <th className="mrt-head">
              <Tooltip title="数据中心「MCC 误差费用」，USD 口径">补差额($)</Tooltip>
            </th>
            <th className="mrt-head">
              <Tooltip title="点击修改：手动覆盖后按覆盖值(原币)计算，实时对组长可见">广告费(原币{editable ? "，可改" : ""})</Tooltip>
            </th>
            <th className="mrt-head">折美金($)</th>
          </tr>
        </thead>
        <tbody>
          {mccs.length === 0 ? (
            <tr><td colSpan={6} className="c" style={{ color: "#98a2b3" }}>本月无广告消耗</td></tr>
          ) : mccs.map((m: MccSection) => (
            <tr key={m.mccDbId}>
              <td>
                {m.mccName}
                <div className="mrt-sec">{m.mccId}</div>
              </td>
              <td className="c">
                <Tag color={m.currency === "CNY" ? "blue" : "green"} style={{ margin: 0 }}>{m.currency === "CNY" ? "人民币" : "美金"}</Tag>
              </td>
              <td className="n">{fmt(m.costOriginal)}</td>
              <td className="n">{m.adjustment > 0 ? fmt(m.adjustment) : <span className="mrt-sec">—</span>}</td>
              <EditableCell
                value={m.effectiveOriginal}
                overridden={m.override != null}
                editable={editable}
                systemValue={m.costOriginal}
                onSave={(v) => save(`mcc:${m.mccDbId}`, v)}
              />
              <td className="n">{fmt(m.effectiveUsd)}</td>
            </tr>
          ))}
          <tr>
            <td className="mrt-total" colSpan={2}>广告费合计</td>
            <td className="mrt-total n" colSpan={2}>
              <span className="mrt-cur">$</span>{fmt(report.adCostTotalUsd)}
              {report.adCostTotalCny > 0 && <>　<span className="mrt-cur">¥</span>{fmt(report.adCostTotalCny)}</>}
            </td>
            <td className="mrt-total n">
              <Tooltip title="用于核算利润的广告费：人民币按报表汇率折美金 + 美金累计">
                核算 <span className="mrt-cur">$</span>{fmt(report.profitAdCostUsd)}
              </Tooltip>
            </td>
            <td className="mrt-total c">在投广告 {report.enabledCampaigns}</td>
          </tr>
        </tbody>
      </table>

      {/* ── 佣金区（动态账号列，每账号占 2 列；实收区拆 USD/CNY 双列） ── */}
      <table>
        <thead>
          <tr>
            <th className="mrt-head" colSpan={2}>广告联盟</th>
            {accounts.map((a: AccountColumn) => (
              <th key={`${a.platform}-${a.accountName}`} className="mrt-plat" colSpan={2}>{a.label}</th>
            ))}
            <th className="mrt-head">佣金合计</th>
          </tr>
          <tr>
            <th className="mrt-subhead" colSpan={2}>账号名称</th>
            {accounts.map((a) => (
              <th key={`${a.platform}-${a.accountName}`} className="mrt-acct" colSpan={2}>{a.accountName || "—"}</th>
            ))}
            <th className="mrt-acct"></th>
          </tr>
        </thead>
        <tbody>
          <tr>
            <td className="mrt-label" colSpan={2}>账面佣金（美金）</td>
            {accounts.map((a) => <td key={a.label} className="n" colSpan={2}>{fmt(a.book)}</td>)}
            <td className="mrt-total n">{fmt(totals.book)}</td>
          </tr>
          <tr>
            <td className="mrt-label" colSpan={2}>失效佣金（美金）</td>
            {accounts.map((a) => <td key={a.label} className="n" colSpan={2}>{fmt(a.rejected)}</td>)}
            <td className="mrt-total n">{fmt(totals.rejected)}</td>
          </tr>
          {/* 应收 */}
          <tr>
            <td className="mrt-label" rowSpan={3}>应收佣金（美金）</td>
            <td className="mrt-sub">5号（上半月）</td>
            {accounts.map((a) => <td key={a.label} className="n" colSpan={2}>{a.hasPayments ? fmt(a.recvH1) : ""}</td>)}
            <td className="mrt-total n">{fmt(totals.recvH1)}</td>
          </tr>
          <tr>
            <td className="mrt-sub">15号（下半月）</td>
            {accounts.map((a) => <td key={a.label} className="n" colSpan={2}>{a.hasPayments ? fmt(a.recvH2) : ""}</td>)}
            <td className="mrt-total n">{fmt(totals.recvH2)}</td>
          </tr>
          <tr className="mrt-rowtotal">
            <td className="mrt-sub">合计</td>
            {accounts.map((a) => <td key={a.label} className="n" colSpan={2}>{a.hasPayments ? fmt(a.recvH1 + a.recvH2) : ""}</td>)}
            <td className="mrt-total n">{fmt(totals.recvTotal)}</td>
          </tr>
          {/* 实收（USD/CNY 双列，可编辑） */}
          <tr>
            <td className="mrt-label" rowSpan={4}>
              实收佣金
              {editable && <div className="mrt-hint">点击单元格可手工纠正</div>}
            </td>
            <td className="mrt-sub"></td>
            {accounts.map((a) => (
              <React.Fragment key={a.label}>
                <td className="mrt-subhead">USD</td>
                <td className="mrt-subhead">
                  <Tooltip title="默认 = 打款日汇率 × 实收(USD)，逐笔折算；可手填实际到账人民币">CNY</Tooltip>
                </td>
              </React.Fragment>
            ))}
            <td className="mrt-subhead">$ / ¥</td>
          </tr>
          <tr>
            <td className="mrt-sub">10号（上半月）</td>
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
            <td className="mrt-total n">
              {fmt(totals.paidH1)}
              <div className="mrt-sec">¥{fmt(totals.paidCnyH1)}</div>
            </td>
          </tr>
          <tr>
            <td className="mrt-sub">20号（下半月）</td>
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
            <td className="mrt-total n">
              {fmt(totals.paidH2)}
              <div className="mrt-sec">¥{fmt(totals.paidCnyH2)}</div>
            </td>
          </tr>
          <tr className="mrt-rowtotal">
            <td className="mrt-sub">合计</td>
            {accounts.map((a) => (
              <React.Fragment key={a.label}>
                <td className="n">{fmt(a.paidH1Effective + a.paidH2Effective)}</td>
                <td className="n">{fmt(a.paidCnyH1Effective + a.paidCnyH2Effective)}</td>
              </React.Fragment>
            ))}
            <td className="mrt-total n">
              {fmt(totals.paidTotal)}
              <div className="mrt-sec">¥{fmt(totals.paidCnyTotal)}</div>
            </td>
          </tr>
          {/* 收款方式 */}
          <tr>
            <td className="mrt-label" colSpan={2}>收款人</td>
            {accounts.map((a) => <td key={a.label} className="c" colSpan={2}>{a.payeeName}</td>)}
            <td></td>
          </tr>
          <tr>
            <td className="mrt-label" colSpan={2}>收款卡号</td>
            {accounts.map((a) => <td key={a.label} className="c" colSpan={2} style={{ fontSize: 11 }}>{a.cardNo}</td>)}
            <td></td>
          </tr>
          {/* 可分配利润 */}
          <tr className="mrt-profit">
            <td colSpan={2}>可分配利润（实收佣金 − 核算广告费）</td>
            <td className="n" colSpan={Math.max(accounts.length * 2, 1) + 1}>
              <span className="mrt-cur">$</span>{fmt(report.profit.usd)}
              {rate.cnyToUsd > 0 && <>　<span className="mrt-cur">¥</span>{fmt(report.profit.cny)}</>}
            </td>
          </tr>
        </tbody>
      </table>
    </div>
  );
}
