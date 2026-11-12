import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

/**
 * Demo site is TEST-SERVER ONLY.
 *
 * The API base is a build-time value (`VITE_DEMO_API_BASE`); there is no
 * production fallback in the code. `/api` is proxied server-side to the demo
 * backend on loopback, so the browser never talks to any other host.
 */
const backendPort = process.env.DEMO_BACKEND_PORT ?? '8763';
const backendHost = process.env.DEMO_BACKEND_HOST ?? '127.0.0.1';

/** Embeds the build-time lock into the HTML so a deploy can be verified without a browser. */
function buildStampPlugin() {
  const env = () => (process.env.VITE_DEMO_ENV ?? '').trim().toLowerCase();
  const api = () => (process.env.VITE_DEMO_API_BASE ?? '').trim();
  return {
    name: 'hermes-demo-build-stamp',
    transformIndexHtml(html: string) {
      return html.replace(
        '</head>',
        `    <meta name="demo-build-env" content="${env()}" />\n` +
          `    <meta name="demo-build-api-base" content="${api()}" />\n` +
          '  </head>',
      );
    },
  };
}
const proxy = {
  '/api': {
    target: `http://${backendHost}:${backendPort}`,
    changeOrigin: false,
    // The backend is test-locked; never proxy a WebSocket or anything else.
    ws: false,
  },
};

export default defineConfig(({ mode }) => ({
  plugins: [react(), buildStampPlugin()],
  // Production build is hosted same-origin by the backend at /demo/.
  base: mode === 'production' ? '/demo/' : '/',
  server: { host: '127.0.0.1', port: 8764, strictPort: true, proxy },
  preview: { host: '127.0.0.1', port: 8764, strictPort: true, proxy },
  build: { outDir: 'dist', sourcemap: false },
}));
