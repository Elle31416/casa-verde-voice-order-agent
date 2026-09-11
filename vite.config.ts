import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import svgr from 'vite-plugin-svgr'

// Custom plugin to handle ?import&react syntax (alias to ?react)
const svgImportPlugin = () => ({
  name: 'svg-import-alias',
  resolveId(id: string) {
    // Transform ?import&react to ?react for vite-plugin-svgr
    if (id.includes('?import&react')) {
      return id.replace('?import&react', '?react');
    }
    return null;
  },
});

// https://vite.dev/config/
//
// Base path is "/" by default so the production build works when served from
// the domain root (Render full-stack service, `npm run serve`, custom domains).
// Set GITHUB_PAGES=true (or VITE_BASE) only for the GitHub Pages project site,
// which lives under /casa-verde-voice-order-agent/.
const base =
  process.env.VITE_BASE ??
  (process.env.GITHUB_PAGES === 'true' ? '/casa-verde-voice-order-agent/' : '/')

export default defineConfig({
  base,
  plugins: [
    react(),
    tailwindcss(),
    svgImportPlugin(),
    svgr({
      // Support named ReactComponent export (for ?react syntax)
      svgrOptions: {
        exportType: 'named',
        namedExport: 'ReactComponent',
        ref: true,
        svgo: false,
        titleProp: true,
      },
      include: '**/*.svg?react',
    }),
  ],
  server: {
    host: '0.0.0.0',
    port: 5173,
    allowedHosts: true as const,
    hmr: false,
    // The Node backend (see server/index.mjs) holds the AssemblyAI key and
    // mints short-lived tokens; the browser talks to it same-origin.
    proxy: {
      '/api': {
        target: process.env.API_TARGET || 'http://localhost:8787',
        changeOrigin: true,
      },
    },
  },
  preview: {
    host: '0.0.0.0',
    port: 4173,
    allowedHosts: true as const,
  },
})
