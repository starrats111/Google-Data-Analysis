"use client";

import { Tabs, Typography } from "antd";
import { ApiOutlined, RobotOutlined } from "@ant-design/icons";
import AIProvidersTab from "./ProvidersTab";
import AIModelsTab from "./ModelsTab";

const { Title } = Typography;

export default function AIConfigPage() {
  return (
    <div>
      <Title level={4} style={{ marginBottom: 16 }}>AI 配置</Title>
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
