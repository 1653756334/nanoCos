import { defineConfig, loadEnv } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig(({ mode }) => {
  // 同时探测当前 web 目录与上级根目录中的环境变量（优先取系统环境变量与 .env）
  const env = {
    ...process.env,
    ...loadEnv(mode, '../', ''),
    ...loadEnv(mode, process.cwd(), ''),
  };

  let backendTarget = env.VITE_BACKEND_URL;
  if (!backendTarget && env.NANOCOS_ADDR) {
    const addr = env.NANOCOS_ADDR.trim();
    if (addr.startsWith(':')) {
      backendTarget = `http://localhost${addr}`;
    } else if (addr.startsWith('http://') || addr.startsWith('https://')) {
      backendTarget = addr;
    } else {
      backendTarget = `http://${addr}`;
    }
  }
  backendTarget = backendTarget || 'http://localhost:9000';

  return {
    plugins: [react()],
    build: {
      outDir: '../internal/web/dist',
      emptyOutDir: true,
      sourcemap: false,
      chunkSizeWarningLimit: 1100,
      rollupOptions: {
        output: {
          manualChunks(id) {
            if (id.includes('node_modules')) {
              if (
                id.includes('/react-dom/') ||
                id.includes('/react/') ||
                id.includes('/scheduler/')
              ) {
                return 'vendor-react';
              }
              if (
                id.includes('antd') ||
                id.includes('@ant-design') ||
                id.includes('@rc-component') ||
                id.includes('/rc-')
              ) {
                return 'vendor-antd';
              }
            }
          },
        },
      },
    },
    server: {
      port: 5173,
      proxy: {
        '/api': backendTarget,
        '/raw': backendTarget,
        '/s3': backendTarget,
        '/healthz': backendTarget,
        '/readyz': backendTarget,
      },
    },
  };
});
