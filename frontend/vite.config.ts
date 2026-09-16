import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// Backend origin for `npm run dev`. Override with VITE_BACKEND_ORIGIN if your
// backend runs elsewhere. In Docker, nginx performs the same proxying.
const backend = process.env.VITE_BACKEND_ORIGIN ?? 'http://localhost:8080';
const backendWs = backend.replace(/^http/, 'ws');

// During development Vite serves the React app and proxies API + WebSocket
// traffic to the backend, so no CORS/origin juggling is needed.
export default defineConfig({
  plugins: [react()],
  server: {
    host: '0.0.0.0',
    port: 5173,
    proxy: {
      '/api': {
        target: backend,
        changeOrigin: true,
      },
      '/collab': {
        target: backendWs,
        ws: true,
        changeOrigin: true,
      },
    },
  },
  optimizeDeps: {
    include: ['yjs', 'y-websocket', 'y-protocols', 'y-monaco'],
  },
  worker: {
    format: 'es',
  },
});
