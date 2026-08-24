/**
 * D-275.1 银行流水双口径解析
 *
 * 同一套银行流水接口（列表/登记/预填/候选/导出）按调用人角色分两个口径：
 * - 组长（role=leader）：团队口径 —— 组长清单的卡（owner_user_id IS NULL）、全组成员的打款明细，
 *   即 R-07 原有行为；组员个人卡（owner_user_id 非空）的卡与流水一律排除，防止两边混账。
 * - 组员（role=user）：个人口径 —— 只有自己在「收款方式」自填的卡（owner_user_id = 我）、
 *   只预填/候选自己的打款记录、只导出自己的流水（yz 组自管模式）。
 *
 * 期初余额沿用 report_overrides（scope_key=bank_open:{methodId}，按登记人 user_id 隔离），
 * 组长与组员各存各的，天然不冲突。
 */
import prisma from "@/lib/prisma";
import type { TokenPayload } from "@/lib/auth";

export interface BankFlowScope {
  /** true=组员个人口径；false=组长团队口径 */
  personal: boolean;
  teamId: bigint;
  userId: bigint;
  /** 本口径可用收款方式的 where 片段（叠加 is_deleted 由调用方控制） */
  methodWhere: { team_id: bigint; owner_user_id: bigint | null };
}

/** 解析口径；未关联小组返回 null */
export async function resolveBankFlowScope(user: TokenPayload): Promise<BankFlowScope | null> {
  let teamId: bigint | null = user.teamId ? BigInt(user.teamId) : null;
  if (!teamId) {
    const u = await prisma.users.findFirst({
      where: { id: BigInt(user.userId), is_deleted: 0 },
      select: { team_id: true },
    });
    teamId = u?.team_id ?? null;
  }
  if (!teamId) return null;

  const personal = user.role !== "leader";
  const userId = BigInt(user.userId);
  return {
    personal,
    teamId,
    userId,
    methodWhere: { team_id: teamId, owner_user_id: personal ? userId : null },
  };
}

/**
 * 本口径的流水条目 where 片段（叠加到 month / is_deleted 之上）。
 * 归属靠 payment_method_id 指向的卡区分（含已软删的卡，保证历史条目不丢显示）：
 * - 个人口径：只取指向本人自填卡的条目；
 * - 团队口径：排除指向组员个人卡的条目。
 */
export async function scopeEntryWhere(scope: BankFlowScope): Promise<Record<string, unknown>> {
  if (scope.personal) {
    const mine = await prisma.payment_methods.findMany({
      where: { owner_user_id: scope.userId },
      select: { id: true },
    });
    return { team_id: scope.teamId, payment_method_id: { in: mine.map((m) => m.id) } };
  }
  const personalCards = await prisma.payment_methods.findMany({
    where: { team_id: scope.teamId, owner_user_id: { not: null } },
    select: { id: true },
  });
  return {
    team_id: scope.teamId,
    ...(personalCards.length > 0
      ? { payment_method_id: { notIn: personalCards.map((m) => m.id) } }
      : {}),
  };
}

/** 明细成员集合：团队口径=全组成员；个人口径=仅本人 */
export async function scopeMembers(
  scope: BankFlowScope,
): Promise<{ id: bigint; username: string; display_name: string | null }[]> {
  if (scope.personal) {
    const me = await prisma.users.findFirst({
      where: { id: scope.userId, is_deleted: 0 },
      select: { id: true, username: true, display_name: true },
    });
    return me ? [me] : [];
  }
  return prisma.users.findMany({
    where: { team_id: scope.teamId, is_deleted: 0, role: { not: "admin" } },
    select: { id: true, username: true, display_name: true },
  });
}

/** 提示文案里的主语（「组员打款记录」/「本人打款记录」） */
export const scopeNoun = (scope: BankFlowScope) => (scope.personal ? "本人" : "组员");
