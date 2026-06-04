/**
 * D-004 共享商家名 + 追踪链接复制组件
 *
 * 升级点（相比 user/merchants/page.tsx 原 MerchantNameCell 内联版本）：
 *  - 多账号场景修复：当商家 `connection_campaign_links` 含 ≥2 个属于当前用户的 platform_connection 时
 *    点击复制图标弹 Popover 让用户选账号，复制对应账号的追踪链接
 *  - 单账号 / 无多账号链接时退化为原行为（直接复制 campaign_link || tracking_link）
 *  - 仅展示属于当前用户的账号链接（由后端 API 已经做了 user_id 过滤）
 *
 * 设计文档：设计方案.md §四·D-004 §3 F-12 / F-13 / F-15
 */
"use client";
import { useState } from "react";
import { App, Button, Popover, Space, Tooltip, Typography } from "antd";
import { CopyOutlined, ShopOutlined } from "@ant-design/icons";
import { copyTextToClipboard, previewText } from "@/lib/clipboard";

/**
 * BUG-01：优先返回完整 http(s) URL，避免某一字段是裸 token 时被复制。
 * 在 campaign_link / tracking_link / connection_accounts[].link 中优先挑 ^https?://。
 */
function pickFullTrackingLink(
  candidates: Array<string | null | undefined>,
): string {
  const valid = candidates
    .map((c) => (typeof c === "string" ? c.trim() : ""))
    .filter(Boolean);
  return valid.find((c) => /^https?:\/\//i.test(c)) || valid[0] || "";
}

const { Text } = Typography;

/**
 * 复制目标对象：每个 connection 对应一个账号 + 一个追踪链接
 */
export interface ConnectionAccount {
  id: string; // platform_connection.id
  account_name: string; // platform_connection.account_name（可读名称）
  platform: string; // platform_connection.platform
  link: string; // 该账号在该商家上的追踪链接（connection_campaign_links[id]）
}

export interface MerchantRowForNameCell {
  merchant_name: string;
  merchant_url?: string | null;
  campaign_link?: string | null;
  tracking_link?: string | null;
  /**
   * 由 API 解析后返回的、属于当前 user 的可用账号链接列表（多账号场景）
   * 单账号商家：长度 ≤ 1
   * 多账号商家：长度 ≥ 2，触发 Popover 选择
   */
  connection_accounts?: ConnectionAccount[];
}

function getFaviconUrl(merchantUrl: string | null | undefined): string | null {
  if (!merchantUrl) return null;
  try {
    const domain = new URL(merchantUrl.startsWith("http") ? merchantUrl : `https://${merchantUrl}`).hostname;
    return `https://www.google.com/s2/favicons?domain=${domain}&sz=128`;
  } catch {
    return null;
  }
}

function MerchantIcon({ rec }: { rec: MerchantRowForNameCell }) {
  const [failed, setFailed] = useState(false);
  const iconUrl = getFaviconUrl(rec.merchant_url);
  if (iconUrl && !failed) {
    return (
      // eslint-disable-next-line @next/next/no-img-element
      <img
        src={iconUrl}
        alt=""
        style={{ width: 22, height: 22, borderRadius: 4, objectFit: "contain", flexShrink: 0 }}
        onError={() => setFailed(true)}
      />
    );
  }
  return <ShopOutlined style={{ fontSize: 18, color: "#bfbfbf", flexShrink: 0 }} />;
}

export default function MerchantNameCell({
  rec,
  showIcon = true,
  fallbackName,
}: {
  rec: MerchantRowForNameCell;
  showIcon?: boolean;
  /** 当 merchant_name 为空时显示的兜底文本（如"未在我的商家库"） */
  fallbackName?: string;
}) {
  const { message } = App.useApp();
  const [popoverOpen, setPopoverOpen] = useState(false);

  const accounts: ConnectionAccount[] = Array.isArray(rec.connection_accounts) ? rec.connection_accounts : [];
  // BUG-01：单账号时也优先取完整 http URL（campaign_link / tracking_link / 账号链接里挑）
  const singleLink = pickFullTrackingLink([
    rec.campaign_link,
    rec.tracking_link,
    ...accounts.map((a) => a.link),
  ]);
  const isMultiAccount = accounts.length >= 2;

  const doCopy = async (link: string, accountName?: string) => {
    if (!link) {
      message.error("无可用追踪链接");
      return;
    }
    const ok = await copyTextToClipboard(link);
    if (!ok) {
      message.error("复制失败，请手动复制");
      return;
    }
    const tip = accountName ? `已复制 ${accountName} 的追踪链接` : "追踪链接已复制";
    message.success(`${tip}：${previewText(link)}`);
  };

  const onSingleCopy = (e: React.MouseEvent) => {
    e.stopPropagation();
    if (isMultiAccount) {
      setPopoverOpen(true);
      return;
    }
    doCopy(singleLink);
  };

  const popoverContent = (
    <div style={{ minWidth: 280, maxWidth: 420 }}>
      <div style={{ marginBottom: 8, fontSize: 12, color: "#666" }}>
        该商家在你名下有 {accounts.length} 个账号，请选择要复制的账号：
      </div>
      <Space direction="vertical" size={6} style={{ width: "100%" }}>
        {accounts.map((acc) => (
          <div
            key={acc.id}
            style={{
              display: "flex",
              alignItems: "center",
              justifyContent: "space-between",
              gap: 8,
              padding: "6px 8px",
              border: "1px solid #f0f0f0",
              borderRadius: 4,
              background: "#fafafa",
            }}
          >
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ fontWeight: 600, fontSize: 13 }}>
                {acc.account_name || acc.platform || acc.id}
              </div>
              <Text type="secondary" style={{ fontSize: 11, display: "block", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                {acc.link}
              </Text>
            </div>
            <Button
              size="small"
              type="primary"
              icon={<CopyOutlined />}
              onClick={(e) => {
                e.stopPropagation();
                doCopy(acc.link, acc.account_name || acc.platform);
                setPopoverOpen(false);
              }}
            >
              复制
            </Button>
          </div>
        ))}
      </Space>
    </div>
  );

  const showCopy = isMultiAccount || !!singleLink;

  return (
    <Space size={6}>
      {showIcon && <MerchantIcon rec={rec} />}
      <span style={{ fontWeight: 600 }}>
        {rec.merchant_name || fallbackName || "-"}
      </span>
      {showCopy && (
        <>
          {isMultiAccount ? (
            <Popover
              open={popoverOpen}
              onOpenChange={setPopoverOpen}
              trigger="click"
              placement="rightTop"
              content={popoverContent}
              title={null}
            >
              <Tooltip title={`复制追踪链接（${accounts.length} 个账号可选）`}>
                <CopyOutlined
                  style={{ color: "#1677ff", cursor: "pointer", fontSize: 13 }}
                  onClick={onSingleCopy}
                />
              </Tooltip>
            </Popover>
          ) : (
            <Tooltip title="复制追踪链接">
              <CopyOutlined
                style={{ color: "#1677ff", cursor: "pointer", fontSize: 13 }}
                onClick={onSingleCopy}
              />
            </Tooltip>
          )}
        </>
      )}
    </Space>
  );
}
