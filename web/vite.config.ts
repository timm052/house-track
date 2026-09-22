import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { VitePWA } from "vite-plugin-pwa";

// In development the API runs separately (uvicorn on :8000); Caddy does this proxying in the container.
export default defineConfig({
  plugins: [
    react(),
    // Installable phone app with an offline app shell (PLAN.md milestone 3, D6). Data reads come from the
    // persisted query cache; writes that can't reach the server wait in the outbox (src/outbox.ts).
    VitePWA({
      registerType: "autoUpdate",
      includeAssets: ["icons/*.png"],
      manifest: {
        name: "House Track",
        short_name: "House Track",
        start_url: "/",
        display: "standalone",
        background_color: "#111318",
        theme_color: "#1d4ed8",
        icons: [
          { src: "/icons/icon-192.png", sizes: "192x192", type: "image/png" },
          { src: "/icons/icon-512.png", sizes: "512x512", type: "image/png" },
          { src: "/icons/icon-512-maskable.png", sizes: "512x512", type: "image/png", purpose: "maskable" },
        ],
      },
      workbox: {
        navigateFallback: "/index.html",
        navigateFallbackDenylist: [/^\/api\//, /^\/tiles\//],
        globPatterns: ["**/*.{js,css,html,png,svg,webp}"],
        maximumFileSizeToCacheInBytes: 4 * 1024 * 1024,
        runtimeCaching: [
          {
            // Photos you've looked at stay viewable offline; their URLs never change content.
            urlPattern: /\/api\/attachments\/[^/]+\/(thumb|file)$/,
            handler: "CacheFirst",
            options: { cacheName: "attachments", expiration: { maxEntries: 400, maxAgeSeconds: 60 * 60 * 24 * 90 } },
          },
        ],
      },
    }),
  ],
  server: { proxy: { "/api": "http://localhost:8000" } },
});
