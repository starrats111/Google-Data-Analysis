"use client";

import React from "react";
import { Select, Tooltip } from "antd";
import type { SelectProps } from "antd";

export type PublishSite = {
  id: string | number;
  site_name: string;
  domain: string;
  status: string;
  verified: number;
  is_deleted: number;
};

type PublishSiteSelectProps = Omit<SelectProps, "options"> & {
  sites: PublishSite[];
};

export default function PublishSiteSelect({
  sites,
  placeholder,
  ...rest
}: PublishSiteSelectProps) {
  const visible = (sites ?? []).filter((s) => Number(s.is_deleted) === 0);

  const options = visible.map((s) => {
    let disabled = false;
    let reason: string | undefined;
    if (Number(s.verified) === 0) {
      disabled = true;
      reason = "站点未验证";
    } else if (s.status !== "active") {
      disabled = true;
      reason = "站点已停用";
    }
    return {
      value: String(s.id),
      label: `${s.site_name} (${s.domain})`,
      disabled,
      reason,
      _search: `${s.site_name} ${s.domain}`.toLowerCase(),
    };
  });

  return (
    <Select
      showSearch
      allowClear
      placeholder={placeholder ?? "搜索站点名或域名"}
      optionLabelProp="label"
      filterOption={(input, option) => {
        const text = (option as unknown as { _search?: string })?._search ?? "";
        return text.includes(input.toLowerCase());
      }}
      optionRender={(option) => {
        const disabled = (option as unknown as { disabled?: boolean }).disabled;
        const reason = (option as unknown as { reason?: string }).reason;
        const content = option.label as React.ReactNode;
        if (disabled && reason) {
          return (
            <Tooltip title={reason} placement="right">
              <span style={{ opacity: 0.5 }}>{content}</span>
            </Tooltip>
          );
        }
        return content;
      }}
      options={options}
      {...rest}
    />
  );
}
