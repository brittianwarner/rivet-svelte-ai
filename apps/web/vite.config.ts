import adapter from "@example/sveltekit-adapter-bun";
import { sveltekit } from "@sveltejs/kit/vite";
import { vitePreprocess } from "@sveltejs/vite-plugin-svelte";
import { defineConfig } from "vite";

// In development the Bun server (apps/server) owns /api and /rivet; Vite forwards
// them so the browser still sees one origin, exactly like production.
const server = `http://127.0.0.1:${process.env.API_PORT || process.env.PORT || 3001}`;

export default defineConfig({
  envDir: "../..",
  plugins: [
    sveltekit({
      // The Bun server imports build/handler.js and serves the web from the
      // same port as /api and /rivet. See apps/server/src/server.ts.
      adapter: adapter({ bodySizeLimit: "1M" }),
      preprocess: vitePreprocess(),
      paths: { origin: process.env.WEB_ORIGIN || undefined },
    }),
  ],
  server: {
    host: "127.0.0.1",
    // WEB_PORT runs a second checkout beside this one.
    port: Number(process.env.WEB_PORT) || 5173,
    strictPort: true,
    proxy: {
      "/api": { target: server },
      "/rivet": { target: server, ws: true },
    },
  },
});
