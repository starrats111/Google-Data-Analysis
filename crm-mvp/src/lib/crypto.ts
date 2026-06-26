/**
 * 敏感数据加解密（AES-256-CBC，移植自 kylink encryption.ts，密文格式互不兼容但算法一致）
 *
 * 用途：代理供应商密码等。密文格式 `salt:iv:encryptedData`（均 hex）。
 * 向后兼容：decrypt/decryptPassword 对「非本格式」的旧明文原样返回，
 * 故存量明文密码无需迁移即可继续使用；新写入/再保存时才加密。
 *
 * 密钥来自环境变量 ENCRYPTION_SECRET（生产务必配置；缺省回退开发默认值）。
 */

import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from 'node:crypto'

const ALGORITHM = 'aes-256-cbc'
const IV_LENGTH = 16
const KEY_LENGTH = 32
const SALT_LENGTH = 16

const ENCRYPTION_SECRET =
  process.env.ENCRYPTION_SECRET || 'crm-default-secret-key-change-in-production'

function deriveKey(secret: string, salt: Buffer): Buffer {
  return scryptSync(secret, salt, KEY_LENGTH)
}

/** 加密明文，返回 salt:iv:cipher（hex）。空串返回空串。 */
export function encrypt(plaintext: string): string {
  if (!plaintext) return ''
  const salt = randomBytes(SALT_LENGTH)
  const iv = randomBytes(IV_LENGTH)
  const key = deriveKey(ENCRYPTION_SECRET, salt)
  const cipher = createCipheriv(ALGORITHM, key, iv)
  const encrypted = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()])
  return `${salt.toString('hex')}:${iv.toString('hex')}:${encrypted.toString('hex')}`
}

/** 解密；非本格式（旧明文）或解密失败时原样返回，保证向后兼容。 */
export function decrypt(ciphertext: string): string {
  if (!ciphertext) return ''
  const parts = ciphertext.split(':')
  if (parts.length !== 3) return ciphertext
  try {
    const salt = Buffer.from(parts[0], 'hex')
    const iv = Buffer.from(parts[1], 'hex')
    const encrypted = Buffer.from(parts[2], 'hex')
    if (salt.length !== SALT_LENGTH || iv.length !== IV_LENGTH) return ciphertext
    const key = deriveKey(ENCRYPTION_SECRET, salt)
    const decipher = createDecipheriv(ALGORITHM, key, iv)
    const decrypted = Buffer.concat([decipher.update(encrypted), decipher.final()])
    return decrypted.toString('utf8')
  } catch {
    return ciphertext
  }
}

/** 是否已是本模块的密文格式。 */
export function isEncrypted(value: string): boolean {
  if (!value) return false
  const parts = value.split(':')
  if (parts.length !== 3) return false
  const saltHexLen = SALT_LENGTH * 2
  const ivHexLen = IV_LENGTH * 2
  return (
    parts[0].length === saltHexLen &&
    parts[1].length === ivHexLen &&
    parts[2].length > 0 &&
    /^[0-9a-f]+$/i.test(parts[0]) &&
    /^[0-9a-f]+$/i.test(parts[1]) &&
    /^[0-9a-f]+$/i.test(parts[2])
  )
}

/** 加密密码（已加密则原样返回，幂等）。 */
export function encryptPassword(password: string): string {
  if (!password) return ''
  return isEncrypted(password) ? password : encrypt(password)
}

/** 解密密码（未加密的旧明文原样返回）。 */
export function decryptPassword(password: string): string {
  if (!password) return ''
  return isEncrypted(password) ? decrypt(password) : password
}
