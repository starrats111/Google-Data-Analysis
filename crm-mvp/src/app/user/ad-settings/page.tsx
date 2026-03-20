"use client";

import { useState, useEffect } from "react";
import { Card, Form, Select, Switch, InputNumber, Button, Typography, App, Tooltip } from "antd";
import { DollarOutlined, SaveOutlined, InfoCircleOutlined } from "@ant-design/icons";
import { BIDDING_STRATEGIES } from "@/lib/constants";

const { Title } = Typography;

interface AdSettings {
  bidding_strategy: string; ecpc_enabled: number; max_cpc: number;
  daily_budget: number; network_search: number; network_partners: number; network_display: number;
}

export default function AdSettingsPage() {
  const { message } = App.useApp();
  const [adSettings, setAdSettings] = useState<AdSettings | null>(null);
  const [form] = Form.useForm();

  useEffect(() => {
    fetch("/api/user/ad-settings")
      .then((r) => r.json())
      .then((res) => {
        if (res.code === 0) {
          setAdSettings(res.data);
          form.setFieldsValue({
            ...res.data,
            max_cpc: Number(res.data.max_cpc),
            daily_budget: Number(res.data.daily_budget),
          });
        }
      });
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const handleSave = async () => {
    const values = form.getFieldsValue();
    const res = await fetch("/api/user/ad-settings", {
      method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(values),
    }).then((r) => r.json());
    if (res.code === 0) message.success("广告设置已保存");
    else message.error(res.message);
  };

  return (
    <div>
      <Title level={4} style={{ marginBottom: 16 }}><DollarOutlined /> 广告投放设置</Title>
      <Card>
        {adSettings && (
          <Form form={form} layout="vertical" style={{ maxWidth: 600 }}>
            <Form.Item name="bidding_strategy" label="出价策略">
              <Select options={BIDDING_STRATEGIES.map((b) => ({ value: b.value, label: b.label }))} />
            </Form.Item>
            <Form.Item name="ecpc_enabled" label="启用 eCPC" valuePropName="checked"
              getValueFromEvent={(checked: boolean) => checked ? 1 : 0}
              getValueProps={(value: number) => ({ checked: value === 1 })}>
              <Switch />
            </Form.Item>
            <Form.Item name="max_cpc" label="最高 CPC ($)">
              <InputNumber prefix="$" style={{ width: "100%" }} min={0.01} step={0.1} />
            </Form.Item>
            <Form.Item name="daily_budget" label="日预算 ($)">
              <InputNumber prefix="$" style={{ width: "100%" }} min={0.5} step={0.5} />
            </Form.Item>
            <Form.Item name="network_search" label="搜索网络" valuePropName="checked"
              getValueFromEvent={(checked: boolean) => checked ? 1 : 0}
              getValueProps={(value: number) => ({ checked: value === 1 })}>
              <Switch />
            </Form.Item>
            <Form.Item name="network_partners" label="合作伙伴网络" valuePropName="checked"
              getValueFromEvent={(checked: boolean) => checked ? 1 : 0}
              getValueProps={(value: number) => ({ checked: value === 1 })}>
              <Switch />
            </Form.Item>
            <Form.Item name="network_display" label="展示网络" valuePropName="checked"
              getValueFromEvent={(checked: boolean) => checked ? 1 : 0}
              getValueProps={(value: number) => ({ checked: value === 1 })}>
              <Switch />
            </Form.Item>
            <Form.Item
              name="eu_political_ad"
              label={
                <span>
                  包含 EU 政治广告{" "}
                  <Tooltip title="如果您的广告涉及欧盟政治内容，需要开启此选项。大多数商家广告应关闭此选项。">
                    <InfoCircleOutlined style={{ color: "#999" }} />
                  </Tooltip>
                </span>
              }
              valuePropName="checked"
              getValueFromEvent={(checked: boolean) => checked ? 1 : 0}
              getValueProps={(value: number) => ({ checked: value === 1 })}
            >
              <Switch checkedChildren="含EU政治广告" unCheckedChildren="不含" />
            </Form.Item>
            <Form.Item>
              <Button type="primary" icon={<SaveOutlined />} onClick={handleSave}>保存设置</Button>
            </Form.Item>
          </Form>
        )}
      </Card>
    </div>
  );
}
