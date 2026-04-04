import { prisma } from '@/lib/prisma'
import { NextRequest } from 'next/server'
import crypto from 'crypto'

export interface ScriptUser {
  userId: bigint
  username: string
  displayName: string | null
}

/**
 * 从请求中提取 Script API Key（支持 Authorization: Bearer 或 X-Api-Key）
 */
export function extractScriptApiKey(req: NextRequest): string | null {
  const authHeader = req.headers.get('authorization')
  if (authHeader?.startsWith('Bearer ')) {
    return authHeader.slice(7).trim()
  }
  const xApiKey = req.headers.get('x-api-key')
  if (xApiKey) return xApiKey.trim()
  return null
}

/**
 * 验证 Script API Key，返回关联的用户信息
 * 若无效则返回 null
 */
export async function verifyScriptApiKey(key: string): Promise<ScriptUser | null> {
  if (!key || !key.startsWith('ky_live_')) return null

  const user = await prisma.users.findFirst({
    where: { script_api_key: key, is_deleted: 0, status: 'active' },
    select: { id: true, username: true, display_name: true },
  })

  if (!user) return null

  return {
    userId: user.id,
    username: user.username,
    displayName: user.display_name,
  }
}

/**
 * 从请求中直接鉴权，返回用户信息或 null
 */
export async function getScriptUserFromRequest(req: NextRequest): Promise<ScriptUser | null> {
  const key = extractScriptApiKey(req)
  if (!key) return null
  return verifyScriptApiKey(key)
}

/**
 * 生成新的 Script API Key（格式：ky_live_<32位hex>）
 */
export function generateScriptApiKey(): string {
  return 'ky_live_' + crypto.randomBytes(16).toString('hex')
}
