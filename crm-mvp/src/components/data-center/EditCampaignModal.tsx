"use client";

import { useState } from "react";
import { Modal, InputNumber, Input, Typography, Flex, App, Alert } from "antd";
import { DollarOutlined } from "@ant-design/icons";

const { Text } = Typography;

interface CampaignInfo {
  id: string;
  campaign_name: string;
  /** D-266 批一：这两个值后端已折美元 */
  daily_budget: number;
  max_cpc: number | null;
  /** 非美元 MCC 标注：账户币种 + 原值 */
  mcc_currency?: string;
  daily_budget_account?: number;
  max_cpc_account?: number | null;
  // 刻意不含平均 CPC（cost/clicks）：这里编辑的是「最高出价」，
  // 两者口径不同，D-217 前曾用平均 CPC 顶替未设置的出价当「当前值」显示。
}

interface EditCampaignModalProps {
  open: boolean;
  campaign: CampaignInfo | null;
  field: "budget" | "max_cpc" | "name";
  mccAccountId: string;
  onSuccess: () => void;
  onCancel: () => void;
}

/** 系列名 6 段规则：序号-平台-商家-国家-月日-MID。与后端 parseCampaignNameFull 同口径的前置提示。 */
const NAME_RE = /^\d+-[A-Za-z]+\d*-.+-[A-Za-z]{2}-\d{4}-\d+$/;

