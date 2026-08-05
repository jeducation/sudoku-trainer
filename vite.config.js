import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

// GitHub Pages serves a project repo at username.github.io/repo-name/, so
// Vite needs to know that subpath at build time or asset URLs will 404.
// If your repo is named something other than "sudoku-trainer", change the
// string below to match (keep the leading and trailing slashes).
// If this is instead a personal "username.github.io" repo served at the
// root, change this back to "/".
export default defineConfig({
  base: "/sudoku-trainer/",
  plugins: [react(), tailwindcss()],
});
