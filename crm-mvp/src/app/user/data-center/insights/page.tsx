"use client";

import { useState } from "react";
import { Card, Tabs, Typography, Empty, Pagination, Spin, Tag, Avatar } from "antd";
import { BulbOutlined, CalendarOutlined, RobotOutlined } from "@ant-design/icons";
import { useApiWithParams } from "@/lib/swr";
import dayjs from "dayjs";
import utc from "dayjs/plugin/utc";
import timezone from "dayjs/plugin/timezone";
import ReactMarkdown from "react-markdown";

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

const ADRIAN_TAGS = ["ROI激进派", "数字驱动运营", "账户诊断专家"];

// Adrian 顾问标识卡
function AdrianCard() {
  return (
    <Card
      size="small"
      style={{
        marginBottom: 20,
        background: "linear-gradient(135deg, #0f0c29 0%, #302b63 50%, #24243e 100%)",
        border: "1px solid #4a3f8c",
        borderRadius: 10,
      }}
    >
      <div style={{ display: "flex", alignItems: "center", gap: 16 }}>
        <Avatar
          size={52}
          icon={<RobotOutlined />}
          style={{
            background: "linear-gradient(135deg, #667eea 0%, #764ba2 100%)",
            border: "2px solid #9b8ed6",
            flexShrink: 0,
          }}
        />
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
            <Text style={{ color: "#e8e0ff", fontWeight: 700, fontSize: 16 }}>
              Adrian · 数据猎手
            </Text>
            <Text style={{ color: "#9b8ed6", fontSize: 12 }}>Google Ads 搜索广告顾问</Text>
          </div>
          <div style={{ marginTop: 6, display: "flex", gap: 6, flexWrap: "wrap" }}>
            {ADRIAN_TAGS.map((tag) => (
              <Tag
                key={tag}
                style={{
                  background: "rgba(102,126,234,0.2)",
                  border: "1px solid #667eea",
                  color: "#b8a9f5",
                  fontSize: 11,
                  margin: 0,
                }}
              >
                {tag}
              </Tag>
            ))}
          </div>
          <div style={{ marginTop: 8, display: "flex", flexDirection: "column", gap: 2 }}>
            <Text style={{ color: "#7c6fbc", fontSize: 11, fontStyle: "italic" }}>
              职业信条：「没有坏的产品，只有投错的人群和出不动的价。」
            </Text>
          </div>
        </div>
      </div>
    </Card>
  );
}

// Markdown 渲染样式
const markdownStyles: React.CSSProperties = {
  lineHeight: 1.85,
  fontSize: 14,
  color: "rgba(0,0,0,0.85)",
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

      <AdrianCard />

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
            <Empty
              description={
                <span>
                  暂无{TYPE_LABELS[type] || ""}报告
                  <br />
                  <Text type="secondary" style={{ fontSize: 12 }}>
                    Adrian 将在每日 07:00（北京时间）自动生成前一天的数据洞察报告
                  </Text>
                </span>
              }
            />
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
                  <span style={{ display: "flex", alignItems: "center", gap: 8 }}>
                    <RobotOutlined style={{ color: "#764ba2" }} />
                    <Text type="secondary" style={{ fontSize: 12 }}>
                      {dayjs(item.created_at).tz(TZ).format("MM-DD HH:mm")}
                    </Text>
                  </span>
                }
              >
                <div style={markdownStyles} className="insight-markdown">
                  <ReactMarkdown>{item.content}</ReactMarkdown>
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

      <style>{`
        .insight-markdown h2 {
          font-size: 15px;
          font-weight: 700;
          margin: 16px 0 8px;
          color: #302b63;
          border-bottom: 2px solid #e8e0ff;
          padding-bottom: 4px;
        }
        .insight-markdown h3 {
          font-size: 14px;
          font-weight: 600;
          margin: 12px 0 6px;
          color: #4a3f8c;
        }
        .insight-markdown ul, .insight-markdown ol {
          padding-left: 20px;
          margin: 6px 0;
        }
        .insight-markdown li {
          margin: 4px 0;
        }
        .insight-markdown strong {
          color: #302b63;
        }
        .insight-markdown table {
          width: 100%;
          border-collapse: collapse;
          font-size: 13px;
          margin: 8px 0;
        }
        .insight-markdown th {
          background: #f0ecff;
          padding: 6px 10px;
          text-align: left;
          border: 1px solid #d6cef5;
          font-weight: 600;
        }
        .insight-markdown td {
          padding: 5px 10px;
          border: 1px solid #e8e0ff;
        }
        .insight-markdown tr:nth-child(even) td {
          background: #faf9ff;
        }
        .insight-markdown blockquote {
          border-left: 3px solid #764ba2;
          margin: 8px 0;
          padding: 6px 12px;
          color: #555;
          background: #f9f7ff;
        }
        .insight-markdown p {
          margin: 4px 0;
        }
        .insight-markdown code {
          background: #f0ecff;
          padding: 1px 5px;
          border-radius: 3px;
          font-size: 12px;
        }
      `}</style>
    </div>
  );
}
