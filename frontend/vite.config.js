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
        assetFileNames: 'assets/[name].[hash].[ext]'
      }
    }
  },
  server: {
    // Bind on IPv6 any-address so Windows can accept both IPv6 (::1) and IPv4 (127.0.0.1) localhost connections.
    // This avoids "connection refused" in browsers that resolve `localhost` to IPv4 first.
    host: '::',
    port: 3000,
    proxy: {
      '/api': {
        target: 'http://localhost:8000',
        changeOrigin: true
      }
    }
  }
})













