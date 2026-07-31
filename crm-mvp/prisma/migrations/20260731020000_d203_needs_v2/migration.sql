-- D-203 记住「这条系列必须走 V2 跟跳引擎」。
--
-- 病灶（D-203 实测）：LB/CG 一族的跳板不发 302，而是返回一个几百字节的 HTML，跳转写在
-- `<script>location.replace(u)</script>` 里。V1 的 fetchChain 不执行 JS，走到跳板就停；
-- 而跳板的 `?url=` 参数恰好是裸商家域名，被 sameRootDomain 判成「已到商家站」，
-- 于是得出 no_tracking —— 链接明明是活的，被判成了死的。
-- 10 条系列的真实解析器基准：V1 记账 0/10，V2（kylink 引擎，会执行内联 JS + 维护 Cookie Jar
-- + 逐跳带 Referer）把原始报案系列 214-LB2-jwpei 跟通，且全程没开浏览器。
--
-- 为什么必须落库而不是每轮现算：no_tracking 判定卡死后会用 V2 复验一次，复验跟通就说明
-- 「不是链接死、是 V1 跟不动」，此时要清零 suffix_no_tracking_streak 解除长冷却。但灰度闸门
-- 正是按 streak 选 V2 的，streak 一归零下轮就掉回 V1、再次失败、streak 再爬到阈值——
-- 形成每 3 轮烧一次复验且永远不出货的循环。故把结论记成独立标记，与 suffix_needs_browser 同构。
--
-- 清零时机：人工换链接（旧链接的结论对新链接无意义），见 action/route.ts。
ALTER TABLE `campaigns`
  ADD COLUMN `suffix_needs_v2` TINYINT NOT NULL DEFAULT 0 AFTER `suffix_no_tracking_streak`;
