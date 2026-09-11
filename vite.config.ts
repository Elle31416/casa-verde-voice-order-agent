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
export default defineConfig(({ command }) => ({
  // Absolute base only for production builds (GitHub Pages project site);
  // dev server stays at "/" so it works behind any proxy port.
  base: command === 'build' ? '/casa-verde-voice-order-agent/' : '/',
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
  },
  preview: {
    host: '0.0.0.0',
    port: 4173,
    allowedHosts: true as const,
  },
}))
