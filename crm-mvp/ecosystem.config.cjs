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

      // 内存限制：须高于 NODE_OPTIONS 堆上限 + 原生/缓冲 RSS，否则易在正常负载下被 PM2 误杀 → Nginx 502
      // ARCH-01 T0a（2026-06-05）：900M 对 Next16+puppeteer+sharp+tesseract 过低，puppeteer 爬取
      //   尖峰一冲过 900M 即被 PM2 SIGINT 重启（累计 129 次重启 → 近半数生成失败来自“任务僵死/重试耗尽”）。
      //   提到 1600M：堆仍由 --max-old-space-size=768 自限，1600 只放宽对原生/缓冲 RSS 瞬时尖峰的容忍。
      //   机器 3.6G + 8G swap，1.6G 留足余量。
      max_memory_restart: '1600M',

      // 收到重启信号后多等待，让进行中的请求有机会结束（减轻部署/内存重启时的 502）
      kill_timeout: 10_000,

      // B-3: 重启策略
      max_restarts: 10,          // 最多连续重启 10 次
      min_uptime: '10s',         // 启动后至少运行 10 秒才算成功
      restart_delay: 3000,       // 重启间隔 3 秒，避免疯狂循环

      // 环境变量
      env: {
        NODE_ENV: 'production',
        // D-358（2026-09-24）：768 → 960。daily-sync 撞堆上限自杀（code 134 /
        //   `FATAL ERROR: Reached heap limit`）累计 56 次，固定在 07:51，11:15 也发生过。
        //   这与内核 OOM 击杀无关（近 7 天 0 次），是 V8 自限——机器扩内存也治不了它。
        //   上限取 960 而非更高：实测 RSS 994MB 时堆只用 345MB、堆外原生内存约 506MB
        //   （arena 碎片，MALLOC_ARENA_MAX=2 已压过仍有这么多）。若提到 1200，
        //   daily-sync 真吃满时 1200+506=1706MB 会顶穿 max_memory_restart(1600M)
        //   → pm2 重启 → 502，等于把「每天崩一次」换成「每天 502 一次」。
        //   算式：1600 - 506(堆外) - 100(余量) ≈ 994，取 960 留整。
        //   注意：崩溃日志未记录当时堆大小，960 是否够用需观察 07:51 是否仍崩。
        //
        // ⚠ 这里的值**不是**最终生效值：`script: 'npm' / args: 'start'` 会执行
        //   package.json 的 start 脚本，而那里自带 `NODE_OPTIONS='...'` 前缀，
        //   会覆盖 pm2 传入的本变量。实测只改本行、pm2 restart --update-env 之后，
        //   /proc/<pid>/environ 里仍是旧值 768。**改堆限必须同时改 package.json 的 start。**
        //   本行保留同步是为了避免两处不一致再次误导排查。
        NODE_OPTIONS: '--max-old-space-size=960',
        PORT: '20050',
        TZ: 'Asia/Shanghai',
        CRON_SECRET: 'crm-daily-sync-2026',

        // 2026-09-12：RSS 1118MB 但 V8 堆只用 251MB、堆外 Buffer 仅 42MB——825MB 的缺口
        //   既不在堆里也回收不掉，smaps 里是 232/208/99/90MB 几大块匿名映射、共 1573 块。
        //   这是 glibc malloc 的 per-thread arena 碎片：抓图/抓正文反复申请释放大 Buffer，
        //   arena 撑大后不归还系统。2 核机默认允许 8×2=16 个 arena，每个能长到 64MB。
        //   后果是 RSS 一路顶到 max_memory_restart(1600M) → pm2 重启（今日 31 次），
        //   期间可用内存被压到 300-400MB，puppeteer 反压水位（800MB）全程拒绝开浏览器。
        //   V8 的 --max-old-space-size 管不到这块，所以限 arena 数是唯一低成本手段。
        //   代价：arena 少了多线程 malloc 会有锁竞争，但本服务瓶颈是内存不是 malloc 吞吐。
        MALLOC_ARENA_MAX: '2',
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
