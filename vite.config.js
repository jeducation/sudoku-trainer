import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { VitePWA } from "vite-plugin-pwa";

// GitHub Pages serves a project repo at username.github.io/repo-name/, so
// Vite needs to know that subpath at build time or asset URLs will 404.
// If your repo is named something other than "sudoku-trainer", change the
// string below to match (keep the leading and trailing slashes).
// If this is instead a personal "username.github.io" repo served at the
// root, change this back to "/".
const base = "/sudoku-trainer/";

export default defineConfig({
  base,
  plugins: [
    react(),
    tailwindcss(),
    VitePWA({
      registerType: "autoUpdate",
      // We already hand-maintain public/manifest.json (with the relative
      // start_url/scope/icon paths needed for GitHub Pages' subpath) — so
      // this plugin only needs to generate the service worker itself, not
      // a second manifest.
      manifest: false,
      includeAssets: ["icon-192.png", "icon-512.png", "apple-touch-icon.png"],
      workbox: {
        // Precache the whole built app shell so it works fully offline
        // after the first successful online visit.
        globPatterns: ["**/*.{js,css,html,png,json}"],
        navigateFallback: `${base}index.html`,
      },
    }),
  ],
});
