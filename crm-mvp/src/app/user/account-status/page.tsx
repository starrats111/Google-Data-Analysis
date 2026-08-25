"use client";

import AccountStatusBoard from "@/components/AccountStatusBoard";

/** D-277：账户状态总览（成员看自己名下 MCC，组长看全组） */
export default function AccountStatusPage() {
  return <AccountStatusBoard endpoint="/api/user/account-status" />;
}
