"use client";

import { useState } from "react";
import { Card, Input, Button, Space, List, Typography } from "antd";
import { CalendarOutlined, GlobalOutlined, SearchOutlined } from "@ant-design/icons";

const { Title, Text } = Typography;

interface Holiday {
  id: string; holiday_name: string; holiday_date: string; holiday_type: string;
  country_code: string;
}

export default function HolidaysPage() {
  const [countryCode, setCountryCode] = useState("");
  const [holidays, setHolidays] = useState<Holiday[]>([]);
  const [loading, setLoading] = useState(false);

  const searchHolidays = async () => {
    if (!countryCode) return;
    setLoading(true);
    const res = await fetch(`/api/user/holidays?country=${countryCode}`).then((r) => r.json());
    if (res.code === 0) setHolidays(res.data);
    setLoading(false);
  };

  return (
    <div>
      <Title level={4} style={{ marginBottom: 16 }}><CalendarOutlined /> 节日营销</Title>
      <Card>
        <Space style={{ marginBottom: 24 }}>
          <Input
            placeholder="输入国家代码 (如 US, GB, AU)"
            value={countryCode}
            onChange={(e) => setCountryCode(e.target.value.toUpperCase())}
            style={{ width: 240 }}
            onPressEnter={searchHolidays}
            prefix={<GlobalOutlined />}
          />
          <Button type="primary" icon={<SearchOutlined />} loading={loading} onClick={searchHolidays}>查询节日</Button>
        </Space>
        <List
          dataSource={holidays}
          locale={{ emptyText: "输入国家代码查询节日信息" }}
          renderItem={(item) => (
            <List.Item>
              <List.Item.Meta
                avatar={<CalendarOutlined style={{ fontSize: 20, color: "#4DA6FF" }} />}
                title={item.holiday_name}
                description={
                  <Space>
                    <Text type="secondary">{new Date(item.holiday_date).toLocaleDateString("zh-CN", { timeZone: "Asia/Shanghai" })}</Text>
                    <Text type="secondary">·</Text>
                    <Text type="secondary">{item.holiday_type}</Text>
                    <Text type="secondary">·</Text>
                    <Text type="secondary">{item.country_code}</Text>
                  </Space>
                }
              />
            </List.Item>
          )}
        />
      </Card>
    </div>
  );
}
