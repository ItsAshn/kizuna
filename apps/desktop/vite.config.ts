import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import path from 'node:path'

export default defineConfig({
  define: {
    __VERCEL__: JSON.stringify(!!process.env.VERCEL),
  },
  plugins: [react()],
  resolve: {
    alias: [
      { find: /^@\//, replacement: path.resolve(__dirname, 'src') + '/' },
      { find: /^@kizuna\/shared\/crypto$/, replacement: path.resolve(__dirname, '../../packages/shared/src/crypto.ts') },
      { find: /^@kizuna\/shared\/types$/, replacement: path.resolve(__dirname, '../../packages/shared/src/types.ts') },
      { find: /^@kizuna\/shared\/api$/, replacement: path.resolve(__dirname, '../../packages/shared/src/api.ts') },
      { find: /^@kizuna\/shared$/, replacement: path.resolve(__dirname, '../../packages/shared/src/index.ts') },
    ],
  },
  clearScreen: false,
  server: {
    port: 1420,
    strictPort: true,
    watch: {
      ignored: ['**/src-tauri/**'],
    },
  },
})
