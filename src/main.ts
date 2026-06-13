/**
 * src/main.ts — Svelte application entry point.
 * Owned by WS-A; this stub is provided so WS-C builds can succeed
 * while WS-A is still pending.
 */
import App from './App.svelte';

const app = new App({
  target: document.getElementById('app')!,
});

export default app;
