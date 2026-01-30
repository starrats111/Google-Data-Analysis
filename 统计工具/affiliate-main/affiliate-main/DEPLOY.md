# 部署指南

## 🚀 云服务器部署（推荐）

### 前置要求

- Ubuntu 20.04+ / CentOS 7+ 服务器
- Node.js 18+
- PM2 进程管理器
- Git

### 步骤 1: 安装 Node.js 和 PM2

```bash
# 安装 Node.js 18.x
curl -fsSL https://deb.nodesource.com/setup_18.x | sudo -E bash -
sudo apt-get install -y nodejs

# 安装 PM2
sudo npm install -g pm2
```

### 步骤 2: 克隆项目

```bash
# 进入工作目录
cd /var/www

# 克隆代码
git clone https://github.com/daphnelxqyp/affiliate-marketing-saas.git
cd affiliate-marketing-saas
```

### 步骤 3: 配置环境变量

```bash
# 复制环境变量示例文件
cp .env.example .env

# 生成密钥
echo "JWT_SECRET=$(node -e "console.log(require('crypto').randomBytes(64).toString('hex'))")" >> .env
echo "ENCRYPTION_KEY=$(node -e "console.log(require('crypto').randomBytes(16).toString('hex'))")" >> .env

# 编辑 .env 文件
nano .env
```

**必须配置的环境变量：**
- `JWT_SECRET` - JWT 签名密钥（已自动生成）
- `ENCRYPTION_KEY` - 平台账号密码加密密钥（已自动生成）
- `PORT` - 服务端口（默认 3000）
- `NODE_ENV` - 运行环境（设置为 production）

### 步骤 4: 安装依赖

```bash
npm install --production
```

### 步骤 5: 启动服务

```bash
# 方式1: 使用部署脚本（推荐）
chmod +x deploy.sh
bash deploy.sh

# 方式2: 手动启动
pm2 start ecosystem.config.js --env production
pm2 save
```

### 步骤 6: 配置 Nginx 反向代理（可选）

```nginx
server {
    listen 80;
    server_name your-domain.com;

    location / {
        proxy_pass http://localhost:3000;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection 'upgrade';
        proxy_set_header Host $host;
        proxy_cache_bypass $http_upgrade;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }
}
```

### 步骤 7: 配置 HTTPS（可选但推荐）

```bash
# 安装 Certbot
sudo apt install certbot python3-certbot-nginx

# 获取 SSL 证书
sudo certbot --nginx -d your-domain.com
```

---

## 📊 PM2 常用命令

```bash
# 查看服务状态
pm2 status

# 查看日志
pm2 logs affiliate-saas

# 实时监控
pm2 monit

# 重启服务
pm2 restart affiliate-saas

# 停止服务
pm2 stop affiliate-saas

# 删除服务
pm2 delete affiliate-saas

# 查看详细信息
pm2 show affiliate-saas
```

---

## 🔄 更新部署

```bash
# 方式1: 使用部署脚本（推荐）
bash deploy.sh

# 方式2: 手动更新
git pull origin main
npm install --production
pm2 restart affiliate-saas
```

---

## 🗄️ 数据库备份

```bash
# 备份数据库（SQLite）
cp database.db database.db.backup.$(date +%Y%m%d_%H%M%S)

# 定时备份（添加到 crontab）
# 每天凌晨2点自动备份
0 2 * * * cd /var/www/affiliate-marketing-saas && cp database.db database.db.backup.$(date +\%Y\%m\%d) && find . -name "database.db.backup.*" -mtime +7 -delete
```

---

## 🐛 故障排查

### 服务无法启动

1. 检查日志: `pm2 logs affiliate-saas`
2. 检查端口占用: `sudo lsof -i :3000`
3. 检查环境变量: `cat .env`

### 数据库错误

1. 检查数据库文件权限: `ls -la database.db`
2. 删除数据库重新初始化: `rm database.db && pm2 restart affiliate-saas`

### 内存不足

1. 增加 PM2 内存限制: 编辑 `ecosystem.config.js` 中的 `max_memory_restart`
2. 重启服务: `pm2 restart affiliate-saas`

---

## 🔒 安全建议

1. **修改默认端口**: 在 `.env` 中修改 `PORT`
2. **配置防火墙**:
   ```bash
   sudo ufw allow 22    # SSH
   sudo ufw allow 80    # HTTP
   sudo ufw allow 443   # HTTPS
   sudo ufw enable
   ```
3. **定期更新**: `git pull && npm install && pm2 restart affiliate-saas`
4. **使用 HTTPS**: 通过 Certbot 配置 SSL 证书
5. **限制数据库访问**: 确保 SQLite 数据库文件权限正确

---

## 📞 支持

遇到问题？提交 Issue: https://github.com/daphnelxqyp/affiliate-marketing-saas/issues
