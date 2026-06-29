/**
 * 刷点击「真人自然点击」排程与指纹工具（移植自 kylink click-task-service）
 *
 * 目标：把 N 次点击按「目标国本地时区的人类作息曲线」分散排程到当天剩余时间，
 * 由 cron 到期逐条执行，并为每次点击随机化 User-Agent / Referer，
 * 模拟真实用户的浏览节奏，而非瞬间把 N 次刷完。
 */

/**
 * 小时权重表（0-23）：值越大该小时被分配的点击越多。
 * 规律：凌晨极低、上午渐增、下午高位、晚间峰值。
 */
const HOUR_WEIGHTS: number[] = [
  0.1, 0.05, 0.02, 0.02, 0.03, 0.05, // 00-05
  0.15, 0.4, 0.8, 1.2, 1.5, 1.6, // 06-11
  1.3, 1.4, 1.6, 1.7, 1.8, 1.9, // 12-17
  2.0, 2.2, 2.0, 1.6, 1.0, 0.5, // 18-23
]

/** 真实浏览器 User-Agent 库 */
export const USER_AGENTS: string[] = [
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/119.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Windows NT 11.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/119.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:121.0) Gecko/20100101 Firefox/121.0',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:120.0) Gecko/20100101 Firefox/120.0',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:122.0) Gecko/20100101 Firefox/122.0',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10.15; rv:121.0) Gecko/20100101 Firefox/121.0',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10.15; rv:120.0) Gecko/20100101 Firefox/120.0',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.2 Safari/605.1.15',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.1 Safari/605.1.15',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.6 Safari/605.1.15',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36 Edg/120.0.0.0',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/119.0.0.0 Safari/537.36 Edg/119.0.0.0',
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/119.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Linux; Android 14; SM-S918B) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.6099.210 Mobile Safari/537.36',
  'Mozilla/5.0 (iPhone; CPU iPhone OS 17_2 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/120.0.6099.119 Mobile/15E148 Safari/604.1',
  'Mozilla/5.0 (iPhone; CPU iPhone OS 17_2 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.2 Mobile/15E148 Safari/604.1',
  'Mozilla/5.0 (iPad; CPU OS 17_2 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.2 Mobile/15E148 Safari/604.1',
]

/** 随机 Referer 来源（含直接访问空串） */
export const REFERERS: string[] = [
  'https://www.google.com/',
  'https://www.google.com/search?q=best+deals',
  'https://www.google.com/search?q=online+shopping',
  'https://www.google.com/search?q=discount+coupon',
  'https://www.bing.com/',
  'https://www.bing.com/search?q=best+deals',
  'https://t.co/',
  'https://www.facebook.com/',
  'https://www.reddit.com/',
  'https://www.youtube.com/',
  'https://www.instagram.com/',
  'https://www.pinterest.com/',
  '',
]

export function randomPick<T>(arr: T[]): T {
  return arr[Math.floor(Math.random() * arr.length)]
}

export function randomInt(min: number, max: number): number {
  return Math.floor(Math.random() * (max - min + 1)) + min
}

/** 国家代码 → 主要 IANA 时区 */
const COUNTRY_TIMEZONE_MAP: Record<string, string> = {
  US: 'America/New_York', CA: 'America/Toronto', MX: 'America/Mexico_City',
  GB: 'Europe/London', UK: 'Europe/London', DE: 'Europe/Berlin', FR: 'Europe/Paris',
  IT: 'Europe/Rome', ES: 'Europe/Madrid', NL: 'Europe/Amsterdam', BE: 'Europe/Brussels',
  AT: 'Europe/Vienna', CH: 'Europe/Zurich', SE: 'Europe/Stockholm', NO: 'Europe/Oslo',
  DK: 'Europe/Copenhagen', FI: 'Europe/Helsinki', PL: 'Europe/Warsaw', CZ: 'Europe/Prague',
  PT: 'Europe/Lisbon', IE: 'Europe/Dublin', GR: 'Europe/Athens', RO: 'Europe/Bucharest',
  HU: 'Europe/Budapest',
  JP: 'Asia/Tokyo', KR: 'Asia/Seoul', CN: 'Asia/Shanghai', HK: 'Asia/Hong_Kong',
  TW: 'Asia/Taipei', SG: 'Asia/Singapore', AU: 'Australia/Sydney', NZ: 'Pacific/Auckland',
  IN: 'Asia/Kolkata', TH: 'Asia/Bangkok', VN: 'Asia/Ho_Chi_Minh', MY: 'Asia/Kuala_Lumpur',
  PH: 'Asia/Manila', ID: 'Asia/Jakarta',
  AE: 'Asia/Dubai', SA: 'Asia/Riyadh', KW: 'Asia/Kuwait', QA: 'Asia/Qatar',
  IL: 'Asia/Jerusalem', TR: 'Europe/Istanbul',
  BR: 'America/Sao_Paulo', AR: 'America/Argentina/Buenos_Aires', CL: 'America/Santiago',
  CO: 'America/Bogota', PE: 'America/Lima',
  ZA: 'Africa/Johannesburg', NG: 'Africa/Lagos', EG: 'Africa/Cairo', KE: 'Africa/Nairobi',
  RU: 'Europe/Moscow', UA: 'Europe/Kiev',
}

