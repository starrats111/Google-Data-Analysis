import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react()],
  build: {
    // 生成带hash的文件名，避免缓存问题
    rollupOptions: {
      output: {
        entryFileNames: 'assets/[name].[hash].js',
        chunkFileNames: 'assets/[name].[hash].js',
        assetFileNames: 'assets/[name].[hash].[ext]',
        manualChunks(id) {
          if (id.includes('node_modules')) {
            if (id.includes('/react/') || id.includes('/react-dom/') || id.includes('/react-router') || id.includes('/scheduler/')) {
              return 'react-vendor'
            }
            if (id.includes('/antd/') || id.includes('/@ant-design/') || id.includes('/@rc-component/') || id.includes('/rc-')) {
              return 'antd-vendor'
            }
            if (id.includes('/echarts/') || id.includes('/echarts-for-react/') || id.includes('/zrender/')) {
              return 'chart-vendor'
            }
            if (id.includes('/axios/') || id.includes('/dayjs/')) {
              return 'utils-vendor'
            }
          }
        }
      }
    },
    // 使用esbuild压缩（比terser更快）
    minify: 'esbuild',
    // esbuild配置
    target: 'es2020',
    // 分块大小警告阈值
    chunkSizeWarningLimit: 1000,
    // 启用源码映射便于调试
    sourcemap: false
  },
  server: {
    // Bind on IPv6 any-address so Windows can accept both IPv6 (::1) and IPv4 (127.0.0.1) localhost connections.
    host: '::',
    port: 3000,
    proxy: {
      '/api': {
        target: 'http://localhost:8000',
        changeOrigin: true
      }
    }
  },
  // 优化依赖预构建
  optimizeDeps: {
    include: ['react', 'react-dom', 'react-router-dom', 'antd', '@ant-design/icons', 'axios', 'dayjs']
  }
})
