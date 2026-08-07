import { defineConfig } from 'vite'

export default defineConfig({
  // base './' 让构建产物可用 file:// 直接加载（Electron 生产模式）
  base: './',
  server: {
    port: 5173,
    strictPort: true,
    host: '127.0.0.1'
  },
  build: {
    outDir: 'dist',
    target: 'es2022'
  }
})
