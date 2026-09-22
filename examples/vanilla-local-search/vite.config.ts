import { defineConfig } from 'vite';

export default defineConfig({ build: { target: 'es2022', sourcemap: false }, server: { port: 4175, strictPort: true } });
