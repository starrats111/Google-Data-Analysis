/**
 * D-046.A / D-046.B IntelliCenter — 商家 AI 智能画像编辑表单（共享组件）
 *
 * 用途：user/merchants 行内 Modal + admin/ai-profiles 列表页内 Drawer/Modal 共享。
 * 设计：07 拍板 U1=A + S3=A 复用同一组件。
 *
 * Props：
 *  - merchantId   被编辑商家 ID（必填）
 *  - scope        'user' | 'admin'（决定 API 前缀）
 *  - open         Modal 打开
 *  - readonly     只读模式
 *  - onClose      关闭回调
 *  - onSaved      保存成功回调
 *
 * 字段（D-046 / C-109 拍板 R1=A 12 字段全保留）：
 *  - 行业大类 industry_category (Select 32)
 *  - 行业子类 industry_subcategory (Input)
 *  - 商标授权 trademark_authorization_status (Radio 4)
 *  - 合规风险 compliance_risk_level (Radio 4)
 *  - 认证需求 requires_certification (Checkbox 8)
 *  - 业务画像 business_profile (结构化子表单)
 *  - 受众 audience_persona (结构化子表单)
 *  - 品牌资产 brand_assets (结构化子表单)
 *  - 季节模式 seasonal_pattern (结构化子表单)
 *  - 竞品 competitor_brands (动态数组)
 *  - 元数据 profile_updated_at / profile_source (只读)
 *  注：successful_template_ids / failed_template_ids 是 M11 反馈环填，MVP 不在 UI 暴露
 */
"use client";
import { useEffect, useState } from "react";
import {
  Alert,
  App,
  Button,
  Checkbox,
  Col,
  Descriptions,
  Divider,
  Form,
  Input,
  Modal,
  Radio,
  Row,
  Select,
  Space,
  Spin,
  Tag,
  Typography,
} from "antd";
import {
  COMPLIANCE_RISK_LABELS_CN,
  COMPLIANCE_RISK_LEVELS,
  INDUSTRY_CATEGORIES,
  INDUSTRY_LABELS_CN,
  PROFILE_SOURCE_LABELS_CN,
  TRADEMARK_AUTH_LABELS_CN,
  TRADEMARK_AUTH_STATUSES,
  type ComplianceRiskLevel,
  type IndustryCategory,
  type MerchantProfileFormPayload,
  type ProfileSource,
  type TrademarkAuthStatus,
} from "@/lib/intellicenter/merchant-profile/types";

const { Text } = Typography;
const { TextArea } = Input;

const CERT_KEYS = [
  { key: "healthcare", label: "医药/药店" },
  { key: "financial", label: "金融服务" },
  { key: "crypto", label: "加密货币" },
  { key: "alcohol", label: "酒精饮品" },
  { key: "pharmacy", label: "处方药" },
  { key: "political", label: "政治广告" },
  { key: "gambling", label: "博彩" },
  { key: "legal", label: "法律服务" },
];

export interface AIProfileFormProps {
  merchantId: string;
  scope: "user" | "admin";
  open: boolean;
  readonly?: boolean;
  /** 标题前缀（如商家名称），默认 "AI 画像" */
  titlePrefix?: string;
  onClose: () => void;
  onSaved?: () => void;
}

interface ProfileApiData {
  industry_category: string | null;
  industry_subcategory: string | null;
  business_profile: Record<string, unknown> | null;
  audience_persona: Record<string, unknown> | null;
  brand_assets: Record<string, unknown> | null;
  trademark_authorization_status: string;
  compliance_risk_level: string;
  requires_certification: Record<string, boolean> | null;
  successful_template_ids: unknown[] | null;
  failed_template_ids: unknown[] | null;
  seasonal_pattern: Record<string, unknown> | null;
  competitor_brands: { name: string; domain?: string }[] | null;
  profile_updated_at: string | null;
  profile_source: string;
  merchant_name?: string;
}

