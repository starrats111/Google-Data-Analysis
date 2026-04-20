"use client";

import { useState, useRef, useCallback } from "react";
import {
  Card, Tabs, Typography, Empty, Pagination, Spin, Tag, Avatar,
  DatePicker, Input, Button, Alert, Divider, Space,
} from "antd";
import {
  CalendarOutlined, RobotOutlined,
  ThunderboltOutlined, LoadingOutlined,
} from "@ant-design/icons";
import { useApiWithParams, useApi } from "@/lib/swr";
import dayjs from "dayjs";
import utc from "dayjs/plugin/utc";
import timezone from "dayjs/plugin/timezone";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";

dayjs.extend(utc);
dayjs.extend(timezone);

const TZ = "Asia/Shanghai";
const { Title, Text } = Typography;
const { RangePicker } = DatePicker;
const { TextArea } = Input;

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

const PRESET_QUESTIONS = [
  "近7天账户全面分析，找出最需要优化的系列",
  "哪些系列 ROI 最高？哪些在亏损？给出操作建议",
  "联盟平台收入来源分析，哪个平台表现最好？",
  "每日趋势分析，找出数据异常的日期及原因",
];

interface AdSettingsData {
  ai_rule_profile?: {
    active_persona_id?: string;
    personas?: Array<{ id: string; name: string; tags: string[]; description: string }>;
  };
}

// 从 ad-settings 读取当前激活人设
function useActivePersona() {
  const { data } = useApi<AdSettingsData>("/api/user/ad-settings");
  const profile = data?.ai_rule_profile;
  if (!profile) return null;
  const personas = profile.personas || [];
  const activeId = profile.active_persona_id || "system_adrian";
  return personas.find((p) => p.id === activeId) ?? personas[0] ?? null;
}

// AI 顾问标识卡（动态读取当前激活人设）
function AdrianCard() {
  const persona = useActivePersona();
  const name = persona?.name ?? "Adrian · 数据猎手";
  const tags = persona?.tags ?? ["ROI激进派", "数字驱动运营", "账户诊断专家"];
  const description = persona?.description ?? "Google Ads 搜索广告顾问，专注 ROI 导向精准投放。";

  return (
    <Card
      size="small"
      style={{
        marginBottom: 20,
        background: "#fafafa",
        border: "1px solid #e8e0ff",
        borderRadius: 8,
      }}
    >
      <div style={{ display: "flex", alignItems: "center", gap: 14 }}>
        <Avatar
          size={44}
          icon={<RobotOutlined />}
          style={{
            background: "linear-gradient(135deg, #667eea 0%, #764ba2 100%)",
            flexShrink: 0,
          }}
        />
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
            <Text style={{ fontWeight: 600, fontSize: 14 }}>{name}</Text>
            {tags.map((tag) => (
              <Tag
                key={tag}
                style={{
                  background: "#f0ecff",
                  border: "1px solid #d6cef5",
                  color: "#5a4a9c",
                  fontSize: 11,
                  margin: 0,
                  borderRadius: 4,
                }}
              >
                {tag}
              </Tag>
            ))}
          </div>
          <div style={{ marginTop: 4 }}>
            <Text type="secondary" style={{ fontSize: 11 }}>
              {description}
            </Text>
          </div>
        </div>
      </div>
    </Card>
  );
}

// 前端兜底：去除 AI 偶发 emoji
function stripEmoji(text: string): string {
  return text.replace(/[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}\u{FE00}-\u{FEFF}]/gu, "").replace(/\s{2,}/g, " ");
}

// Markdown 渲染
const markdownStyles: React.CSSProperties = {
  lineHeight: 1.9,
  fontSize: 14,
  color: "rgba(0,0,0,0.82)",
};

