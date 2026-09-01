import { NextRequest } from "next/server";
import { apiSuccess, apiError } from "@/lib/constants";
import { verifyHermesToken } from "@/lib/hermes-auth";
import { pickProvider } from "@/lib/suffix-engine/proxy-provider";
import { decryptPassword } from "@/lib/crypto";

// HM-D79 / D-306：把「换链接用哪个住宅代理」这件事交回 CRM 说了算。
//
// 起因：2026-08-28 CRM 把 kookeey 置 is_deleted=1 换成 tnbproxy，而 Hermes 的 .env 里
// 那份 2026-07 手抄的 PROXY_* 副本没人跟着改。Hermes 的跟链从那天 02:00 起 100% 卡在
// stuck_on_tracker，后缀池归零；后缀又是建任务的硬门槛，于是 8-27 发完存量后整整一周
// 一条新广告都建不出来——而 waitlist_replenish 每轮仍旧 ok=1 上报 {built:0}，日志全绿。
//
// 根因是「配置副本不会自动跟随」，不是某一次抄错，所以修法是取消副本：Hermes 改成向这里
// 取供应商配置。选路直接复用 pickProvider（换链接场景 + priority 升序 + 跳过熔断中的），
// 与 CRM 自己换链接走的是同一个决策，供应商一换两边同时生效。
//
// 为什么回传的是「配置」而不是「组装好的 URL」：URL 里的 {session:N} 每次调用都必须换新，
// 换出口 IP 才能拿到新 clickid。若由本接口代发，Hermes 每生成一条后缀就要跨公网调一次
// （每小时数百次）。回传配置让 Hermes 本地缓存 ~10 分钟、自己滚 session，既保住轮换语义
// 又把调用量压到每 10 分钟一次。
//
// 只读、不写库。密码用 HTTPS + Bearer HERMES_API_TOKEN 传，与 /api/hermes/* 其余接口同级。

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  const denied = verifyHermesToken(req);
  if (denied) return denied;

  let provider;
  try {
    // userId 传 null：Hermes 是独立投放体，不走 kyads_proxy_users 的多租户分配，取全局健康池
    provider = await pickProvider(null);
  } catch (e) {
    return apiError(
      `选取代理供应商失败: ${e instanceof Error ? e.message : String(e)}`,
      500,
    );
  }

  if (!provider) {
    // 池子空 / 全部熔断。Hermes 端会继续用上一份缓存，不会因为这一下就断供。
    return apiError("换链接场景当前没有可用的代理供应商（全空或全部熔断）", 503);
  }

  const password = decryptPassword(provider.password || "");
  if (!provider.username_template || !password) {
    return apiError(
      `供应商 ${provider.name} 的用户名模板或密码为空，无法组装代理`,
      503,
    );
  }

  return apiSuccess({
    name: provider.name,
    host: provider.host,
    port: Number(provider.port),
    // socks5（跟链 HTTP 链路）/ http（无头浏览器兜底）由 Hermes 按用途各自组装，这里给原始类型
    proxy_type: (provider.proxy_type || "socks5").toLowerCase(),
    username_template: provider.username_template,
    password,
    // ⚠️ 必须带上：Hermes 原来把 GB 硬编码成 UK（kookeey 的方言），而 tnbproxy 要的是 GB。
    // 少了这张表，换供应商后 GB 广告的跟链会静默全挂。
    country_code_map: (provider.country_code_map ?? null) as Record<string, string> | null,
    picked_at: new Date().toISOString(),
  });
}
