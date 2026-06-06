import { defineConfig } from "vite";

// The component is served under the add-on; UI assets are served from /ui/.
export default defineConfig({
  root: "src/ui",
  base: "/ui/",
  build: {
    outDir: "../../dist/ui",
    emptyOutDir: true,
    rollupOptions: {
      output: {
        entryFileNames: "main.js",
        assetFileNames: "[name][extname]",
      },
    },
  },
});
