import { defineConfig, type Plugin } from 'vite'

/**
 * 生产构建 CSP 收紧：移除开发服务器来源（ws/http 127.0.0.1:5173）
 * dev 模式保留（Vite HMR 需要），build 产物剔除（安全最佳实践）
 */
const stripDevCsp: Plugin = {
  name: 'strip-dev-csp',
  apply: 'build',
  transformIndexHtml(html) {
    return html.replace(
      /(connect-src[^;"]*) ws:\/\/127\.0\.0\.1:5173 http:\/\/127\.0\.0\.1:5173([;"])/,
      '$1$2'
    )
  }
}

export default defineConfig({
  // base './' 让构建产物可用 file:// 直接加载（Electron 生产模式）
  base: './',
  plugins: [stripDevCsp],
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