export default function EditCampaignModal({
  open, campaign, field, mccAccountId, onSuccess, onCancel,
}: EditCampaignModalProps) {
  const { message } = App.useApp();
  const [value, setValue] = useState<number | null>(null);
  // null = 用户还没动过输入框 → 显示当前名（改名多半只动其中一段，预填省事）。
  // 用派生值而非 useEffect 预填：Modal 是常驻组件，effect 里 setState 会级联渲染。
  const [nameDraft, setNameDraft] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const isBudget = field === "budget";
  const isName = field === "name";
  const fieldLabel = isName ? "广告系列名称" : isBudget ? "预算" : "最高出价";
  const title = `修改${fieldLabel}`;
  const nameValue = nameDraft ?? campaign?.campaign_name ?? "";
  const decimals = isBudget ? 2 : 4;
  // null = 尚未设置。线上 14,608 个在跑系列里有 11,928 个 max_cpc_limit 为空，
  // 与其拿平均 CPC 充当「当前出价」，不如如实显示未设置。
  const currentValue = isBudget
    ? campaign?.daily_budget ?? 0
    : campaign?.max_cpc ?? null;
  // D-266 批一：非美元 MCC 输入的是美元意图值，后端按当日汇率换算成账户币种下发
  const nonUsdCurrency = campaign?.mcc_currency && campaign.mcc_currency !== "USD" ? campaign.mcc_currency : null;
  const currentAccountValue = isBudget ? campaign?.daily_budget_account : campaign?.max_cpc_account;

  const handleOk = async () => {
    if (!campaign) return;

    if (isName) {
      const next = nameValue.trim();
      if (!next) return message.warning("请输入新的广告系列名称");
      if (next === (campaign.campaign_name || "")) return message.warning("新名称与当前名称相同");
      if (!NAME_RE.test(next)) {
        return message.warning("名称格式不合规：序号-平台-商家-国家-月日-MID");
      }
    } else {
      if (value === null || value === undefined) {
        return message.warning("请输入新的值");
      }
      if (value < 0) {
        return message.warning("值不能为负数");
      }
    }

    setLoading(true);
    try {
      const res = await fetch("/api/user/data-center/update-campaign", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          campaign_id: campaign.id,
          field,
          value: isName ? nameValue.trim() : value,
          mcc_account_id: mccAccountId,
        }),
      }).then((r) => r.json());

      if (res.code === 0) {
        // 改名会连带重排归属/迁移链接键，后端把结果写在 message 里，多给几秒
        message.success(res.data?.message || "修改成功", isName ? 6 : undefined);
        setValue(null);
        setNameDraft(null);
        onSuccess();
      } else {
        message.error(res.message || "修改失败");
      }
    } catch {
      message.error("请求失败");
    }
    setLoading(false);
  };

  const handleCancel = () => {
    setValue(null);
    setNameDraft(null);
    onCancel();
  };

  return (
    <Modal
      title={title}
      open={open}
      onOk={handleOk}
      onCancel={handleCancel}
      confirmLoading={loading}
      okText="确认修改"
      cancelText="取消"
      width={400}
      destroyOnHidden
    >
      {campaign && isName && (
        <div style={{ padding: "12px 0" }}>
          <Alert
            type="warning"
            showIcon
            style={{ marginBottom: 16 }}
            message="改名会同时改变归属"
            description="名称里的平台段带账号位次（如 MUI2 = 该平台第 2 个联盟账号）。保存后会先写回 Google Ads，成功后按新名重排该系列的联盟归属并迁移链接键。"
          />

          <div style={{ marginBottom: 16 }}>
            <Text type="secondary">当前名称：</Text>
            <Text strong>{campaign.campaign_name}</Text>
          </div>

          <Flex vertical style={{ width: "100%" }}>
            <Text>新的名称：</Text>
            <Input
              value={nameValue}
              onChange={(e) => setNameDraft(e.target.value)}
              style={{ width: "100%" }}
              size="large"
              placeholder="序号-平台-商家-国家-月日-MID"
              autoFocus
              status={nameValue.trim() && !NAME_RE.test(nameValue.trim()) ? "error" : undefined}
            />
            <Text type="secondary" style={{ fontSize: 12, marginTop: 6 }}>
              格式：序号-平台-商家-国家-月日-MID，例 1347-MUI2-VSL3-US-0821-8005543
            </Text>
          </Flex>
        </div>
      )}

      {campaign && !isName && (
        <div style={{ padding: "12px 0" }}>
          <div style={{ marginBottom: 16 }}>
            <Text type="secondary">广告系列：</Text>
            <Text strong>{campaign.campaign_name}</Text>
          </div>

          <div style={{ marginBottom: 16 }}>
            <Text type="secondary">当前{fieldLabel}：</Text>
            {currentValue === null ? (
              <Text type="secondary" style={{ fontSize: 16 }}>未设置</Text>
            ) : (
              <Text strong style={{ fontSize: 16 }}>${currentValue.toFixed(decimals)}</Text>
            )}
            {nonUsdCurrency && currentAccountValue != null && (
              <Text type="secondary" style={{ fontSize: 12, marginLeft: 8 }}>
                （账户币种 {Number(currentAccountValue).toFixed(decimals)} {nonUsdCurrency}）
              </Text>
            )}
          </div>

          {nonUsdCurrency && (
            <div style={{ marginBottom: 12, padding: "6px 10px", background: "#fffbe6", border: "1px solid #ffe58f", borderRadius: 6 }}>
              <Text style={{ fontSize: 12 }}>
                该账户币种为 {nonUsdCurrency}：请输入<Text strong>美元</Text>金额，系统将按当日汇率换算成 {nonUsdCurrency} 下发到 Google。
              </Text>
            </div>
          )}

          <Flex vertical style={{ width: "100%" }}>
            <Text>新的{fieldLabel}：</Text>
            <InputNumber
              prefix={<DollarOutlined />}
              value={value}
              onChange={(v) => setValue(v)}
              min={0}
              step={isBudget ? 0.5 : 0.01}
              precision={decimals}
              style={{ width: "100%" }}
              size="large"
              placeholder={`输入新的${fieldLabel}金额`}
              autoFocus
            />
          </Flex>

          {value !== null && currentValue !== null && value !== currentValue && (
            <div style={{ marginTop: 12, padding: "8px 12px", background: "#f6f8fa", borderRadius: 6 }}>
              <Text type="secondary" style={{ fontSize: 12 }}>
                变更：${currentValue.toFixed(decimals)} → ${value.toFixed(decimals)}
                {currentValue > 0 && (
                  <> ({value > currentValue ? "+" : ""}{((value - currentValue) / currentValue * 100).toFixed(1)}%)</>
                )}
              </Text>
            </div>
          )}
        </div>
      )}
    </Modal>
  );
}
