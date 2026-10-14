import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// Dev only: proxy API + WebSocket to the sync server.
// In production (nginx) the client is same-origin, so no proxy is needed.
export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      '/api': 'http://localhost:4000',
      '/socket.io': { target: 'http://localhost:4000', ws: true },
    },
  },
});
