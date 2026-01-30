// 工具函数模块
const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
require('dotenv').config();

// ============ 加密相关 ============

// 简单加密平台账号密码（使用AES-256-CBC）
function encryptPassword(password) {
  const algorithm = 'aes-256-cbc';
  const key = Buffer.from(process.env.ENCRYPTION_KEY, 'utf-8').slice(0, 32);
  const iv = crypto.randomBytes(16);

  const cipher = crypto.createCipheriv(algorithm, key, iv);
  let encrypted = cipher.update(password, 'utf8', 'hex');
  encrypted += cipher.final('hex');

  return iv.toString('hex') + ':' + encrypted;
}

// 解密平台账号密码
function decryptPassword(encryptedData) {
  const algorithm = 'aes-256-cbc';
  const key = Buffer.from(process.env.ENCRYPTION_KEY, 'utf-8').slice(0, 32);

  const parts = encryptedData.split(':');
  const iv = Buffer.from(parts[0], 'hex');
  const encrypted = parts[1];

  const decipher = crypto.createDecipheriv(algorithm, key, iv);
  let decrypted = decipher.update(encrypted, 'hex', 'utf8');
  decrypted += decipher.final('utf8');

  return decrypted;
}

// 用户密码hash（bcrypt）
async function hashPassword(password) {
  return await bcrypt.hash(password, 10);
}

// 验证用户密码
async function verifyPassword(password, hash) {
  return await bcrypt.compare(password, hash);
}

// ============ JWT相关 ============

// 生成JWT token
function generateToken(payload) {
  return jwt.sign(payload, process.env.JWT_SECRET, { expiresIn: '7d' });
}

// 验证JWT token
function verifyToken(token) {
  try {
    return jwt.verify(token, process.env.JWT_SECRET);
  } catch (error) {
    return null;
  }
}

// ============ LH平台相关 ============

// 生成LH平台sign
function generateSign(data) {
  const salt = 'TSf03xGHykY';
  return crypto.createHash('md5').update(data + salt, 'utf-8').digest('hex');
}

module.exports = {
  encryptPassword,
  decryptPassword,
  hashPassword,
  verifyPassword,
  generateToken,
  verifyToken,
  generateSign,
};
