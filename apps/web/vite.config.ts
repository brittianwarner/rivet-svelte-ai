import adapter from "@sveltejs/adapter-node";
import { sveltekit } from "@sveltejs/kit/vite";
import { vitePreprocess } from "@sveltejs/vite-plugin-svelte";
import { defineConfig } from "vite";

export default defineConfig({
  envDir: "../..",
  plugins: [sveltekit({ adapter: adapter(), preprocess: vitePreprocess() })],
  server: {
    host: "127.0.0.1",
    port: 5173,
    strictPort: true,
  },
});
