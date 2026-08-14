import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    allowedHosts: [
      'radio-marinha-pagina.onrender.com'
    ],
    proxy: {
      // Proxy para evitar erro de CORS e unificar a origem
      "/api": {
        target: "http://127.0.0.1:3001",
        changeOrigin: true,
        secure: false
      }
    }
  }
});