import { defineConfig, loadEnv } from 'vite';

// Content-Security-Policy: scripts only from this site, network only to the
// configured Supabase project. Images may be https (pasted web content) or
// data:/blob: (demo mode, previews).
export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), 'VITE_');
  const sb = env.VITE_SUPABASE_URL ? new URL(env.VITE_SUPABASE_URL).origin : '';
  const ws = sb.replace(/^http/, 'ws');
  const dev = mode === 'development';
  const csp = [
    "default-src 'self'",
    `script-src 'self'${dev ? " 'unsafe-inline'" : ''}`,
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' https: data: blob:",
    `media-src 'self' blob: ${sb}`.trim(),
    `connect-src 'self' ${sb} ${ws}${dev ? ' ws: http://localhost:*' : ''}`.trim(),
    "font-src 'self'",
    "object-src 'none'",
    "base-uri 'none'",
    "form-action 'self'",
    "frame-src 'none'",
  ].join('; ');
  return {
    base: './',
    build: { target: 'es2022', sourcemap: false },
    plugins: [{ name: 'csp', transformIndexHtml: (html) => html.replace('%CSP%', csp) }],
  };
});
