// PM2 Ecosystem Configuration — ad-automation
// B-3: 限制重启次数，避免无限循环
// B-4: 统一管理 PM2 配置
module.exports = {
  apps: [
    {
      name: 'ad-automation',
      script: 'npm',
      args: 'start',
      cwd: '/home/ubuntu/Google-Data-Analysis/crm-mvp',
      interpreter: '/usr/bin/node',

      // 内存限制：超过 700MB 自动重启
      max_memory_restart: '700M',

      // B-3: 重启策略
      max_restarts: 10,          // 最多连续重启 10 次
      min_uptime: '10s',         // 启动后至少运行 10 秒才算成功
      restart_delay: 3000,       // 重启间隔 3 秒，避免疯狂循环

      // 环境变量
      env: {
        NODE_ENV: 'production',
        NODE_OPTIONS: '--max-old-space-size=768',
        PORT: '20050',
      },

      // 日志配置（B-5）
      error_file: '/home/ubuntu/.pm2/logs/ad-automation-error.log',
      out_file: '/home/ubuntu/.pm2/logs/ad-automation-out.log',
      merge_logs: true,
      log_date_format: 'YYYY-MM-DD HH:mm:ss',

      // 不监听文件变化
      watch: false,

      // fork 模式（单实例）
      exec_mode: 'fork',
      instances: 1,
    },
  ],
};
