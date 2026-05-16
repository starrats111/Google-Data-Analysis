"use client";

import { Tabs } from "antd";
import { ApiOutlined, RobotOutlined } from "@ant-design/icons";
import AIProvidersTab from "./ProvidersTab";
import AIModelsTab from "./ModelsTab";
import AppPageHeader from "@/components/AppPageHeader";

export default function AIConfigPage() {
  return (
    <div>
      <AppPageHeader icon={<RobotOutlined />} title="AI 配置" />
      <Tabs
        defaultActiveKey="providers"
        items={[
          {
            key: "providers",
            label: <><ApiOutlined /> AI 供应商</>,
            children: <AIProvidersTab />,
          },
          {
            key: "models",
            label: <><RobotOutlined /> 场景模型分配</>,
            children: <AIModelsTab />,
          },
        ]}
      />
    </div>
  );
}