// ──────────────────────────────────────────────
// 实时分析面板
// ──────────────────────────────────────────────
function LiveAnalysisPanel() {
  const [dateRange, setDateRange] = useState<[dayjs.Dayjs, dayjs.Dayjs]>([
    dayjs().subtract(7, "day"),
    dayjs().subtract(1, "day"),
  ]);
  const [question, setQuestion] = useState("");
  const [isAnalyzing, setIsAnalyzing] = useState(false);
  const [statusLogs, setStatusLogs] = useState<string[]>([]);
  const [content, setContent] = useState("");
  const [error, setError] = useState("");
  const abortRef = useRef<AbortController | null>(null);

  const startAnalysis = useCallback(async () => {
    if (!dateRange || isAnalyzing) return;

    setIsAnalyzing(true);
    setStatusLogs([]);
    setContent("");
    setError("");

    const ctrl = new AbortController();
    abortRef.current = ctrl;

    try {
      const token = localStorage.getItem("token") || sessionStorage.getItem("token") || "";
      const res = await fetch("/api/user/ai-analysis", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({
          date_from: dateRange[0].format("YYYY-MM-DD"),
          date_to: dateRange[1].format("YYYY-MM-DD"),
          question: question.trim() || undefined,
        }),
        signal: ctrl.signal,
      });

      if (!res.ok) {
        const err = await res.json().catch(() => ({ error: "请求失败" }));
        throw new Error(err.error || `HTTP ${res.status}`);
      }

      const reader = res.body?.getReader();
      if (!reader) throw new Error("无法获取响应流");

      const dec = new TextDecoder();
      let buf = "";

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buf += dec.decode(value, { stream: true });
        const lines = buf.split("\n");
        buf = lines.pop() || "";

        let eventType = "";
        for (const line of lines) {
          if (line.startsWith("event: ")) {
            eventType = line.slice(7).trim();
          } else if (line.startsWith("data: ")) {
            try {
              const payload = JSON.parse(line.slice(6));
              if (eventType === "status") {
                setStatusLogs((prev) => [...prev, payload]);
              } else if (eventType === "tool") {
                setStatusLogs((prev) => [...prev, payload]);
              } else if (eventType === "content") {
                setContent((prev) => prev + stripEmoji(payload));
              } else if (eventType === "error") {
                setError(payload);
              }
            } catch { /* ignore */ }
          }
        }
      }
    } catch (e) {
      if ((e as Error).name !== "AbortError") {
        setError((e as Error).message || "分析失败，请重试");
      }
    } finally {
      setIsAnalyzing(false);
      abortRef.current = null;
    }
  }, [dateRange, question, isAnalyzing]);

  const stopAnalysis = () => {
    abortRef.current?.abort();
    setIsAnalyzing(false);
  };

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
      {/* 参数配置 */}
      <Card
        size="small"
        style={{ border: "1px solid #e8e0ff", borderRadius: 8 }}
        styles={{ body: { padding: "16px" } }}
      >
        <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
            <Text strong style={{ minWidth: 60 }}>分析周期</Text>
            <RangePicker
              value={dateRange}
              onChange={(vals) => {
                if (vals?.[0] && vals?.[1]) setDateRange([vals[0], vals[1]]);
              }}
              disabledDate={(d) => d.isAfter(dayjs())}
              format="YYYY-MM-DD"
              style={{ flex: 1, minWidth: 240 }}
              presets={[
                { label: "近7天", value: [dayjs().subtract(7, "day"), dayjs().subtract(1, "day")] },
                { label: "近30天", value: [dayjs().subtract(30, "day"), dayjs().subtract(1, "day")] },
                { label: "本月", value: [dayjs().startOf("month"), dayjs().subtract(1, "day")] },
              ]}
            />
          </div>

          <div>
            <Text strong style={{ display: "block", marginBottom: 6 }}>分析问题（可选，留空则全面分析）</Text>
            <TextArea
              value={question}
              onChange={(e) => setQuestion(e.target.value)}
              placeholder="例：哪些系列正在亏损？如何优化 ROI？"
              rows={2}
              maxLength={300}
              showCount
              disabled={isAnalyzing}
            />
          </div>

          <div>
            <Text type="secondary" style={{ fontSize: 12, display: "block", marginBottom: 6 }}>快速问题：</Text>
            <Space wrap size={6}>
              {PRESET_QUESTIONS.map((q) => (
                <Tag
                  key={q}
                  onClick={() => !isAnalyzing && setQuestion(q)}
                  style={{
                    cursor: isAnalyzing ? "not-allowed" : "pointer",
                    background: question === q ? "#f0ecff" : undefined,
                    borderColor: question === q ? "#764ba2" : undefined,
                    color: question === q ? "#302b63" : undefined,
                    fontSize: 12,
                  }}
                >
                  {q}
                </Tag>
              ))}
            </Space>
          </div>

          <div style={{ display: "flex", gap: 8 }}>
            <Button
              type="primary"
              icon={isAnalyzing ? <LoadingOutlined /> : <ThunderboltOutlined />}
              onClick={startAnalysis}
              disabled={isAnalyzing}
              style={{ background: "#764ba2", borderColor: "#764ba2" }}
            >
              {isAnalyzing ? "Adrian 正在分析..." : "开始分析"}
            </Button>
            {isAnalyzing && (
              <Button onClick={stopAnalysis}>停止</Button>
            )}
          </div>
        </div>
      </Card>

      {/* 工具调用日志 */}
      {statusLogs.length > 0 && (
        <Card
          size="small"
          title={<Text style={{ fontSize: 12, color: "#764ba2" }}>工具调用日志</Text>}
          style={{ border: "1px solid #e8e0ff", borderRadius: 8 }}
          styles={{ body: { padding: "10px 16px" } }}
        >
          {statusLogs.map((log, i) => (
            <div key={i} style={{ fontSize: 12, color: "#888", lineHeight: 1.8, fontFamily: "monospace" }}>
              {log}
            </div>
          ))}
        </Card>
      )}

      {/* 错误提示 */}
      {error && (
        <Alert
          type="error"
          message={error}
          closable
          onClose={() => setError("")}
        />
      )}

      {/* 分析结果 */}
      {(content || isAnalyzing) && (
        <Card
          style={{ border: "1px solid #d6cef5", borderRadius: 8 }}
          title={
            <span>
              <RobotOutlined style={{ color: "#764ba2", marginRight: 8 }} />
              <Text strong style={{ color: "#302b63" }}>Adrian 分析报告</Text>
              {isAnalyzing && !content && (
                <Text type="secondary" style={{ fontSize: 12, marginLeft: 8 }}>正在生成中...</Text>
              )}
            </span>
          }
        >
          {content ? (
            <div style={markdownStyles} className="insight-markdown">
              <ReactMarkdown
                remarkPlugins={[remarkGfm]}
                components={{
                  table: ({ children }) => (
                    <div className="table-wrapper"><table>{children}</table></div>
                  ),
                }}
              >{content}</ReactMarkdown>
              {isAnalyzing && (
                <span style={{ display: "inline-block", width: 8, height: 14, background: "#764ba2", animation: "blink 1s step-end infinite", marginLeft: 2, verticalAlign: "text-bottom" }} />
              )}
            </div>
          ) : (
            <div style={{ textAlign: "center", padding: "24px 0" }}>
              <Spin indicator={<LoadingOutlined style={{ fontSize: 24, color: "#764ba2" }} />} />
              <div style={{ marginTop: 12, color: "#9b8ed6", fontSize: 13 }}>Adrian 正在调用工具获取数据...</div>
            </div>
          )}
        </Card>
      )}

      <style>{`@keyframes blink { 50% { opacity: 0; } }`}</style>
    </div>
  );
}

