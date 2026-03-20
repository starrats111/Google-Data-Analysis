"use client";

import { useState } from "react";
import { Modal, InputNumber, Typography, Flex, App } from "antd";
import { DollarOutlined } from "@ant-design/icons";

const { Text } = Typography;

interface CampaignInfo {
  id: string;
  campaign_name: string;
  daily_budget: number;
  max_cpc: number | null;
  cpc: number;
}

interface EditCampaignModalProps {
  open: boolean;
  campaign: CampaignInfo | null;
  field: "budget" | "max_cpc";
  mccAccountId: string;
  onSuccess: () => void;
  onCancel: () => void;
}

export default function EditCampaignModal({
  open, campaign, field, mccAccountId, onSuccess, onCancel,
}: EditCampaignModalProps) {
  const { message } = App.useApp();
  const [value, setValue] = useState<number | null>(null);
  const [loading, setLoading] = useState(false);

  const isBudget = field === "budget";
  const title = isBudget ? "修改预算" : "修改 CPC";
  const currentValue = isBudget
    ? campaign?.daily_budget ?? 0
    : campaign?.max_cpc ?? campaign?.cpc ?? 0;

  const handleOk = async () => {
    if (value === null || value === undefined) {
      return message.warning("请输入新的值");
    }
    if (value < 0) {
      return message.warning("值不能为负数");
    }
    if (!campaign) return;

    setLoading(true);
    try {
      const res = await fetch("/api/user/data-center/update-campaign", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          campaign_id: campaign.id,
          field,
          value,
          mcc_account_id: mccAccountId,
        }),
      }).then((r) => r.json());

      if (res.code === 0) {
        message.success(res.data?.message || "修改成功");
        setValue(null);
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
      {campaign && (
        <div style={{ padding: "12px 0" }}>
          <div style={{ marginBottom: 16 }}>
            <Text type="secondary">广告系列：</Text>
            <Text strong>{campaign.campaign_name}</Text>
          </div>

          <div style={{ marginBottom: 16 }}>
            <Text type="secondary">当前{isBudget ? "预算" : "CPC"}：</Text>
            <Text strong style={{ fontSize: 16 }}>
              ${currentValue.toFixed(isBudget ? 2 : 4)}
            </Text>
          </div>

          <Flex vertical style={{ width: "100%" }}>
            <Text>新的{isBudget ? "预算" : "CPC"}：</Text>
            <InputNumber
              prefix={<DollarOutlined />}
              value={value}
              onChange={(v) => setValue(v)}
              min={0}
              step={isBudget ? 0.5 : 0.01}
              precision={isBudget ? 2 : 4}
              style={{ width: "100%" }}
              size="large"
              placeholder={`输入新的${isBudget ? "预算" : "CPC"}金额`}
              autoFocus
            />
          </Flex>

          {value !== null && value !== currentValue && (
            <div style={{ marginTop: 12, padding: "8px 12px", background: "#f6f8fa", borderRadius: 6 }}>
              <Text type="secondary" style={{ fontSize: 12 }}>
                变更：${currentValue.toFixed(isBudget ? 2 : 4)} → ${value.toFixed(isBudget ? 2 : 4)}
                {" "}
                ({value > currentValue ? "+" : ""}{((value - currentValue) / currentValue * 100).toFixed(1)}%)
              </Text>
            </div>
          )}
        </div>
      )}
    </Modal>
  );
}