/** 取目标国当前本地小时（0-23），未知国家回退 UTC */
function getLocalHour(countryCode: string, utcDate: Date): number {
  const tz = COUNTRY_TIMEZONE_MAP[countryCode.toUpperCase()]
  if (!tz) return utcDate.getUTCHours()
  try {
    const formatter = new Intl.DateTimeFormat('en-US', { timeZone: tz, hour: 'numeric', hour12: false })
    const parts = formatter.formatToParts(utcDate)
    const hourPart = parts.find((p) => p.type === 'hour')
    return hourPart ? parseInt(hourPart.value, 10) : utcDate.getUTCHours()
  } catch {
    return utcDate.getUTCHours()
  }
}

/**
 * 生成按人类作息曲线分布的点击时间计划（绝对 UTC Date 数组，已排序）。
 *
 * 算法：从「现在」到「目标国当日 23:59」按 HOUR_WEIGHTS 分配点击数，每个小时内随机散布。
 * 若已过当地 23 点，则全部安排在 1 分钟内随机执行（保证「当天完成」）。
 *
 * @param count 点击数
 * @param countryCode 目标国（决定按哪个时区的作息分布）
 * @param startTime 起始时间（默认现在，UTC）
 */
export function generateClickSchedule(count: number, countryCode?: string, startTime?: Date): Date[] {
  const now = startTime || new Date()
  const country = (countryCode || '').toUpperCase()
  if (count <= 0) return []

  const localHourNow = country ? getLocalHour(country, now) : now.getHours()
  const remainingHours = 23 - localHourNow

  // 已过当地 23 点：1 分钟内随机散开
  if (remainingHours < 0) {
    return Array.from({ length: count }, () => new Date(now.getTime() + randomInt(1000, 60000))).sort(
      (a, b) => a.getTime() - b.getTime(),
    )
  }

  interface TimeSlot { startMs: number; endMs: number; weight: number }
  const slots: TimeSlot[] = []

  for (let h = localHourNow; h <= 23; h++) {
    const hourOffset = h - localHourNow
    let slotStartMs: number
    if (h === localHourNow) {
      slotStartMs = 0
    } else {
      const msIntoCurrentHour = now.getMinutes() * 60000 + now.getSeconds() * 1000 + now.getMilliseconds()
      const msToNextHour = 3600000 - msIntoCurrentHour
      slotStartMs = msToNextHour + (hourOffset - 1) * 3600000
    }
    const slotEndMs =
      slotStartMs +
      (h === localHourNow
        ? 3600000 - (now.getMinutes() * 60000 + now.getSeconds() * 1000 + now.getMilliseconds())
        : 3600000)
    if (slotEndMs <= slotStartMs) continue
    const availableRatio = (slotEndMs - slotStartMs) / 3600000
    slots.push({ startMs: slotStartMs, endMs: slotEndMs, weight: HOUR_WEIGHTS[h] * availableRatio })
  }

  if (slots.length === 0) {
    return Array.from({ length: count }, () => new Date(now.getTime() + randomInt(100, 500)))
  }

  const totalWeight = slots.reduce((sum, s) => sum + s.weight, 0) || 1
  let remaining = count
  const slotCounts = slots.map((slot, i) => {
    if (i === slots.length - 1) return remaining
    const allocated = Math.round((slot.weight / totalWeight) * count)
    remaining -= allocated
    return allocated
  })

  const schedule: Date[] = []
  for (let i = 0; i < slots.length; i++) {
    const slot = slots[i]
    const clickCount = Math.max(0, slotCounts[i])
    for (let j = 0; j < clickCount; j++) {
      const offsetMs = slot.startMs + Math.random() * (slot.endMs - slot.startMs)
      schedule.push(new Date(now.getTime() + offsetMs))
    }
  }

  schedule.sort((a, b) => a.getTime() - b.getTime())
  return schedule
}

/**
 * 需求2：把 count 次点击在「未来 windowMinutes 分钟内」随机均匀分散（已排序的绝对 UTC 时间）。
 * 用于订单/点击比补刷——定版要求「1 小时内随机分散」，不走当天作息曲线。
 */
export function generateClickScheduleWithinWindow(count: number, windowMinutes = 60, startTime?: Date): Date[] {
  if (count <= 0) return []
  const nowMs = (startTime || new Date()).getTime()
  const spanMs = Math.max(1, windowMinutes) * 60_000
  const schedule: Date[] = []
  for (let i = 0; i < count; i++) {
    schedule.push(new Date(nowMs + Math.floor(Math.random() * spanMs)))
  }
  schedule.sort((a, b) => a.getTime() - b.getTime())
  return schedule
}
