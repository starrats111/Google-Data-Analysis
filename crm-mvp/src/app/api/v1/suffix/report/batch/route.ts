import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/prisma'
import { getScriptUserFromRequest } from '@/lib/script-auth'

interface ReportItem {
  assignmentId: string
  campaignId?: string
  writeSuccess: boolean
  writeErrorMessage?: string
  reportedAt?: string
}

export async function POST(req: NextRequest) {
  const scriptUser = await getScriptUserFromRequest(req)
  if (!scriptUser) {
    return NextResponse.json({ success: false, error: { code: 'UNAUTHORIZED', message: '无效的 API Key' } }, { status: 401 })
  }

  let body: { reports?: ReportItem[] }
  try {
    body = await req.json()
  } catch {
    return NextResponse.json({ success: false, error: { code: 'BAD_REQUEST', message: '请求体解析失败' } }, { status: 400 })
  }

  const reports: ReportItem[] = body.reports ?? []
  if (!Array.isArray(reports) || reports.length === 0) {
    return NextResponse.json({ success: true, processed: 0 })
  }

  let processed = 0
  let failed = 0

  for (const r of reports) {
    const { assignmentId, writeSuccess, writeErrorMessage, reportedAt } = r
    if (!assignmentId) continue

    try {
      const assignment = await prisma.suffix_assignments.findUnique({
        where: { assignment_id: assignmentId },
      })

      if (!assignment) continue

      await prisma.suffix_assignments.update({
        where: { assignment_id: assignmentId },
        data: {
          write_success: writeSuccess ? 1 : 0,
          write_error_message: writeErrorMessage ?? null,
          reported_at: reportedAt ? new Date(reportedAt) : new Date(),
        },
      })

      // 若 Script 写入失败，将 suffix 释放回 available 状态（可重用）
      if (!writeSuccess && assignment.suffix_pool_id) {
        await prisma.suffix_pool.update({
          where: { id: assignment.suffix_pool_id },
          data: { status: 'available', leased_assignment_id: null },
        })
      }

      processed++
    } catch {
      failed++
    }
  }

  return NextResponse.json({ success: true, processed, failed })
}
