/**
 * 连接失败的性质判定（纯函数，无 DB 依赖，前后端共用）。
 *
 * 从 connection-health.ts 拆出来的原因（D-300，2026-08-29 RW 误报）：
 * 这套判据原本只存在于服务端，前端 settings 页为了改文案又手抄了一份正则，
 * 注释写着「与后端 classifyConnFailure 同源」，实际两边早就长歪了——
 * 后端认 `\b50[234]\b`，前端认 `timeout|超时`，谁都不认 Cloudflare 的 524，
 * 于是「网关把我们的请求掐了」在界面上显示成「该连接 API Key 已失效」。
 * 判据只能有一份，且必须是前端 import 得动的（connection-health 顶部 import prisma）。
 * 连**文案**也放在这里（describeConnFailure）——上一版就是文案分家才长歪的。
 *
 * 分错方向的代价不对称，两边都很隐蔽：
 *   - 网络/网关问题判成密钥失效：组员反复重配一个本来有效的 Key，真因没人看得见；
 *   - 真失效判成网络问题：连接一直红不了，没人去换 Key，佣金数据静默断流。
 *
 * D-303（2026-09-01 RW 全线断流）补的第三类 `platform`：
 *   RW 把 status 参数改成大小写敏感，我们发的 "all" 一律被回
 *   `{status:{code:1003,msg:"Missing required parameters or incorrect format"}}`，
 *   全部 RW 连接同一刻集体转 error。这既不是密钥问题也不是网络问题，
 *   是**平台拒绝了我们的请求**——只有改代码能修，让用户重配密钥 100% 是白费力气。
 *   旧的三分类把它落进 unknown，而 UI 对 unknown 的默认动作就是「说密钥失效」，
 *   于是 D-300 那套修复部署了也照样冤枉 wj11。默认动作本身就是错的，一并改掉。
 */

/** 平台明确拒绝凭据——只有这类才是真的「API Key 失效」 */
export const AUTH_ERROR_RE =
  /invalid[ _-]?token|token[ _-]?(invalid|expired|error)|unauthor|forbidden|\b40[13]\b|api[ _-]?key.*(invalid|error|失效|无效)|签名错误|sign[ _-]?error|鉴权|认证失败/i;

/**
 * 本机、网关或对端的瞬时问题——不能据此判定密钥失效。
 *
 * D-300 相对 D-220 扩了两类，都是那次 RW 事故里踩到的：
 *   1. `\b5\d{2}\b` 取代 `\b50[234]\b`：5xx 按定义就是服务端的事，
 *      尤其 Cloudflare 自有的 520~527（524 = 源站超时，RW/LH 都挂在 CF 后面）
 *      旧正则一个都不认，全落进 unknown。
 *   2. 非 JSON 正文：网关错误页是 HTML，`resp.json()` 抛的是
 *      "Unexpected token '<' ... is not valid JSON"，既没有状态码也没有平台名，
 *      旧正则同样认不出来。
 * 误判进 transient 的代价很小（阈值同为 10 次，只是文案说「暂时拉不通」），
 * 所以这里宁可放宽——auth 判据在前，真失效不会被这几条抢走。
 */
export const TRANSIENT_ERROR_RE =
  /fetch failed|UND_ERR|ETIMEDOUT|ECONNRESET|ECONNREFUSED|ENOTFOUND|EAI_AGAIN|EPROTO|socket hang up|network|timeout|超时|aborted|The operation was aborted|\b5\d{2}\b|bad gateway|gateway|网关|系统性故障|max retries exceeded|is not valid JSON|Unexpected token|Unexpected end of JSON|JSON\.parse|SyntaxError|<!DOCTYPE|<html|非 ?JSON/i;

/**
 * D-303：平台业务错误的统一标记。
 *
 * 「靠英文散文匹配错误性质」正是 D-300 翻车的根因，所以这次在**产生错误的地方**
 * 就把平台回的业务码贴上标记（见 platform-api.ts 的 platformBizError），
 * 判定只认标记，不再猜措辞。下面那条散文正则只是兜底：
 * 库里已经躺着的历史 last_error（本次事故 295 条）没有标记，也得认出来。
 */
export const PLATFORM_BIZ_ERROR_TAG = "平台业务错误";

/** 把平台回的业务错误码贴上标记，供 classifyConnFailure 精确识别 */
export function platformBizError(platform: string, code: string | number, msg: string): string {
  return `${platform}: [${PLATFORM_BIZ_ERROR_TAG} ${code}] ${msg}`;
}

/**
 * 联盟 api.php / SaaS 系已知的业务错误措辞（没贴标记的历史数据兜底）。
 * 来源：CG 错误码表 1000/1002/1006/10001、RW 1003（2026-09-01 实测）、C-029 AD 50003。
 * 注意「Invalid token」(1001) 不在这里——它归 auth，且 auth 判据在前。
 */
export const PLATFORM_ERROR_RE =
  /missing required parameter|incorrect format|invalid parameter|parameter (error|invalid)|publisher does not exist|does not exist|call frequency too high|frequency too high|rate limit|too many requests|time span cannot exceed|cannot exceed \d+ days|查询时间跨度|参数(错误|缺失|不合法)|缺少必需参数/i;

export type ConnFailureKind = "auth" | "platform" | "transient" | "unknown";

