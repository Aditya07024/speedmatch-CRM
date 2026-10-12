import path from 'path';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { defineConfig } from 'vite';

const port = Number(process.env.PORT ?? 5173);
const basePath = process.env.BASE_PATH ?? '/';
const apiTarget = process.env.API_URL ?? 'http://localhost:8080';

export default defineConfig({
  base: basePath,
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: {
      '@': path.resolve(import.meta.dirname, 'src'),
    },
    dedupe: ['react', 'react-dom'],
  },
  root: path.resolve(import.meta.dirname),
  envDir: path.resolve(import.meta.dirname, '../../'),
  envPrefix: ['VITE_', 'CLERK_'],
  build: {
    outDir: path.resolve(import.meta.dirname, 'dist/public'),
    emptyOutDir: true,
  },
  server: {
    port,
    strictPort: true,
    host: 'localhost',
    // Forward API calls to the local Express server
    proxy: {
      '/api': { target: apiTarget, changeOrigin: true },
    },
  },
  preview: {
    port,
    host: 'localhost',
    proxy: {
      '/api': { target: apiTarget, changeOrigin: true },
    },
  },
});
