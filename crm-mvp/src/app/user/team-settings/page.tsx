"use client";

import { useState, useEffect } from "react";
import { Card, Switch, Typography, Alert, App } from "antd";
import { TeamOutlined, SettingOutlined } from "@ant-design/icons";
import AppPageHeader from "@/components/AppPageHeader";

const { Text } = Typography;

export default function TeamSettingsPage() {
  const { message } = App.useApp();
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [teamName, setTeamName] = useState("");
  const [visible, setVisible] = useState(false); // cross_team_visible === 1

  useEffect(() => {
    fetch("/api/user/settings/team-privacy")
      .then((r) => r.json())
      .then((res) => {
        if (res.code === 0) {
          setTeamName(res.data.team_name || "");
          setVisible(res.data.cross_team_visible === 1);
        } else {
          message.error(res.message || "加载失败");
        }
      })
      .catch(() => message.error("加载失败"))
      .finally(() => setLoading(false));
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const handleToggle = async (checked: boolean) => {
    setSaving(true);
    const res = await fetch("/api/user/settings/team-privacy", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ cross_team_visible: checked ? 1 : 0 }),
    }).then((r) => r.json()).catch(() => null);
    setSaving(false);
    if (res?.code === 0) {
      setVisible(checked);
      message.success("已保存");
    } else {
      message.error(res?.message || "保存失败");
    }
  };

  return (
    <div>
      <AppPageHeader icon={<SettingOutlined />} title="团队设置" subtitle="组长专属：控制本组的投放隐私" />
      <Card
        title={<><TeamOutlined /> 团队投放隐私{teamName ? ` — ${teamName}` : ""}</>}
        size="small"
        loading={loading}
        style={{ maxWidth: 680 }}
      >
        <Alert
          type="info"
          showIcon
          style={{ marginBottom: 16 }}
          message="控制本组成员能否查看其他组的投放情况"
          description="关闭（默认）时，本组成员在商家「在投详情」里只能看到本组成员的投放，「在投人数」也只统计本组；开启后，本组成员可查看其他组的投放情况。该开关仅由组长控制。"
        />
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: "12px 0" }}>
          <div>
            <div style={{ fontWeight: 500 }}>允许本组查看其他组的投放情况</div>
            <Text type="secondary" style={{ fontSize: 13 }}>
              {visible ? "已开启：本组成员可看到其他组的投放情况" : "已关闭：本组成员只能看到本组的投放情况"}
            </Text>
          </div>
          <Switch
            checked={visible}
            loading={saving}
            onChange={handleToggle}
            checkedChildren="开"
            unCheckedChildren="关"
          />
        </div>
      </Card>
    </div>
  );
}
