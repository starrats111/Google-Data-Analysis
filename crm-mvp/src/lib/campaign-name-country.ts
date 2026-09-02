/**
 * D-308：广告系列名称里的「国家段」与草稿国家的一致性校验（前后端共用的唯一口径）
 *
 * 背景（2026-09-02 蓝永培报障）：
 *   落地页证据引擎这条链路上，广告系列名是投手在广告预览页手打的（C-088 放开了自定义命名，
 *   且明确「不做格式校验，留给 Google Ads 处理」）。于是出现了名字写 `...-CA-0902-...`、
 *   草稿目标国家却是 US 的系列，照样能提交成功。
 *   Google 侧的定位一直是按 `campaigns.target_country` 下发的（没投错国家），但系列名是全站
 *   人看数据的第一入口——数据中心、Sheet、Hermes 报表都按名字认国家，名字骗人比投错还难排查。
 *
 * 判定原则（与 kyads `ad-create/publish-runner.ts` 同源）：
 *   名字里的国家段只是命名信息，**认不出来就放行**，只有「认出来了且与草稿国家冲突」才拦。
 *   宁可漏拦一个乱写的名字，也不能把一条正常的自定义命名卡死在发布前。
 *
 * 两种认法（按顺序，先命中先返回）：
 *   ① MMDD 锚点：命名规则 `序号-平台-商家-国家-日期(MMDD)-MID` 里，国家段永远紧挨着四位日期段。
 *      从四位数字段往前取一位，落在国家槽位（下标 ≥ 2）且是合法 ISO 码才算数——避免
 *      `made-in-0513` 这类普通短语把 `IN` 误判成印度。
 *   ② 段位兜底：C-088 允许投手把日期段改成 `CZS`（输入框提示语即如此），那种名字里没有四位
 *      数字，①  整段失效。此时只要还是标准六段格式（首段纯数字，与 campaign-naming.ts 的
 *      `isSystemCampaignName` 同一判据），就直接看第 4 段是不是国家代码。
 *
 * 本文件是**纯函数**，只依赖 lib/countries（D-288 的国家单一信源），不碰 prisma / next，
 * 因此广告预览页（client component）可以直接 import，前后端两道闸共用一套判定。
 */
import { isValidCountryCode, normalizeCountryCode } from "@/lib/countries";

export type CampaignNameCountryToken = {
  /** 名称里原样出现的国家段（已转大写），用于错误文案回显——UK 就显示 UK，不显示 GB */
  raw: string;
  /** 归一化后的国家代码（UK→GB），用于与草稿国家比对 */
  normalized: string;
  /** 认出这一段的方式，仅用于日志排障 */
  via: "mmdd_anchor" | "segment_position";
};

/** 命名分隔符：连字符为主，下划线 / 空格是投手手打时的常见变体 */
const NAME_SEPARATOR = /[-_\s]+/;

/**
 * 从广告系列名称中认出国家段；认不出返回 null（= 放行）
 */
export function extractCampaignNameCountryToken(
  campaignName: string | null | undefined,
): CampaignNameCountryToken | null {
  const name = String(campaignName ?? "").trim();
  if (!name) return null;

  // ① MMDD 锚点
  const tokens = name.split(NAME_SEPARATOR).map((t) => t.trim()).filter(Boolean);
  for (let i = 1; i < tokens.length; i += 1) {
    if (!/^\d{4}$/.test(tokens[i])) continue;
    const candidate = tokens[i - 1];
    if (i >= 3 && isValidCountryCode(candidate)) {
      return {
        raw: candidate.toUpperCase(),
        normalized: normalizeCountryCode(candidate),
        via: "mmdd_anchor",
      };
    }
  }

  // ② 段位兜底（日期段被改成 CZS 等非数字写法时）
  const parts = name.split("-");
  if (parts.length >= 6 && /^\d+$/.test(parts[0]) && isValidCountryCode(parts[3])) {
    return {
      raw: parts[3].trim().toUpperCase(),
      normalized: normalizeCountryCode(parts[3]),
      via: "segment_position",
    };
  }

  return null;
}

export type CampaignNameCountryCheck =
  | { ok: true }
  | { ok: false; message: string; nameCountry: string; draftCountry: string; via: CampaignNameCountryToken["via"] };

/**
 * 校验自定义广告系列名称中的国家代码与草稿国家一致。
 *
 * 放行的三种情况：名字为空（= 走自动命名）、草稿国家本身不是合法码、名字里认不出国家段。
 */
export function validateCampaignNameCountry(input: {
  campaignName: string | null | undefined;
  draftCountryCode: string | null | undefined;
}): CampaignNameCountryCheck {
  const token = extractCampaignNameCountryToken(input.campaignName);
  if (!token) return { ok: true };

  const draftCountry = normalizeCountryCode(input.draftCountryCode);
  if (!isValidCountryCode(draftCountry)) return { ok: true };
  if (token.normalized === draftCountry) return { ok: true };

  return {
    ok: false,
    message: `广告系列名称中的国家代码 ${token.raw} 与草稿国家 ${draftCountry} 不一致，请选择正确草稿或修改广告系列名称后再发布。`,
    nameCountry: token.raw,
    draftCountry,
    via: token.via,
  };
}
