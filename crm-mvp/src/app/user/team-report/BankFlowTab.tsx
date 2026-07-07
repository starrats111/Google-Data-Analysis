"use client";

/**
 * R-07 组长端 — 银行流水 Tab
 *
 * 核对每个收款方式（收款人+卡号）的实际收款：
 * 平台打款是总打款，组长录入「实际到账日期时间 + 实际总金额」，
 * 系统按到账日期精确匹配当天（当天没有则取最近一天）的组员打款记录预填员工明细（可修改），
 * 同一半月多笔到账（如 6-16、6-18 各一笔）各自预填各自批次，不混算。
 * 手续费 = 员工明细合计 − 实际到账，自动计算。
 * 支持导出正规「账户交易明细清单」（银行流水单版式）+「打款对账明细」。
 */

import { useState, useEffect, useMemo, useCallback } from "react";
import {
  Card, DatePicker, Button, Space, Spin, Empty, Typography, Table, Modal, Form,
  Select, InputNumber, Input, Popconfirm, Statistic, Row, Col, App, Tag, Tooltip,
  Descriptions,
} from "antd";
import {
  PlusOutlined, ReloadOutlined, FileExcelOutlined, DeleteOutlined, EditOutlined,
  ThunderboltOutlined, EyeOutlined,
} from "@ant-design/icons";
import dayjs, { type Dayjs } from "dayjs";
import type { ColumnsType } from "antd/es/table";
import { REPORT_PLATFORM_ORDER } from "@/lib/report-metrics";
import { apportionFee } from "@/lib/bank-flow-fee";

const { Text } = Typography;

interface MethodItem {
  id: string;
  payeeName: string;
  cardNo: string;
  openingBalance: number | null;
}

interface BreakdownItem {
  userId: string;
  username: string;
  displayName: string;
  platform: string;
  account: string;
  amount: number;
}

interface FlowEntry {
  id: string;
  month: string;
  paymentMethodId: string;
  txnAt: string;
  platform: string;
  counterparty: string;
  summary: string;
  amount: number;
  currency: string;
  expectedAmount: number;
  fee: number;
  breakdown: BreakdownItem[];
  remark: string;
}

const fmt = (n: number | null | undefined) =>
  n == null ? "—" : n.toLocaleString("zh-CN", { minimumFractionDigits: 2, maximumFractionDigits: 2 });

