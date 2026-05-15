/**
 * D-004 共享商家领取 Modal
 *
 * 功能（保留 user/merchants/page.tsx 原内联 Modal 全部能力）：
 *  - 政策受限（restricted）警告
 *  - 拒付率告警 ≥50% 时二次确认
 *  - 目标国家选择（带商家 supported_regions ⭐ 优先排序，与 batch ATC 国家选择一致）
 *  - 关联节日（可选）
 *  - 多账号时强制选择 MCC + platform_connection（单账号自动选）
 *  - 提交时调 POST /api/user/merchants 完成领取 + 触发自动跳转到广告预览页
 *
 * 设计文档：设计方案.md §四·D-004 §3 F-10
 */
"use client";
import { useEffect, useState } from "react";
import { App, Form, Input, Modal, Select, Space, Tag, Typography, Tooltip } from "antd";
import { WarningOutlined } from "@ant-design/icons";
import { useRouter } from "next/navigation";
import { ALL_COUNTRIES } from "@/lib/constants";
import { mutateApi } from "@/lib/swr";

const { Text } = Typography;

// 政策类别代码 → 中文（与 user/merchants/page.tsx 一致）
const POLICY_CN: Record<string, string> = {
  alcohol: "酒精类", gambling: "赌博类", healthcare: "医疗保健", financial: "金融服务",
  adult: "成人内容", weapons: "武器/刀具", cannabis: "大麻类", tobacco: "烟草类",
};

export interface ClaimMerchant {
  id: string;
  merchant_name: string;
  platform: string;
  merchant_id: string;
  policy_status?: string;
  policy_category_code?: string;
  supported_regions?: unknown[] | null;
}

interface MerchantClaimModalProps {
  open: boolean;
  merchant: ClaimMerchant | null;
  /** 当前用户该商家近期拒付率（>=50 时弹二次确认）；不传时跳过拒付检查 */
  chargebackRate?: number;
  onCancel: () => void;
  /** 领取成功回调：默认会跳转到广告预览页（如父组件需要自定义跳转可覆盖） */
  onClaimed?: (campaignId: string | null) => void;
  /** SWR 缓存刷新匹配（默认 /api/user/merchants） */
  invalidateApiPattern?: RegExp;
}

