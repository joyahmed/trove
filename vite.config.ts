import { defineConfig } from 'vite';
import { sveltekit } from '@sveltejs/kit/vite';
import tailwindcss from '@tailwindcss/vite';

// Tauri sets TAURI_DEV_HOST when the webview runs on another device; unset on desktop.
const host = process.env.TAURI_DEV_HOST;

export default defineConfig({
  plugins: [tailwindcss(), sveltekit()],
  // keep Rust errors visible in the same terminal
  clearScreen: false,
  server: {
    // tauri.conf.json devUrl points here; fail loudly rather than drift to another port
    port: 1420,
    strictPort: true,
    host: host || '127.0.0.1',
    hmr: host ? { protocol: 'ws', host, port: 1421 } : undefined,
    // agent worktrees under .claude/ are other checkouts; a change there must not reload this app
    watch: { ignored: ['**/src-tauri/**', '**/.claude/**'] },
  },
});
