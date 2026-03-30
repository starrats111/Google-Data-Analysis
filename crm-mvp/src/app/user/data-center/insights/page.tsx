"use client";

import { useState } from "react";
import { Card, Tabs, Typography, Empty, Pagination, Spin } from "antd";
import { BulbOutlined, CalendarOutlined } from "@ant-design/icons";
import { useApiWithParams } from "@/lib/swr";
import dayjs from "dayjs";
import utc from "dayjs/plugin/utc";
import timezone from "dayjs/plugin/timezone";

dayjs.extend(utc);
dayjs.extend(timezone);

const TZ = "Asia/Shanghai";

const { Title, Text } = Typography;

interface Insight {
  id: string;
  insight_date: string;
  insight_type: string;
  content: string;
  metrics_snapshot: Record<string, unknown> | null;
  created_at: string;
}

interface InsightsData {
  list: Insight[];
  total: number;
  page: number;
  pageSize: number;
}

const TYPE_LABELS: Record<string, string> = {
  daily: "每日洞察",
  weekly: "每周洞察",
  monthly: "每月洞察",
};

export default function InsightsPage() {
  const [type, setType] = useState("daily");
  const [page, setPage] = useState(1);
  const pageSize = 10;

  const { data, isLoading } = useApiWithParams<InsightsData>(
    "/api/user/data-center/insights",
    { type, page: String(page), pageSize: String(pageSize) },
  );

  const insights = data?.list || [];
  const total = data?.total || 0;

  return (
    <div>
      <Title level={4} style={{ marginBottom: 16 }}>
        <BulbOutlined /> AI 洞察报告
      </Title>

      <Tabs
        activeKey={type}
        onChange={(k) => { setType(k); setPage(1); }}
        items={[
          { key: "daily", label: "每日洞察" },
          { key: "weekly", label: "每周洞察" },
          { key: "monthly", label: "每月洞察" },
        ]}
      />

      <Spin spinning={isLoading}>
        {insights.length === 0 ? (
          <Card>
            <Empty description={`暂无${TYPE_LABELS[type] || ""}报告`} />
          </Card>
        ) : (
          <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
            {insights.map((item) => (
              <Card
                key={item.id}
                size="small"
                title={
                  <span>
                    <CalendarOutlined style={{ marginRight: 8 }} />
                    {dayjs(item.insight_date).tz(TZ).format("YYYY-MM-DD")}
                    <Text type="secondary" style={{ marginLeft: 12, fontSize: 12 }}>
                      {TYPE_LABELS[item.insight_type] || item.insight_type}
                    </Text>
                  </span>
                }
                extra={
                  <Text type="secondary" style={{ fontSize: 12 }}>
                    {dayjs(item.created_at).tz(TZ).format("MM-DD HH:mm")}
                  </Text>
                }
              >
                <div style={{ whiteSpace: "pre-wrap", lineHeight: 1.8, fontSize: 14 }}>
                  {item.content}
                </div>
              </Card>
            ))}
          </div>
        )}
      </Spin>

      {total > pageSize && (
        <div style={{ textAlign: "right", marginTop: 16 }}>
          <Pagination
            current={page}
            total={total}
            pageSize={pageSize}
            onChange={setPage}
            showTotal={(t) => `共 ${t} 条`}
          />
        </div>
      )}
    </div>
  );
}