export default function MerchantClaimModal({
  open,
  merchant,
  chargebackRate,
  onCancel,
  onClaimed,
  invalidateApiPattern,
}: MerchantClaimModalProps) {
  const { message, modal } = App.useApp();
  const router = useRouter();
  const [form] = Form.useForm();
  const [platformConns, setPlatformConns] = useState<{ id: string; platform: string; account_name: string }[]>([]);
  const [mccAccounts, setMccAccounts] = useState<{ id: string; mcc_id: string; mcc_name: string }[]>([]);
  const [confirmedHighChargeback, setConfirmedHighChargeback] = useState(false);

  useEffect(() => {
    if (!open || !merchant) return;
    form.resetFields();
    setConfirmedHighChargeback(false);
    (async () => {
      try {
        const [platRes, mccRes] = await Promise.all([
          fetch("/api/user/settings/platforms").then((r) => r.json()),
          fetch("/api/user/settings/mcc").then((r) => r.json()),
        ]);
        if (platRes.code === 0) {
          const conns = (platRes.data || []).filter((c: { platform: string }) => c.platform === merchant.platform);
          setPlatformConns(conns);
          if (conns.length === 1) form.setFieldValue("platform_connection_id", conns[0].id);
        }
        if (mccRes.code === 0) {
          const mccs = (mccRes.data || []).filter((a: { is_active?: number }) => a.is_active);
          setMccAccounts(mccs);
          if (mccs.length === 1) form.setFieldValue("mcc_account_id", mccs[0].id);
        }
      } catch {
        /* ignore */
      }
    })();
  }, [open, merchant, form]);

  // 高拒付率二次确认（与 user/merchants/page.tsx doClaim 逻辑一致）
  useEffect(() => {
    if (!open || !merchant) return;
    if (confirmedHighChargeback) return;
    if (typeof chargebackRate !== "number" || chargebackRate < 50) return;

    modal.confirm({
      title: "该商家近期拒付率较高",
      content: (
        <div>
          <div>商家：<b>{merchant.merchant_name}</b>（{merchant.platform} / {merchant.merchant_id}）</div>
          <div>近期全员拒付率：<b style={{ color: "#ff4d4f" }}>{chargebackRate.toFixed(2)}%</b></div>
          <div style={{ marginTop: 8, color: "#999" }}>
            拒付商家数据来自全员已结算交易聚合，时间窗默认从 2025-11-01 至今。
          </div>
        </div>
      ),
      okText: "继续领取",
      okButtonProps: { danger: true },
      cancelText: "取消",
      onOk: () => setConfirmedHighChargeback(true),
      onCancel: () => onCancel(),
    });
  }, [open, merchant, chargebackRate, confirmedHighChargeback, modal, onCancel]);

  const submit = async () => {
    if (!merchant) return;
    const v = await form.validateFields();
    const r = await mutateApi(
      "/api/user/merchants",
      { method: "POST", body: { merchant_id: merchant.id, ...v } },
      [invalidateApiPattern ?? /\/api\/user\/merchants/],
    );
    if (r.code === 0) {
      message.success("领取成功！正在跳转到广告预览...");
      const cid = (r.data as { campaign_id?: string | number } | null)?.campaign_id;
      const campaignId = cid ? String(cid) : null;
      if (onClaimed) {
        onClaimed(campaignId);
      } else if (campaignId) {
        setTimeout(() => router.push(`/user/ad-preview/${campaignId}`), 800);
      }
    } else {
      message.error(r.message);
    }
  };

  const supportedRegionCodes: string[] = (() => {
    const regions = merchant?.supported_regions;
    if (!regions || !Array.isArray(regions)) return [];
    return regions
      .map((r) => (typeof r === "string" ? r : ((r as { code?: string })?.code ?? String(r))))
      .map((c) => String(c).toUpperCase());
  })();
  const supportedSet = new Set(supportedRegionCodes);
  const starOptions = ALL_COUNTRIES.filter((c) => supportedSet.has(c.code)).map((c) => ({
    value: c.code,
    label: `⭐ ${c.flag} ${c.code} - ${c.name}`,
  }));
  const restOptions = ALL_COUNTRIES.filter((c) => !supportedSet.has(c.code)).map((c) => ({
    value: c.code,
    label: `${c.flag} ${c.code} - ${c.name}`,
  }));
  const extraOptions: Array<{ value: string; label: string }> = [];
  for (const code of supportedRegionCodes) {
    if (!ALL_COUNTRIES.find((c) => c.code === code)) {
      extraOptions.push({ value: code, label: `⭐ ${code} - 支持地区` });
    }
  }
  const countryOptions = [...starOptions, ...extraOptions, ...restOptions];

  return (
    <Modal
      title={`领取商家: ${merchant?.merchant_name ?? ""}`}
      open={open}
      onOk={submit}
      onCancel={onCancel}
      destroyOnClose
    >
      {merchant?.policy_status === "restricted" && (
        <div style={{ marginBottom: 16, padding: "8px 12px", background: "#fff7e6", border: "1px solid #ffd591", borderRadius: 6 }}>
          <WarningOutlined style={{ color: "#fa8c16", marginRight: 6 }} />
          <Text type="warning" style={{ fontSize: 13 }}>
            该商家属于受限类别
            {merchant.policy_category_code ? `（${POLICY_CN[merchant.policy_category_code] || merchant.policy_category_code}）` : ""}
            ，投放将受限。
          </Text>
        </div>
      )}
      <Form form={form} layout="vertical">
        {mccAccounts.length > 1 && (
          <Form.Item name="mcc_account_id" label="MCC 账户" rules={[{ required: true, message: "请选择 MCC 账户" }]}>
            <Select
              placeholder="选择 MCC 账户"
              options={mccAccounts.map((a) => ({ value: a.id, label: `${a.mcc_name || a.mcc_id} (${a.mcc_id})` }))}
            />
          </Form.Item>
        )}
        <Form.Item name="target_country" label="目标国家" rules={[{ required: true, message: "请选择目标国家" }]}>
          <Select
            showSearch
            placeholder="选择或输入国家代码（如 US / GB / AU）"
            optionFilterProp="label"
            options={countryOptions}
          />
        </Form.Item>
        {supportedRegionCodes.length > 0 && (
          <div style={{ marginBottom: 16 }}>
            <Text type="secondary">支持地区（点击快速选择）：</Text>
            <Space wrap style={{ marginTop: 4 }}>
              {supportedRegionCodes.map((c) => (
                <Tooltip key={c} title={`快速填入 ${c}`}>
                  <Tag
                    color="blue"
                    style={{ cursor: "pointer" }}
                    onClick={() => form.setFieldValue("target_country", c)}
                  >
                    {c}
                  </Tag>
                </Tooltip>
              ))}
            </Space>
          </div>
        )}
        {platformConns.length > 1 && (
          <Form.Item name="platform_connection_id" label="使用账号" rules={[{ required: true, message: "请选择使用的平台账号" }]}>
            <Select
              placeholder="选择平台账号"
              options={platformConns.map((c) => ({ value: c.id, label: `${c.account_name || c.platform} (${c.platform})` }))}
            />
          </Form.Item>
        )}
        <Form.Item name="holiday_name" label="关联节日（可选）">
          <Input placeholder="输入节日名称" />
        </Form.Item>
      </Form>
    </Modal>
  );
}