interface FormShape {
  industry_category?: IndustryCategory | null;
  industry_subcategory?: string;
  trademark_authorization_status: TrademarkAuthStatus;
  compliance_risk_level: ComplianceRiskLevel;
  cert_keys: string[];
  bp_main_products?: string;
  bp_price_range?: string;
  bp_discount_mode?: string;
  bp_shipping?: string;
  bp_payment?: string;
  bp_notes?: string;
  ap_age?: string;
  ap_gender?: string;
  ap_regions?: string;
  ap_interests?: string;
  ap_purchasing_power?: string;
  ba_slogan?: string;
  ba_usp?: string;
  ba_certifications?: string;
  ba_awards?: string;
  ba_endorsements?: string;
  sp_peak_months?: string;
  sp_holiday_events?: string;
  cb_text?: string;
}

function csvSplit(s: string | undefined | null): string[] {
  if (!s) return [];
  return s
    .split(/[,，;；\n]+/)
    .map((x) => x.trim())
    .filter(Boolean);
}

function csvJoin(arr: unknown): string {
  if (!Array.isArray(arr)) return "";
  return arr
    .filter((x) => x != null && String(x).trim().length > 0)
    .join(", ");
}

export default function AIProfileForm({
  merchantId,
  scope,
  open,
  readonly = false,
  titlePrefix = "AI 画像",
  onClose,
  onSaved,
}: AIProfileFormProps) {
  const { message } = App.useApp();
  const [form] = Form.useForm<FormShape>();
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [data, setData] = useState<ProfileApiData | null>(null);

  const apiBase = `/api/${scope}/merchants/${merchantId}/profile`;

  useEffect(() => {
    if (!open) return;
    setLoading(true);
    fetch(apiBase)
      .then((r) => r.json())
      .then((r: { code: number; data?: ProfileApiData; message?: string }) => {
        if (r.code !== 0 || !r.data) {
          message.error(r.message || "加载画像失败");
          return;
        }
        setData(r.data);
        const certKeys: string[] = [];
        if (r.data.requires_certification) {
          for (const [k, v] of Object.entries(r.data.requires_certification)) {
            if (v === true) certKeys.push(k);
          }
        }
        const bp = (r.data.business_profile ?? {}) as Record<string, unknown>;
        const ap = (r.data.audience_persona ?? {}) as Record<string, unknown>;
        const ba = (r.data.brand_assets ?? {}) as Record<string, unknown>;
        const sp = (r.data.seasonal_pattern ?? {}) as Record<string, unknown>;
        const cb = r.data.competitor_brands ?? [];
        form.setFieldsValue({
          industry_category:
            (r.data.industry_category as IndustryCategory) || null,
          industry_subcategory: r.data.industry_subcategory || "",
          trademark_authorization_status:
            (r.data.trademark_authorization_status as TrademarkAuthStatus) ||
            "unauthorized",
          compliance_risk_level:
            (r.data.compliance_risk_level as ComplianceRiskLevel) || "low",
          cert_keys: certKeys,
          bp_main_products: csvJoin(bp.main_products),
          bp_price_range: (bp.price_range as string) || "",
          bp_discount_mode: (bp.discount_mode as string) || "",
          bp_shipping: (bp.shipping as string) || "",
          bp_payment: (bp.payment as string) || "",
          bp_notes: (bp.notes as string) || "",
          ap_age: (ap.age as string) || "",
          ap_gender: (ap.gender as string) || "",
          ap_regions: csvJoin(ap.regions),
          ap_interests: csvJoin(ap.interests),
          ap_purchasing_power: (ap.purchasing_power as string) || "",
          ba_slogan: (ba.slogan as string) || "",
          ba_usp: csvJoin(ba.usp),
          ba_certifications: csvJoin(ba.certifications),
          ba_awards: csvJoin(ba.awards),
          ba_endorsements: csvJoin(ba.endorsements),
          sp_peak_months: csvJoin(sp.peak_months),
          sp_holiday_events: csvJoin(sp.holiday_events),
          cb_text: cb
            .map((c) =>
              c.domain ? `${c.name} (${c.domain})` : c.name,
            )
            .join("\n"),
        });
      })
      .catch((e) => message.error(`加载失败：${String(e)}`))
      .finally(() => setLoading(false));
  }, [open, apiBase, form, message]);

  const handleSave = async () => {
    if (readonly) return;
    setSaving(true);
    try {
      const v = await form.validateFields();
      const cert: Record<string, boolean> = {};
      for (const k of v.cert_keys || []) cert[k] = true;

      const competitorBrands = (v.cb_text || "")
        .split(/\n+/)
        .map((line) => line.trim())
        .filter(Boolean)
        .map((line) => {
          const m = line.match(/^(.+?)\s*\(([^)]+)\)\s*$/);
          if (m) return { name: m[1].trim(), domain: m[2].trim() };
          return { name: line };
        });

      const peakMonths = csvSplit(v.sp_peak_months)
        .map((x) => Number.parseInt(x, 10))
        .filter((n) => Number.isFinite(n) && n >= 1 && n <= 12);

      const payload: MerchantProfileFormPayload = {
        industry_category: v.industry_category || null,
        industry_subcategory: v.industry_subcategory || null,
        trademark_authorization_status: v.trademark_authorization_status,
        compliance_risk_level: v.compliance_risk_level,
        requires_certification:
          Object.keys(cert).length > 0 ? cert : null,
        business_profile: {
          main_products: csvSplit(v.bp_main_products),
          price_range: v.bp_price_range || undefined,
          discount_mode: v.bp_discount_mode || undefined,
          shipping: v.bp_shipping || undefined,
          payment: v.bp_payment || undefined,
          notes: v.bp_notes || undefined,
        },
        audience_persona: {
          age: v.ap_age || undefined,
          gender: v.ap_gender || undefined,
          regions: csvSplit(v.ap_regions),
          interests: csvSplit(v.ap_interests),
          purchasing_power: v.ap_purchasing_power || undefined,
        },
        brand_assets: {
          slogan: v.ba_slogan || undefined,
          usp: csvSplit(v.ba_usp),
          certifications: csvSplit(v.ba_certifications),
          awards: csvSplit(v.ba_awards),
          endorsements: csvSplit(v.ba_endorsements),
        },
        seasonal_pattern: {
          peak_months: peakMonths,
          holiday_events: csvSplit(v.sp_holiday_events),
        },
        competitor_brands: competitorBrands,
      };

      const r = await fetch(apiBase, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      }).then((x) => x.json());

      if (r.code !== 0) {
        message.error(r.message || "保存失败");
        return;
      }
      message.success("画像已保存");
      onSaved?.();
      onClose();
    } catch (e) {
      if ((e as { errorFields?: unknown[] }).errorFields) {
        message.error("请检查必填字段");
      } else {
        message.error(`保存失败：${String(e)}`);
      }
    } finally {
      setSaving(false);
    }
  };

  const titleSuffix = data?.merchant_name ? `· ${data.merchant_name}` : "";

  return (
    <Modal
      open={open}
      title={`${titlePrefix} ${titleSuffix}`}
      onCancel={onClose}
      width={840}
      footer={
        readonly
          ? [
              <Button key="close" onClick={onClose}>
                关闭
              </Button>,
            ]
          : [
              <Button key="cancel" onClick={onClose}>
                取消
              </Button>,
              <Button
                key="save"
                type="primary"
                loading={saving}
                onClick={handleSave}
              >
                保存
              </Button>,
            ]
      }
      destroyOnClose
    >
      <Spin spinning={loading}>
        <Alert
          type="info"
          showIcon
          style={{ marginBottom: 16 }}
          message="AI 智能画像（IntelliCenter）"
          description={
            <div>
              该画像用于 AI 生成广告时的 Pre-flight 政策校验 + Prompt
              动态注入，准确填写可显著降低拒登率。
              {data && (
                <div style={{ marginTop: 4, color: "#999" }}>
                  来源：
                  <Tag color="blue">
                    {PROFILE_SOURCE_LABELS_CN[
                      (data.profile_source as ProfileSource) || "none"
                    ] || data.profile_source}
                  </Tag>
                  {data.profile_updated_at && (
                    <span style={{ marginLeft: 8 }}>
                      更新时间：{new Date(data.profile_updated_at).toLocaleString()}
                    </span>
                  )}
                </div>
              )}
            </div>
          }
        />

        <Form form={form} layout="vertical" disabled={readonly}>
          <Divider orientation="left" plain>
            基础分类
          </Divider>
          <Row gutter={16}>
            <Col span={12}>
              <Form.Item name="industry_category" label="行业大类">
                <Select
                  allowClear
                  showSearch
                  placeholder="选择行业大类"
                  optionFilterProp="label"
                  options={INDUSTRY_CATEGORIES.map((c) => ({
                    value: c,
                    label: `${INDUSTRY_LABELS_CN[c]} (${c})`,
                  }))}
                />
              </Form.Item>
            </Col>
            <Col span={12}>
              <Form.Item name="industry_subcategory" label="行业子类">
                <Input placeholder="例如：运动鞋 / 智能手机 / 护肤品" />
              </Form.Item>
            </Col>
          </Row>

          <Divider orientation="left" plain>
            合规属性
          </Divider>
          <Row gutter={16}>
            <Col span={12}>
              <Form.Item
                name="trademark_authorization_status"
                label="商标授权状态"
              >
                <Radio.Group>
                  {TRADEMARK_AUTH_STATUSES.map((s) => (
                    <Radio key={s} value={s}>
                      {TRADEMARK_AUTH_LABELS_CN[s]}
                    </Radio>
                  ))}
                </Radio.Group>
              </Form.Item>
            </Col>
            <Col span={12}>
              <Form.Item name="compliance_risk_level" label="合规风险等级">
                <Radio.Group>
                  {COMPLIANCE_RISK_LEVELS.map((s) => (
                    <Radio key={s} value={s}>
                      {COMPLIANCE_RISK_LABELS_CN[s]}
                    </Radio>
                  ))}
                </Radio.Group>
              </Form.Item>
            </Col>
          </Row>
          <Form.Item name="cert_keys" label="认证 / 资质要求（勾选适用项）">
            <Checkbox.Group>
              <Row gutter={[8, 8]}>
                {CERT_KEYS.map((c) => (
                  <Col key={c.key} span={6}>
                    <Checkbox value={c.key}>{c.label}</Checkbox>
                  </Col>
                ))}
              </Row>
            </Checkbox.Group>
          </Form.Item>

          <Divider orientation="left" plain>
            业务画像
          </Divider>
          <Form.Item name="bp_main_products" label="主营产品（多个用逗号分隔）">
            <Input placeholder="例如：智能手表, 运动耳机" />
          </Form.Item>
          <Row gutter={16}>
            <Col span={8}>
              <Form.Item name="bp_price_range" label="价格区间">
                <Input placeholder="例如：$20-$200" />
              </Form.Item>
            </Col>
            <Col span={8}>
              <Form.Item name="bp_discount_mode" label="折扣模式">
                <Input placeholder="例如：周末满减 / 限时秒杀" />
              </Form.Item>
            </Col>
            <Col span={8}>
              <Form.Item name="bp_shipping" label="物流模式">
                <Input placeholder="例如：48h 美国直发" />
              </Form.Item>
            </Col>
          </Row>
          <Row gutter={16}>
            <Col span={12}>
              <Form.Item name="bp_payment" label="支付方式">
                <Input placeholder="例如：PayPal / Stripe / Klarna" />
              </Form.Item>
            </Col>
            <Col span={12}>
              <Form.Item name="bp_notes" label="备注">
                <Input placeholder="其他业务特征" />
              </Form.Item>
            </Col>
          </Row>

          <Divider orientation="left" plain>
            目标受众
          </Divider>
          <Row gutter={16}>
            <Col span={8}>
              <Form.Item name="ap_age" label="年龄段">
                <Input placeholder="例如：25-44" />
              </Form.Item>
            </Col>
            <Col span={8}>
              <Form.Item name="ap_gender" label="性别倾向">
                <Input placeholder="例如：female / male / all" />
              </Form.Item>
            </Col>
            <Col span={8}>
              <Form.Item name="ap_purchasing_power" label="购买力">
                <Input placeholder="例如：mid-high" />
              </Form.Item>
            </Col>
          </Row>
          <Form.Item name="ap_regions" label="目标地区（多个用逗号分隔）">
            <Input placeholder="例如：US, CA, GB" />
          </Form.Item>
          <Form.Item name="ap_interests" label="兴趣标签（多个用逗号分隔）">
            <Input placeholder="例如：fitness, outdoor, eco" />
          </Form.Item>

          <Divider orientation="left" plain>
            品牌资产
          </Divider>
          <Form.Item name="ba_slogan" label="Slogan">
            <Input placeholder="例如：Built for adventures" />
          </Form.Item>
          <Form.Item name="ba_usp" label="USP 卖点（多个用逗号分隔）">
            <Input placeholder="例如：48h 直发, 15 天退货, GOTS 认证" />
          </Form.Item>
          <Row gutter={16}>
            <Col span={12}>
              <Form.Item name="ba_certifications" label="认证（多个用逗号分隔）">
                <Input placeholder="例如：FDA, MHRA, ISO 9001" />
              </Form.Item>
            </Col>
            <Col span={12}>
              <Form.Item name="ba_awards" label="奖项 / 荣誉（多个用逗号分隔）">
                <Input placeholder="例如：2024 Reddot, BoF 100" />
              </Form.Item>
            </Col>
          </Row>
          <Form.Item name="ba_endorsements" label="代言人 / 口碑（多个用逗号分隔）">
            <Input placeholder="例如：Trustpilot 4.7, Vogue, Forbes" />
          </Form.Item>

          <Divider orientation="left" plain>
            季节模式
          </Divider>
          <Row gutter={16}>
            <Col span={12}>
              <Form.Item
                name="sp_peak_months"
                label="高峰月份（1-12 数字，逗号分隔）"
              >
                <Input placeholder="例如：11, 12" />
              </Form.Item>
            </Col>
            <Col span={12}>
              <Form.Item
                name="sp_holiday_events"
                label="节假日事件（逗号分隔）"
              >
                <Input placeholder="例如：BlackFriday, Christmas, Prime Day" />
              </Form.Item>
            </Col>
          </Row>

          <Divider orientation="left" plain>
            竞品品牌
          </Divider>
          <Form.Item
            name="cb_text"
            label="每行一个，格式 「名称」 或 「名称 (域名)」"
            extra="商标避让用 — AI 生成广告时会主动避开下方品牌名"
          >
            <TextArea
              rows={3}
              placeholder={"Anker (anker.com)\nFitbit\nGarmin (garmin.com)"}
            />
          </Form.Item>

          {data && (
            <>
              <Divider orientation="left" plain>
                元数据（只读）
              </Divider>
              <Descriptions size="small" column={2} bordered>
                <Descriptions.Item label="画像来源">
                  {PROFILE_SOURCE_LABELS_CN[
                    (data.profile_source as ProfileSource) || "none"
                  ]}
                </Descriptions.Item>
                <Descriptions.Item label="最后更新">
                  {data.profile_updated_at
                    ? new Date(data.profile_updated_at).toLocaleString()
                    : "—"}
                </Descriptions.Item>
                <Descriptions.Item label="成功模板数">
                  {Array.isArray(data.successful_template_ids)
                    ? data.successful_template_ids.length
                    : 0}{" "}
                  <Text type="secondary" style={{ fontSize: 12 }}>
                    （由 M11 反馈环填，MVP 暂无）
                  </Text>
                </Descriptions.Item>
                <Descriptions.Item label="失败模板数">
                  {Array.isArray(data.failed_template_ids)
                    ? data.failed_template_ids.length
                    : 0}{" "}
                  <Text type="secondary" style={{ fontSize: 12 }}>
                    （由 M11 反馈环填，MVP 暂无）
                  </Text>
                </Descriptions.Item>
              </Descriptions>
            </>
          )}
        </Form>
      </Spin>
      <Space style={{ marginTop: 12 }}>
        <Text type="secondary" style={{ fontSize: 12 }}>
          填写指南：所有字段均为选填，AI Pre-flight 会根据已填字段动态注入 prompt
          约束。空字段 = 不参与注入。
        </Text>
      </Space>
    </Modal>
  );
}