export function classifyConnFailure(errorMsg: string): ConnFailureKind {
  const m = errorMsg || "";
  // 顺序有意义：
  // 1) auth 最先——平台常把 401 包在一段普通文案里，也可能带着业务码一起回
  //    （如 `[平台业务错误 1001] Invalid token` 必须判 auth 而不是 platform）；
  // 2) platform 次之——它自带业务码，比下面按数字猜的 transient 更可信
  //    （否则一个业务码 502 会被 `\b5\d{2}\b` 抢走）；
  // 3) transient 最后兜网络/网关。
  if (AUTH_ERROR_RE.test(m)) return "auth";
  if (m.includes(PLATFORM_BIZ_ERROR_TAG) || PLATFORM_ERROR_RE.test(m)) return "platform";
  if (TRANSIENT_ERROR_RE.test(m)) return "transient";
  return "unknown";
}

/** UI 文案用：这条 last_error 是不是「已知与密钥无关」（网络类或平台类） */
export function isNonKeyFailure(errorMsg: string): boolean {
  const kind = classifyConnFailure(errorMsg);
  return kind === "transient" || kind === "platform";
}

/**
 * D-303 连接卡片的展示口径——文案与判据同源，前端不许再手写分支。
 *
 * `showReconfigure` 是这次真正要改的东西：旧代码只有「transient 才不劝重配」，
 * 剩下全都弹「该连接 API Key 已失效」+ 红色重配按钮，包括压根没判出性质的 unknown。
 * 「不知道原因」和「密钥失效」是两回事，把前者说成后者就是 wj11 反复重配的由来。
 */
export interface ConnFailureView {
  kind: ConnFailureKind;
  /** antd Alert 的 type */
  alertType: "error" | "warning";
  /** Alert 标题 */
  title: string;
  /** 标题下的一句话行动指引 */
  hint: string;
  /** 是否给「重新配置 API Key」按钮——只有确实该换 Key 时才给 */
  showReconfigure: boolean;
}

export function describeConnFailure(errorMsg: string): ConnFailureView {
  const kind = classifyConnFailure(errorMsg);
  switch (kind) {
    case "auth":
      return {
        kind,
        alertType: "error",
        title: "该连接 API Key 已失效",
        hint: "平台明确拒绝了这把密钥，请到平台后台重新生成并粘贴进来。",
        showReconfigure: true,
      };
    case "platform":
      return {
        kind,
        alertType: "warning",
        title: "平台拒绝了我们的请求（不是密钥问题）",
        hint: "平台改了接口口径或在限流，重配密钥没有用——这类只能由开发改代码修复，请把这条错误发给管理员。",
        showReconfigure: false,
      };
    case "transient":
      return {
        kind,
        alertType: "warning",
        title: "暂时拉不通（网络/服务器问题，非密钥失效）",
        hint: "重配密钥无用，请先点上方「测试连接」确认；持续异常请联系管理员查服务器。",
        showReconfigure: false,
      };
    default:
      return {
        kind,
        alertType: "error",
        title: "同步失败（原因未归类）",
        hint: "还没法断定是密钥、平台还是网络的问题。请先点上方「测试连接」看当场结论，并把这条错误发给管理员；只有你确认平台后台那把 Key 换过，才需要重配。",
        showReconfigure: false,
      };
  }
}

/**
 * D-300 保存门禁：「测试通过才能保存」按失败性质分档。
 *
 * 原门禁是一刀切——没测通过就不让存。它拦得住「填错 Key」，但也拦住了
 * 「刚从平台后台生成了一把新 Key，偏巧平台这会儿抽风」的人：测不过、存不了，
 * 手里拿着有效凭据干等（2026-08-29 RW kaizenflowshop 现场）。
 * 网关/网络/平台口径类失败本来就证明不了这把 Key 好不好，拿它当拦阻条件是无效的。
 *
 * 分档：
 *   - 没换 Key / 测过且通过 → 直接放行
 *   - 平台明确拒绝凭据（auth）→ 硬拦。这是唯一一种「已知这把 Key 是坏的」，
 *     存进去只会让后续同步继续撞墙，还把连接刷成 error。
 *   - 压根没测过 → 硬拦，保留原有的「先测一下」习惯
 *   - 其余（平台业务错误/网关/网络/认不出）→ 二次确认后放行，且必须以「未验证」状态入库
 */
export type SaveGate =
  | { allow: "yes" }
  | { allow: "confirm"; reason: string }
  | { allow: "no"; reason: string };

export function decideSaveGate(input: {
  /** 编辑既有连接且没动 API Key——本来就不是新凭据，不该拦 */
  keyUnchanged: boolean;
  /** 最近一次测试是否通过 */
  testPassed: boolean;
  /** 最近一次测试的失败性质；从未测过传 undefined */
  lastFailureKind?: ConnFailureKind;
}): SaveGate {
  if (input.keyUnchanged || input.testPassed) return { allow: "yes" };
  if (input.lastFailureKind === undefined) {
    return { allow: "no", reason: "请先点击「测试连接」验证 API Key 后再保存" };
  }
  if (input.lastFailureKind === "auth") {
    return {
      allow: "no",
      reason: "平台明确拒绝了这把 API Key（不是网络问题）。请到平台后台重新生成，再粘贴进来测试。",
    };
  }
  if (input.lastFailureKind === "platform") {
    return {
      allow: "confirm",
      reason: "这次没测通过是平台拒绝了我们的请求（接口口径变了或在限流），跟这把 Key 无关。可以先存下来，但它会以「待验证」状态入库，等开发修好后自检会自动确认。",
    };
  }
  return {
    allow: "confirm",
    reason: "这次没测通过是平台侧慢或网络不通，证明不了这把 Key 好不好。可以先存下来，但它会以「待验证」状态入库，等自检或你手动重测确认。",
  };
}
