"use client";

/**
 * D-275.1 个人版银行流水（yz 组自管收款模式）
 *
 * 复用组长版 BankFlowTab 整套界面；接口按登录人角色自动切个人口径
 * （只看自己自填的银行卡、只预填自己的打款记录、只导自己的流水单）。
 * 组长清单组（收款方式由组长统一维护）的组员打开本页只显示提示，
 * 不开放登记——他们的流水由组长在「收支报表 → 银行流水」登记，防止两边重复记账。
 */

import { useState, useEffect } from "react";
import { Alert, Spin, App } from "antd";
import { CreditCardOutlined } from "@ant-design/icons";
import AppPageHeader from "@/components/AppPageHeader";
import BankFlowTab from "../team-report/BankFlowTab";

export default function PersonalBankFlowPage() {
  const { message } = App.useApp();
  // null=加载中；"self"=自管收款（开放登记）；"team"=组长清单组（只提示）
  const [mode, setMode] = useState<"self" | "team" | null>(null);

  useEffect(() => {
    fetch("/api/user/settings/payment-methods")
      .then((r) => r.json())
      .then((res) => {
        if (res?.code === 0) setMode(res.data?.mode === "self" ? "self" : "team");
        else message.error(res?.message || "加载失败，请刷新重试");
      })
      .catch(() => message.error("加载失败，请刷新重试"));
  }, [message]);

  return (
    <div style={{ padding: "16px 24px" }}>
      <AppPageHeader
        icon={<CreditCardOutlined />}
        title="银行流水"
        subtitle="登记自己银行卡的实际到账，系统按到账日自动预填本人平台打款明细并计算手续费，可导出流水单"
      />
      {mode === null ? (
        <div style={{ textAlign: "center", padding: 60 }}><Spin /></div>
      ) : mode === "team" ? (
        <Alert
          type="info"
          showIcon
          message="本组银行流水由组长统一登记"
          description="你所在小组的收款方式由组长维护，银行流水由组长在「收支报表 → 银行流水」登记，此页面无需操作。如有疑问请联系组长。"
          style={{ maxWidth: 680 }}
        />
      ) : (
        <BankFlowTab />
      )}
    </div>
  );
}
