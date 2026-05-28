/**
 * D-046 / C-109 IntelliCenter — AI 智能化总体中台统一入口
 *
 * 详见设计方案"D-046 / C-109 — AI 智能化总体战略升级"+ "五、IntelliCenter MVP 详细方案"。
 *
 * 模块清单（12 个，分 3 层 - MVP 仅含 M2 商家智能画像）：
 *   【知识层 Knowledge】
 *     M1 PolicyKnowledgeBase    — D-042（政策知识库 4 大类 30+ 子项原文存档）
 *     M2 MerchantProfile        — D-046.A 本期 MVP（商家智能画像 12 字段）
 *     M3 MemoryStore            — D-046.B（Qdrant 历史记忆库）
 *   【运行层 Runtime】
 *     M4 MultiAgentOrchestrator — D-046.D（6 Agent 串行 pipeline）
 *     M5 PolicyHub              — D-041 P0 已部署 ✓ (lib/policy-hub)
 *     M6 PromptInjector         — D-046.C 阶段 3
 *     M7 ComplianceLinter       — D-044
 *     M8 KeywordEngine          — D-046.E（5 源融合）
 *     M9 ImageEngine            — D-046.E（CLIP + GPT-5V）
 *   【运营层 Operations】
 *     M10 ProactiveDecisionEngine — D-046.D（cron 每小时主动决策）
 *     M11 FeedbackLoop            — D-046.F（拒登 + CTR + 员工纠正全收）
 *     M12 PerformanceOptimizer    — D-046.G（预热/缓存/增量/并行）
 *
 * 注意：policy-hub 部署时在 lib/policy-hub/ 顶层（不嵌套入 intellicenter/）以保持 D-041 P0
 *      已部署引用不变。IntelliCenter 在需要时通过 `import "@/lib/policy-hub"` 引用。
 */

export * from "./merchant-profile";