export default function BankFlowTab() {
  const { message } = App.useApp();
  const [month, setMonth] = useState<Dayjs>(dayjs());
  const [loading, setLoading] = useState(false);
  const [methods, setMethods] = useState<MethodItem[]>([]);
  const [entries, setEntries] = useState<FlowEntry[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [exporting, setExporting] = useState(false);
  const [prefilling, setPrefilling] = useState(false);

  // 新增/编辑弹窗
  const [modalOpen, setModalOpen] = useState(false);
  const [editing, setEditing] = useState<FlowEntry | null>(null);
  // 只读明细弹窗
  const [viewing, setViewing] = useState<FlowEntry | null>(null);
  const [saving, setSaving] = useState(false);
  const [form] = Form.useForm();
  const [breakdown, setBreakdown] = useState<BreakdownItem[]>([]);

  const monthStr = month.format("YYYY-MM");

  const fetchAll = useCallback(async () => {
    setLoading(true);
    try {
      const flowRes = await fetch(`/api/user/team/report/bank-flow?month=${monthStr}`).then((r) => r.json());
      if (flowRes.code === 0) {
        setMethods(flowRes.data.methods);
        setEntries(flowRes.data.entries);
      } else {
        message.error(flowRes.message || "加载流水失败");
      }
    } catch {
      message.error("网络错误");
    } finally {
      setLoading(false);
      setLoaded(true);
    }
  }, [monthStr, message]);

  useEffect(() => { fetchAll(); }, [fetchAll]);

  const methodById = useMemo(() => new Map(methods.map((m) => [m.id, m])), [methods]);

  const openAdd = () => {
    setEditing(null);
    setBreakdown([]);
    form.resetFields();
    // 默认到账时间：当月取今天，历史月取该月 10 号，实际按银行到账日期改
    const defaultTxn = month.isSame(dayjs(), "month") ? dayjs().hour(10).minute(0) : month.date(10).hour(10).minute(0);
    form.setFieldsValue({ txnAt: defaultTxn, summary: "佣金结算" });
    setModalOpen(true);
  };

  const openEdit = (e: FlowEntry) => {
    setEditing(e);
    setBreakdown(e.breakdown);
    form.setFieldsValue({
      paymentMethodId: e.paymentMethodId,
      platform: e.platform,
      txnAt: dayjs(e.txnAt),
      amount: e.amount,
      counterparty: e.counterparty,
      summary: e.summary,
      remark: e.remark,
    });
    setModalOpen(true);
  };

  /** 按到账日期精确匹配当天（无则最近一天）的组员打款记录，服务端预填 */
  const doPrefill = async () => {
    const { paymentMethodId, platform, txnAt } = form.getFieldsValue(["paymentMethodId", "platform", "txnAt"]) as {
      paymentMethodId?: string; platform?: string; txnAt?: Dayjs | null;
    };
    if (!paymentMethodId || !platform || !txnAt) {
      message.warning("请先选择收款方式、平台和到账日期");
      return;
    }
    setPrefilling(true);
    try {
      const params = new URLSearchParams({
        methodId: paymentMethodId,
        platform,
        date: txnAt.format("YYYY-MM-DD"),
      });
      const res = await fetch(`/api/user/team/report/bank-flow/prefill?${params}`).then((r) => r.json());
      if (res.code !== 0) {
        message.error(res.message || "预填失败");
        return;
      }
      const { items, note } = res.data as { items: BreakdownItem[]; note: string };
      setBreakdown(items.map((it) => ({
        userId: it.userId,
        username: it.username,
        displayName: it.displayName,
        platform: it.platform,
        account: it.account,
        amount: it.amount,
      })));
      if (items.length === 0) message.info(note || "没有匹配的打款记录，可手动添加明细行");
      else message.success(`${note}，共 ${items.length} 条`);
    } catch {
      message.error("网络错误");
    } finally {
      setPrefilling(false);
    }
  };

  const breakdownTotal = useMemo(
    () => Math.round(breakdown.reduce((s, b) => s + (b.amount || 0), 0) * 100) / 100,
    [breakdown],
  );

  // 弹窗内实时分摊：费率 = 总手续费 ÷ 明细合计，个人手续费 = 明细金额 × 费率（尾差调到金额最大者）
  const watchedAmount = Form.useWatch("amount", form);
  const modalFee = useMemo(
    () => Math.round((breakdownTotal - (Number(watchedAmount) || 0)) * 100) / 100,
    [breakdownTotal, watchedAmount],
  );
  const modalFees = useMemo(
    () => apportionFee(breakdown.map((b) => b.amount || 0), modalFee),
    [breakdown, modalFee],
  );

  const handleSave = async () => {
    let values;
    try {
      values = await form.validateFields();
    } catch { return; }
    setSaving(true);
    try {
      const payload = {
        ...(editing ? { id: editing.id } : {}),
        month: monthStr,
        paymentMethodId: values.paymentMethodId,
        platform: values.platform,
        txnAt: values.txnAt.toISOString(),
        amount: values.amount,
        counterparty: values.counterparty || "",
        summary: values.summary || "佣金结算",
        remark: values.remark || "",
        breakdown,
      };
      const res = await fetch("/api/user/team/report/bank-flow", {
        method: editing ? "PUT" : "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      }).then((r) => r.json());
      if (res.code === 0) {
        message.success(res.message || "已保存");
        setModalOpen(false);
        fetchAll();
      } else {
        message.error(res.message || "保存失败");
      }
    } finally {
      setSaving(false);
    }
  };

  const handleDelete = async (id: string) => {
    const res = await fetch("/api/user/team/report/bank-flow", {
      method: "DELETE",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id }),
    }).then((r) => r.json()).catch(() => null);
    if (res?.code === 0) {
      message.success("已删除");
      fetchAll();
    } else {
      message.error(res?.message || "删除失败");
    }
  };

  const saveOpening = async (methodId: string, value: number | null) => {
    const res = await fetch("/api/user/team/report/bank-flow", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ kind: "opening", month: monthStr, paymentMethodId: methodId, value }),
    }).then((r) => r.json()).catch(() => null);
    if (res?.code === 0) {
      message.success(res.message || "已保存");
      fetchAll();
    } else {
      message.error(res?.message || "保存失败");
    }
  };

  const handleExport = async (methodId?: string) => {
    setExporting(true);
    try {
      const url = `/api/user/team/report/bank-flow/export?month=${monthStr}${methodId ? `&methodId=${methodId}` : ""}`;
      const resp = await fetch(url);
      if (!resp.ok) {
        message.error((await resp.text().catch(() => "")) || "导出失败");
        return;
      }
      const blob = await resp.blob();
      const a = document.createElement("a");
      a.href = URL.createObjectURL(blob);
      a.download = `银行流水-${monthStr}.xlsx`;
      a.click();
      URL.revokeObjectURL(a.href);
      message.success("已导出");
    } finally {
      setExporting(false);
    }
  };

  // ── 汇总数字 ──
  const totals = useMemo(() => {
    const amount = entries.reduce((s, e) => s + e.amount, 0);
    const expected = entries.reduce((s, e) => s + e.expectedAmount, 0);
    const fee = entries.reduce((s, e) => s + e.fee, 0);
    return { count: entries.length, amount, expected, fee };
  }, [entries]);

  const columns: ColumnsType<FlowEntry> = [
    {
      title: "收款方式", key: "method", width: 180,
      render: (_, e) => {
        const m = methodById.get(e.paymentMethodId);
        return m ? (
          <Space direction="vertical" size={0}>
            <Text strong>{m.payeeName}</Text>
            <Text type="secondary" style={{ fontSize: 12 }}>{m.cardNo || "未填卡号"}</Text>
          </Space>
        ) : <Text type="secondary">已删除的收款方式</Text>;
      },
    },
    { title: "平台", dataIndex: "platform", width: 70, render: (p: string) => <Tag color="green">{p}</Tag> },
    {
      title: "到账时间", dataIndex: "txnAt", width: 150,
      render: (t: string) => dayjs(t).format("YYYY-MM-DD HH:mm"),
      sorter: (a, b) => dayjs(a.txnAt).unix() - dayjs(b.txnAt).unix(),
      defaultSortOrder: "ascend",
    },
    {
      title: "实际到账(¥)", dataIndex: "amount", width: 130, align: "right",
      render: (v: number) => <Text strong>¥{fmt(v)}</Text>,
    },
    {
      title: <Tooltip title="该笔打款覆盖的员工收款明细合计，点击查看逐人明细">员工明细合计(¥)</Tooltip>,
      dataIndex: "expectedAmount", width: 140, align: "right",
      render: (v: number, e) => (
        <Tooltip title="点击查看逐人明细">
          <Button type="link" size="small" style={{ padding: 0 }} onClick={(ev) => { ev.stopPropagation(); setViewing(e); }}>
            ¥{fmt(v)}{e.breakdown.length > 0 && <Text type="secondary" style={{ fontSize: 12 }}>（{e.breakdown.length}人）</Text>}
          </Button>
        </Tooltip>
      ),
    },
    {
      title: <Tooltip title="手续费 = 员工明细合计 − 实际到账（自动计算）">手续费(¥)</Tooltip>,
      dataIndex: "fee", width: 110, align: "right",
      render: (v: number) => (
        <Text style={{ color: v > 0 ? "#cf1322" : v < 0 ? "#fa8c16" : undefined }} strong={v !== 0}>
          {v > 0 ? `¥${fmt(v)}` : v < 0 ? `-¥${fmt(-v)}` : "¥0.00"}
        </Text>
      ),
    },
    {
      title: "费率", key: "rate", width: 80, align: "right",
      render: (_, e) => (e.expectedAmount > 0 ? `${((e.fee / e.expectedAmount) * 100).toFixed(2)}%` : "—"),
    },
    { title: "摘要", dataIndex: "summary", width: 110, ellipsis: true },
    { title: "备注", dataIndex: "remark", ellipsis: true, render: (v: string) => v || <Text type="secondary">—</Text> },
    {
      title: "操作", key: "op", width: 150, fixed: "right",
      render: (_, e) => (
        <Space size={4}>
          <Button size="small" type="link" icon={<EyeOutlined />} onClick={(ev) => { ev.stopPropagation(); setViewing(e); }}>明细</Button>
          <Button size="small" type="link" icon={<EditOutlined />} onClick={(ev) => { ev.stopPropagation(); openEdit(e); }}>编辑</Button>
          <Popconfirm title="删除这笔打款登记？" onConfirm={() => handleDelete(e.id)}>
            <Button size="small" type="link" danger icon={<DeleteOutlined />} onClick={(ev) => ev.stopPropagation()} />
          </Popconfirm>
        </Space>
      ),
    },
  ];

  const breakdownColumns: ColumnsType<BreakdownItem> = [
    { title: "组员", key: "member", width: 100, render: (_, b) => b.displayName || b.username },
    { title: "平台账号", dataIndex: "account", ellipsis: true },
    {
      title: "金额(¥)", dataIndex: "amount", width: 135, align: "right",
      render: (_, b, idx) => (
        <InputNumber
          size="small"
          value={b.amount}
          min={0}
          precision={2}
          style={{ width: 120 }}
          onChange={(v) => {
            setBreakdown((prev) => prev.map((x, i) => (i === idx ? { ...x, amount: Number(v) || 0 } : x)));
          }}
        />
      ),
    },
    {
      title: <Tooltip title="按费率（总手续费÷明细合计）比例分摊，尾差调整到金额最大者">个人手续费(¥)</Tooltip>,
      key: "fee", width: 110, align: "right",
      render: (_, __, idx) => {
        const f = modalFees[idx] ?? 0;
        return <Text type={f > 0 ? "danger" : "secondary"}>¥{fmt(f)}</Text>;
      },
    },
    {
      title: "净到手(¥)", key: "net", width: 110, align: "right",
      render: (_, b, idx) => <Text strong>¥{fmt(Math.round(((b.amount || 0) - (modalFees[idx] ?? 0)) * 100) / 100)}</Text>,
    },
    {
      title: "", key: "del", width: 40,
      render: (_, __, idx) => (
        <Button
          size="small" type="text" danger icon={<DeleteOutlined />}
          onClick={() => setBreakdown((prev) => prev.filter((_, i) => i !== idx))}
        />
      ),
    },
  ];

  const platformOptions = useMemo(() => {
    const set = new Set<string>(REPORT_PLATFORM_ORDER);
    for (const e of entries) set.add(e.platform);
    return [...set];
  }, [entries]);

  return (
    <div>
      <Space style={{ marginBottom: 16 }} wrap>
        <DatePicker
          picker="month"
          value={month}
          allowClear={false}
          onChange={(v) => v && setMonth(v)}
          disabledDate={(d) => d.isAfter(dayjs(), "month")}
        />
        <Button icon={<ReloadOutlined />} onClick={fetchAll} loading={loading}>刷新</Button>
        <Button type="primary" icon={<PlusOutlined />} onClick={openAdd} disabled={methods.length === 0}>
          登记平台打款
        </Button>
        <Button
          icon={<FileExcelOutlined />}
          onClick={() => handleExport()}
          loading={exporting}
          disabled={methods.length === 0}
          style={{ background: "#217346", borderColor: "#217346", color: "#fff" }}
        >
          导出银行流水
        </Button>
      </Space>

      {loading && !loaded ? (
        <div style={{ textAlign: "center", padding: 60 }}><Spin /></div>
      ) : methods.length === 0 ? (
        <Empty description={<>尚未维护收款方式，请先到「小组设置」添加收款人和卡号</>} />
      ) : (
        <Space direction="vertical" style={{ width: "100%" }} size={16}>
          {/* 汇总 */}
          <Row gutter={[12, 12]}>
            {[
              { label: "本月到账笔数", value: String(totals.count), color: "#595959" },
              { label: "实际到账合计(¥)", value: `¥${fmt(totals.amount)}`, color: "#389e0d" },
              { label: "员工明细合计(¥)", value: `¥${fmt(totals.expected)}`, color: "#1677ff" },
              { label: "手续费合计(¥)", value: `¥${fmt(totals.fee)}`, color: totals.fee > 0 ? "#cf1322" : "#595959" },
            ].map(({ label, value, color }) => (
              <Col key={label} xs={12} sm={6}>
                <Card size="small" styles={{ body: { padding: "10px 14px" } }}>
                  <Statistic title={<Text style={{ fontSize: 12 }}>{label}</Text>} value={value} valueStyle={{ fontSize: 16, color }} />
                </Card>
              </Col>
            ))}
          </Row>

          {/* 收款方式卡片（期初余额 + 单卡导出） */}
          <Row gutter={[12, 12]}>
            {methods.map((m) => {
              const cardEntries = entries.filter((e) => e.paymentMethodId === m.id);
              const inSum = cardEntries.reduce((s, e) => s + e.amount, 0);
              return (
                <Col key={m.id} xs={24} sm={12} md={8} lg={6}>
                  <Card
                    size="small"
                    title={<Space><Text strong>{m.payeeName}</Text><Text type="secondary" style={{ fontSize: 12 }}>{m.cardNo || "未填卡号"}</Text></Space>}
                    extra={
                      <Tooltip title="导出该卡流水单">
                        <Button size="small" type="text" icon={<FileExcelOutlined />} onClick={() => handleExport(m.id)} />
                      </Tooltip>
                    }
                  >
                    <Space direction="vertical" size={4} style={{ width: "100%" }}>
                      <Space>
                        <Text type="secondary" style={{ fontSize: 12 }}>期初余额</Text>
                        <InputNumber
                          size="small"
                          placeholder="0.00"
                          precision={2}
                          style={{ width: 130 }}
                          value={m.openingBalance ?? undefined}
                          onBlur={(ev) => {
                            const raw = (ev.target as HTMLInputElement).value.replace(/,/g, "");
                            const v = raw === "" ? null : Number(raw);
                            if (v !== (m.openingBalance ?? null)) saveOpening(m.id, v);
                          }}
                        />
                      </Space>
                      <Text style={{ fontSize: 13 }}>
                        本月入账 <Text strong>{cardEntries.length}</Text> 笔，合计 <Text strong style={{ color: "#389e0d" }}>¥{fmt(inSum)}</Text>
                      </Text>
                    </Space>
                  </Card>
                </Col>
              );
            })}
          </Row>

          {/* 流水明细表 */}
          <Card size="small" title={`${parseInt(monthStr.slice(5), 10)}月打款登记`}>
            <Table<FlowEntry>
              columns={columns}
              dataSource={entries}
              rowKey="id"
              size="small"
              pagination={false}
              scroll={{ x: "max-content" }}
              bordered
              onRow={(e) => ({ onClick: () => setViewing(e), style: { cursor: "pointer" } })}
              locale={{ emptyText: <Empty description="本月尚未登记打款，点击「登记平台打款」开始" /> }}
            />
            <div style={{ marginTop: 12 }}>
              <Text type="secondary" style={{ fontSize: 12 }}>
                * 到账时间请填银行实际入账日期；员工明细按「该收款方式 × 该平台 × 到账日当天」的组员打款记录（实际打款日 paid_date）自动预填，
                账号归属与月度报表一致（按该月收款人/卡号快照区分，如龚建成、张文俊各自名下账号分开；当天没有记录时取最近一天的那批，按打款日汇率折成 CNY），
                同一半月多笔到账各自预填各自批次，可逐人修改；手续费 = 员工明细合计 − 实际到账，自动计算；
                个人手续费 = 明细金额 × 费率（费率 = 手续费 ÷ 明细合计），尾差调整到金额最大者，净到手 = 明细金额 − 个人手续费。
                导出的「账户交易明细清单」按期初余额逐笔滚动余额，可直接作为对账材料。
              </Text>
            </div>
          </Card>
        </Space>
      )}

      {/* 只读明细弹窗 */}
      <Modal
        title="打款明细"
        open={!!viewing}
        onCancel={() => setViewing(null)}
        width={640}
        footer={[
          <Button key="edit" icon={<EditOutlined />} onClick={() => { if (viewing) { const e = viewing; setViewing(null); openEdit(e); } }}>
            去编辑
          </Button>,
          <Button key="close" type="primary" onClick={() => setViewing(null)}>关闭</Button>,
        ]}
      >
        {viewing && (() => {
          const m = methodById.get(viewing.paymentMethodId);
          const rate = viewing.expectedAmount > 0 ? `${((viewing.fee / viewing.expectedAmount) * 100).toFixed(2)}%` : "—";
          const viewFees = apportionFee(viewing.breakdown.map((b) => b.amount || 0), viewing.fee);
          return (
            <Space direction="vertical" size={12} style={{ width: "100%" }}>
              <Descriptions size="small" bordered column={2} styles={{ label: { width: 110 } }}>
                <Descriptions.Item label="收款方式" span={2}>
                  <Text strong>{m?.payeeName || "已删除的收款方式"}</Text>
                  {m?.cardNo && <Text type="secondary" style={{ marginLeft: 8 }}>{m.cardNo}</Text>}
                </Descriptions.Item>
                <Descriptions.Item label="平台"><Tag color="green">{viewing.platform}</Tag></Descriptions.Item>
                <Descriptions.Item label="到账时间">{dayjs(viewing.txnAt).format("YYYY-MM-DD HH:mm")}</Descriptions.Item>
                <Descriptions.Item label="实际到账"><Text strong>¥{fmt(viewing.amount)}</Text></Descriptions.Item>
                <Descriptions.Item label="员工明细合计">¥{fmt(viewing.expectedAmount)}</Descriptions.Item>
                <Descriptions.Item label="手续费">
                  <Text strong style={{ color: viewing.fee > 0 ? "#cf1322" : viewing.fee < 0 ? "#fa8c16" : undefined }}>
                    {viewing.fee >= 0 ? `¥${fmt(viewing.fee)}` : `-¥${fmt(-viewing.fee)}`}
                  </Text>
                  <Text type="secondary" style={{ marginLeft: 8 }}>费率 {rate}</Text>
                </Descriptions.Item>
                <Descriptions.Item label="摘要">{viewing.summary || "—"}</Descriptions.Item>
                {viewing.remark && <Descriptions.Item label="备注" span={2}>{viewing.remark}</Descriptions.Item>}
              </Descriptions>
              <Table<BreakdownItem>
                columns={[
                  { title: "组员", key: "member", width: 100, render: (_, b) => b.displayName || b.username },
                  { title: "平台账号", dataIndex: "account", ellipsis: true },
                  { title: "金额(¥)", dataIndex: "amount", width: 110, align: "right", render: (v: number) => `¥${fmt(v)}` },
                  {
                    title: <Tooltip title="按费率（总手续费÷明细合计）比例分摊，尾差调整到金额最大者">个人手续费(¥)</Tooltip>,
                    key: "fee", width: 110, align: "right",
                    render: (_, __, idx) => {
                      const f = viewFees[idx] ?? 0;
                      return <Text type={f > 0 ? "danger" : "secondary"}>{fmt(f)}</Text>;
                    },
                  },
                  {
                    title: "净到手(¥)", key: "net", width: 110, align: "right",
                    render: (_, b, idx) => <Text strong>¥{fmt(Math.round(((b.amount || 0) - (viewFees[idx] ?? 0)) * 100) / 100)}</Text>,
                  },
                ]}
                dataSource={viewing.breakdown}
                rowKey={(b, i) => `${b.userId}-${b.account}-${i}`}
                size="small"
                pagination={false}
                bordered
                locale={{ emptyText: "该笔打款没有员工明细" }}
                summary={() => (
                  <Table.Summary.Row style={{ background: "#fafafa", fontWeight: 600 }}>
                    <Table.Summary.Cell index={0} colSpan={2}>合计（{viewing.breakdown.length} 人）</Table.Summary.Cell>
                    <Table.Summary.Cell index={1} align="right">¥{fmt(viewing.expectedAmount)}</Table.Summary.Cell>
                    <Table.Summary.Cell index={2} align="right">¥{fmt(viewing.fee)}</Table.Summary.Cell>
                    <Table.Summary.Cell index={3} align="right">¥{fmt(Math.round((viewing.expectedAmount - viewing.fee) * 100) / 100)}</Table.Summary.Cell>
                  </Table.Summary.Row>
                )}
              />
            </Space>
          );
        })()}
      </Modal>

      {/* 新增/编辑弹窗 */}
      <Modal
        title={editing ? "编辑打款登记" : "登记平台打款"}
        open={modalOpen}
        onCancel={() => setModalOpen(false)}
        onOk={handleSave}
        confirmLoading={saving}
        width={760}
        destroyOnHidden
      >
        <Form form={form} layout="vertical" style={{ marginTop: 8 }}>
          <Row gutter={12}>
            <Col span={9}>
              <Form.Item name="paymentMethodId" label="收款方式" rules={[{ required: true, message: "请选择收款方式" }]}>
                <Select
                  placeholder="选择收款人/卡"
                  options={methods.map((m) => ({ value: m.id, label: `${m.payeeName}（${m.cardNo || "未填卡号"}）` }))}
                  showSearch
                  optionFilterProp="label"
                />
              </Form.Item>
            </Col>
            <Col span={5}>
              <Form.Item name="platform" label="打款平台" rules={[{ required: true, message: "请选择平台" }]}>
                <Select placeholder="平台" options={platformOptions.map((p) => ({ value: p, label: p }))} />
              </Form.Item>
            </Col>
            <Col span={10}>
              <Form.Item name="txnAt" label="到账日期时间" rules={[{ required: true, message: "请选择到账时间" }]}>
                <DatePicker showTime={{ format: "HH:mm" }} format="YYYY-MM-DD HH:mm" style={{ width: "100%" }} />
              </Form.Item>
            </Col>
          </Row>
          <Row gutter={12}>
            <Col span={9}>
              <Form.Item name="amount" label="实际总打款金额(¥)" rules={[{ required: true, message: "请输入实际到账总金额" }]}>
                <InputNumber min={0} precision={2} style={{ width: "100%" }} placeholder="银行实际入账金额" />
              </Form.Item>
            </Col>
            <Col span={8}>
              <Form.Item name="counterparty" label="对方户名（打款主体，选填）">
                <Input placeholder="默认平台代码" maxLength={64} />
              </Form.Item>
            </Col>
            <Col span={7}>
              <Form.Item name="summary" label="交易摘要">
                <Input maxLength={64} />
              </Form.Item>
            </Col>
          </Row>
          <Form.Item name="remark" label="备注（选填）">
            <Input maxLength={200} placeholder="如：LH 6月上半月佣金结算" />
          </Form.Item>

          <Card
            size="small"
            title="员工收款明细"
            extra={
              <Button size="small" icon={<ThunderboltOutlined />} onClick={doPrefill} loading={prefilling}>
                按到账日打款记录预填
              </Button>
            }
          >
            <Table<BreakdownItem>
              columns={breakdownColumns}
              dataSource={breakdown}
              rowKey={(b, i) => `${b.userId}-${b.account}-${i}`}
              size="small"
              pagination={false}
              locale={{ emptyText: "暂无明细，点右上角自动预填或直接保存" }}
            />
            <div style={{ marginTop: 8, textAlign: "right" }}>
              <Space size={16}>
                <Text>明细合计：<Text strong>¥{fmt(breakdownTotal)}</Text></Text>
                <Text>
                  手续费：
                  <Text strong style={{ color: modalFee > 0 ? "#cf1322" : modalFee < 0 ? "#fa8c16" : undefined }}>
                    {modalFee >= 0 ? `¥${fmt(modalFee)}` : `-¥${fmt(-modalFee)}`}
                  </Text>
                </Text>
                <Text type="secondary">
                  费率 {breakdownTotal > 0 ? `${((modalFee / breakdownTotal) * 100).toFixed(2)}%` : "—"}
                </Text>
              </Space>
            </div>
          </Card>
        </Form>
      </Modal>
    </div>
  );
}
