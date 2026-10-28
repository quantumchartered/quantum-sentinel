import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    port: 5173,
    strictPort: true,
    // The API (apps/api) runs on :4000; the console calls it through this proxy in development.
    proxy: { "/api": "http://127.0.0.1:4000" },
  },
});
