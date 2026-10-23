import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      '/api': 'http://localhost:3001',
    },
  },
  build: {
    sourcemap: false,
    chunkSizeWarningLimit: 800,
    rollupOptions: {
      output: {
        manualChunks: {
          react: ['react', 'react-dom', 'react-router-dom'],
          codemirror: ['@uiw/react-codemirror', '@codemirror/lang-sql', '@codemirror/view', '@codemirror/state', '@codemirror/commands', '@codemirror/search', '@codemirror/autocomplete', '@codemirror/language'],
          icons: ['lucide-react'],
        },
      },
    },
  },
})
