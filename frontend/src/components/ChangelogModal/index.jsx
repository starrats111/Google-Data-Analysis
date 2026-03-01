import React, { useState } from 'react';
import { Modal, Tag, Collapse, Button, Typography, Space, Divider } from 'antd';
import { RocketOutlined, ToolOutlined, BugOutlined } from '@ant-design/icons';
import { changelog } from '../../config/changelog';

const { Title, Text } = Typography;

const CHANGELOG_STORAGE_KEY = 'changelog_last_seen';

// 类型 → 颜色 + 图标
const typeConfig = {
  feature: { color: 'green', icon: <RocketOutlined />, label: '新增' },
  improve: { color: 'blue', icon: <ToolOutlined />, label: '优化' },
  fix:     { color: 'orange', icon: <BugOutlined />, label: '修复' },
};

/** 检查是否有未读更新 */
export function hasUnreadChangelog() {
  if (!changelog.length) return false;
  const lastSeen = localStorage.getItem(CHANGELOG_STORAGE_KEY);
  return lastSeen !== changelog[0].version;
}

/** 标记当前版本为已读 */
export function markChangelogRead() {
  if (changelog.length) {
    localStorage.setItem(CHANGELOG_STORAGE_KEY, changelog[0].version);
  }
}

/** 渲染单个版本的内容 */
function VersionContent({ entry }) {
  return (
    <div>
      {entry.sections.map((section, sIdx) => (
        <div key={sIdx} style={{ marginBottom: sIdx < entry.sections.length - 1 ? 12 : 0 }}>
          {section.items.map((item, iIdx) => {
            const cfg = typeConfig[section.type] || typeConfig.feature;
            return (
              <div key={iIdx} style={{ display: 'flex', alignItems: 'flex-start', gap: 8, marginBottom: 6 }}>
                <Tag color={cfg.color} style={{ flexShrink: 0, margin: 0 }}>
                  {cfg.icon} {cfg.label}
                </Tag>
                <Text style={{ lineHeight: '22px' }}>{item}</Text>
              </div>
            );
          })}
        </div>
      ))}
    </div>
  );
}

export default function ChangelogModal({ open, onClose }) {
  const [historyOpen, setHistoryOpen] = useState(false);

  if (!changelog.length) return null;

  const latest = changelog[0];
  const history = changelog.slice(1);

  const handleClose = () => {
    markChangelogRead();
    onClose?.();
  };

  // 历史版本折叠面板
  const historyItems = history.map((entry) => ({
    key: entry.version,
    label: (
      <Space>
        <Text strong>v{entry.version}</Text>
        <Text type="secondary">{entry.date}</Text>
        <Text type="secondary">—</Text>
        <Text>{entry.title}</Text>
      </Space>
    ),
    children: <VersionContent entry={entry} />,
  }));

  return (
    <Modal
      title={
        <Space>
          <RocketOutlined style={{ color: '#1677ff' }} />
          <span>更新日志</span>
        </Space>
      }
      open={open}
      onCancel={handleClose}
      width={560}
      footer={
        <Button type="primary" onClick={handleClose} block>
          我知道了
        </Button>
      }
      styles={{
        body: {
          maxHeight: '60vh',
          overflowY: 'auto',
          padding: '16px 24px',
        },
      }}
    >
      {/* 最新版本 */}
      <div style={{ marginBottom: 16 }}>
        <div style={{ display: 'flex', alignItems: 'baseline', gap: 12, marginBottom: 4 }}>
          <Title level={4} style={{ margin: 0 }}>v{latest.version}</Title>
          <Text type="secondary">{latest.date}</Text>
        </div>
        <Title level={5} style={{ margin: '4px 0 16px' }}>{latest.title}</Title>
        <VersionContent entry={latest} />
      </div>

      {/* 历史版本 */}
      {history.length > 0 && (
        <>
          <Divider style={{ margin: '12px 0' }} />
          <Collapse
            ghost
            activeKey={historyOpen ? history.map((e) => e.version) : []}
            onChange={(keys) => setHistoryOpen(keys.length > 0)}
            items={[
              {
                key: '__history__',
                label: <Text type="secondary">查看历史版本（{history.length} 个）</Text>,
                children: <Collapse ghost items={historyItems} />,
              },
            ]}
          />
        </>
      )}
    </Modal>
  );
}
