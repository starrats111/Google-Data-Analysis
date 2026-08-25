"use client";

import AccountStatusBoard from "@/components/AccountStatusBoard";

/** D-277：账户状态总览（管理员看全部 MCC 的账户） */
export default function AdminAccountStatusPage() {
  return <AccountStatusBoard endpoint="/api/admin/account-status" />;
}
