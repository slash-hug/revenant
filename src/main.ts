import { mount } from "svelte";

// Self-hosted fonts (offline — no CDN dependency for the desktop app).
import "@fontsource-variable/geist";                 // UI — Geist (variable wght)
import "@fontsource/literata/400.css";               // Prose — Literata
import "@fontsource/literata/400-italic.css";
import "@fontsource/literata/500.css";
import "@fontsource/literata/600.css";
import "@fontsource/jetbrains-mono/400.css";          // Editor / code — JetBrains Mono
import "@fontsource/jetbrains-mono/500.css";
import "@fontsource/jetbrains-mono/600.css";
import "@fontsource/jetbrains-mono/700.css";

// Design system: tokens first, then global base.
import "./lib/styles/tokens.css";
import "./lib/styles/global.css";

import { initTheme } from "./lib/stores/theme";
import App from "./App.svelte";

initTheme();

const app = mount(App, {
  target: document.getElementById("app")!,
});

export default app;
