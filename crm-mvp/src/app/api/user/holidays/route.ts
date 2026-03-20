import { NextRequest } from "next/server";
import { getUserFromRequest, serializeData } from "@/lib/auth";
import { apiSuccess, apiError } from "@/lib/constants";
import prisma from "@/lib/prisma";
import { nowCST } from "@/lib/date-utils";

// 查询节日
export async function GET(req: NextRequest) {
  const user = getUserFromRequest(req);
  if (!user) return apiError("未授权", 401);

  const { searchParams } = new URL(req.url);
  const country = searchParams.get("country") || "";

  if (!country) return apiError("请输入国家代码");

  const cstNow = nowCST();
  const today = cstNow.toDate();
  const futureDate = cstNow.add(180, "day").toDate();

  console.log(`[holidays] country=${country}, today=${today.toISOString()}, futureDate=${futureDate.toISOString()}`);

  const holidays = await prisma.holiday_calendar.findMany({
    where: {
      country_code: country.toUpperCase(),
      holiday_date: { gte: today, lte: futureDate },
      is_deleted: 0,
    },
    orderBy: { holiday_date: "asc" },
  });

  console.log(`[holidays] found ${holidays.length} holidays`);
  if (holidays.length > 0) console.log(`[holidays] first: ${JSON.stringify(holidays[0], (k,v) => typeof v === 'bigint' ? Number(v) : v)}`);

  return apiSuccess(serializeData(holidays));
}
