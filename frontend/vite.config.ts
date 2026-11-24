import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { fileURLToPath } from "node:url";
import { defineConfig, loadEnv } from "vite";

// The repository's .env is where people set their ports, and the configuration
// takes only those from it. What Vite itself hands to the page is VITE_ names
// alone (`envPrefix` keeps its default), from the environment and the .env files
// in frontend/, never from this one, so nothing in the repository's file, the
// access password included, can end up in the built interface.
const repoRoot = fileURLToPath(new URL("..", import.meta.url));

export default defineConfig(({ mode }) => {
  const { PORT, EVERMIND_BACKEND_PORT } = loadEnv(mode, repoRoot, "");
  return {
    // Relative asset paths: the same build works at the root of the server
    // and under a path prefix, such as a reverse proxy's /evermind/.
    base: "./",
    plugins: [react(), tailwindcss()],
    resolve: {
      alias: { "@": fileURLToPath(new URL("./src", import.meta.url)) },
    },
    // The app is one file, but for what draws a card's presentation, fetched when one is shown:
    // nothing else can go missing on a weak link, or after an update while a page is still open.
    // A browser fetches it once for a version, since the server calls it immutable. Vite advises
    // splitting past 500 kB; this is the size at which the question is asked again (822 kB at
    // 3.6.0, of which the four languages are a quarter).
    build: { chunkSizeWarningLimit: 1200 },
    // Development only: the interface on PORT, and the API it calls on the
    // backend's own port behind it, so the browser still sees a single origin.
    server: {
      port: Number(PORT || 3000),
      proxy: {
        "/api": {
          target: "http://127.0.0.1:" + (EVERMIND_BACKEND_PORT || 8000),
          // Keep the browser's Host: the API compares a write's Origin with it.
          changeOrigin: false,
        },
      },
    },
  };
});
