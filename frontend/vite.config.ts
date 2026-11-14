import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  server: {
    // 监听所有网卡，手机（同一 Wi-Fi）可通过 http://<本机局域网IP>:5173 访问
    host: true,
    port: 5173,
    strictPort: true,
    proxy: {
      // 开发环境同源代理，避免 CORS；生产由后端托管静态文件。
      '/api': {
        target: 'http://127.0.0.1:3001',
        changeOrigin: false,
      },
    },
  },
});