// ──────────────────────────────────────────────
// 历史报告页面
// ──────────────────────────────────────────────
function HistoryPanel() {
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
                  <ReactMarkdown
                    remarkPlugins={[remarkGfm]}
                    components={{
                      table: ({ children }) => (
                        <div className="table-wrapper"><table>{children}</table></div>
                      ),
                    }}
                  >{stripEmoji(item.content)}</ReactMarkdown>
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

// ──────────────────────────────────────────────
// 主页面
// ──────────────────────────────────────────────
export default function InsightsPage() {
  const [activeTab, setActiveTab] = useState("live");

  return (
    <div>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 16 }}>
        <Title level={4} style={{ margin: 0 }}>
          AI 分析报告
        </Title>
      </div>

      <AdrianCard />

      <Tabs
        activeKey={activeTab}
        onChange={setActiveTab}
        items={[
          {
            key: "live",
            label: (
              <span>
                <ThunderboltOutlined style={{ color: "#764ba2" }} />
                实时分析
              </span>
            ),
          },
          {
            key: "history",
            label: (
              <span>
                <CalendarOutlined />
                历史报告
              </span>
            ),
          },
        ]}
      />

      <Divider style={{ margin: "8px 0 16px" }} />

      {activeTab === "live" ? <LiveAnalysisPanel /> : <HistoryPanel />}

      <style>{`
        .insight-markdown {
          font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
        }
        .insight-markdown h1 {
          font-size: 18px;
          font-weight: 700;
          margin: 0 0 16px;
          color: #1a1040;
          border-bottom: 2px solid #e8e0ff;
          padding-bottom: 8px;
        }
        .insight-markdown h2 {
          font-size: 15px;
          font-weight: 700;
          margin: 24px 0 10px;
          color: #302b63;
          padding: 6px 12px;
          background: #f4f1ff;
          border-left: 3px solid #764ba2;
          border-radius: 0 4px 4px 0;
        }
        .insight-markdown h3 {
          font-size: 13.5px;
          font-weight: 600;
          margin: 16px 0 8px;
          color: #4a3f8c;
        }
        .insight-markdown p {
          margin: 6px 0;
          line-height: 1.9;
        }
        .insight-markdown ul, .insight-markdown ol {
          padding-left: 22px;
          margin: 6px 0 10px;
        }
        .insight-markdown li {
          margin: 5px 0;
          line-height: 1.75;
        }
        .insight-markdown strong {
          color: #1a1040;
          font-weight: 700;
        }
        .insight-markdown blockquote {
          border-left: 3px solid #764ba2;
          margin: 12px 0;
          padding: 8px 14px;
          color: #444;
          background: #f9f7ff;
          border-radius: 0 6px 6px 0;
          font-style: normal;
        }
        .insight-markdown blockquote p { margin: 0; }
        .insight-markdown .table-wrapper {
          overflow-x: auto;
          margin: 12px 0;
          border-radius: 6px;
          border: 1px solid #e0d8f8;
        }
        .insight-markdown table {
          width: 100%;
          border-collapse: collapse;
          font-size: 13px;
          min-width: 400px;
        }
        .insight-markdown thead tr {
          background: #f0ecff;
        }
        .insight-markdown th {
          padding: 8px 12px;
          text-align: left;
          font-weight: 600;
          color: #302b63;
          border-bottom: 2px solid #d6cef5;
          white-space: nowrap;
        }
        .insight-markdown td {
          padding: 7px 12px;
          border-bottom: 1px solid #ede8ff;
          color: #333;
        }
        .insight-markdown tbody tr:last-child td { border-bottom: none; }
        .insight-markdown tbody tr:hover td { background: #faf8ff; }
        .insight-markdown code {
          background: #f0ecff;
          padding: 1px 6px;
          border-radius: 3px;
          font-size: 12px;
          font-family: "SF Mono", monospace;
        }
        .insight-markdown hr {
          border: none;
          border-top: 1px solid #ede8ff;
          margin: 16px 0;
        }
      `}</style>
    </div>
  );
}
