import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { VitePWA } from "vite-plugin-pwa";

export default defineConfig({
  plugins: [
    react(),
    VitePWA({
      registerType: "autoUpdate",
      manifest: {
        name: "Kiosco POS", short_name: "Kiosco", lang: "es-AR", display: "standalone",
        background_color: "#f2f0e8", theme_color: "#0f4c5c", start_url: "/",
        icons: [
          { src: "icon-192.png", sizes: "192x192", type: "image/png" },
          { src: "icon-512.png", sizes: "512x512", type: "image/png", purpose: "any maskable" },
        ],
      },
      // Todo el "shell" de la app queda en caché: abre y vende sin internet.
      workbox: { globPatterns: ["**/*.{js,css,html,png,svg,ico}"], navigateFallback: "/index.html", navigateFallbackDenylist: [/^\/api/] },
    }),
  ],
  server: { proxy: { "/api": "http://localhost:3000" } },
});
