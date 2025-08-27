import { join } from "node:path";
import viteReact from "@vitejs/plugin-react";
import viteFastifyReact from "@fastify/vite/plugin";
import preloadPlugin from "vite-preload/plugin";

/** @type {import('vite').UserConfig} */
export default {
  base: "/v2/",
  root: join(import.meta.dirname, "src", "client"),
  build: {
    outDir: join(import.meta.dirname, "dist", "ui"),
  },
  plugins: [
    preloadPlugin(),
    viteReact({ spa: true }),
    viteFastifyReact({ spa: true }),
  ],
  server: {
    allowedHosts: ["localhost", "127.0.0.1", "host.docker.internal"],
    hmr: {
      server: false,
      port: 5173,
      clientPort: 5173,
    },
  },
};
