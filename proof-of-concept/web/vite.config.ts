import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  server: {
    port: Number(process.env.PORT) || 5190,
    strictPort: true,
    // Mirrors CloudFront's real /api/* -> ALB routing (infra/modules/cdn) so
    // relative fetch("/api/...") calls work the same in local dev as they
    // do in production, for both the SPA and the public/start.html page.
    proxy: {
      "/api": { target: `http://localhost:${process.env.CLOUD_BACKEND_PORT || 4520}`, changeOrigin: true },
    },
  },
});
