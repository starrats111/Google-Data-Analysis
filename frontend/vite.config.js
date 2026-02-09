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
        // 手动代码分割，将第三方库分离
        manualChunks: {
          // React核心
          'react-vendor': ['react', 'react-dom', 'react-router-dom'],
          // Ant Design
          'antd-vendor': ['antd', '@ant-design/icons'],
          // 图表库
          'chart-vendor': ['echarts', 'echarts-for-react'],
          // 工具库
          'utils-vendor': ['axios', 'dayjs'],
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
