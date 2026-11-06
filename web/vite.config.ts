import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
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
            if (id.includes('/react-dom/') || id.includes('/react/') || id.includes('/scheduler/')) {
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
      '/api': 'http://localhost:9000',
      '/raw': 'http://localhost:9000',
      '/s3': 'http://localhost:9000',
      '/healthz': 'http://localhost:9000',
      '/readyz': 'http://localhost:9000',
    },
  },
});
