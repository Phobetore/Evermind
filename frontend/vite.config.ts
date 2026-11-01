import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { fileURLToPath } from "node:url";
import { defineConfig, loadEnv } from "vite";

// The repository's .env is where people set their ports, and the configuration
// takes only those two from it. What Vite itself hands to the page is VITE_
// names alone (`envPrefix` keeps its default), from the environment and the
// .env files in frontend/, never from this one, so nothing in the repository's
// file, the access password included, can end up in the built interface.
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
    build: {
      rolldownOptions: {
        output: {
          codeSplitting: {
            groups: [
              // The pages use the icons in different combinations, so left
              // alone the build cuts a file of a couple of hundred bytes for
              // nearly every icon, and each page then asks for a dozen of them.
              {
                name: "icons",
                test: /node_modules[\\/]lucide-react/,
                // Left on, the group takes what the icons import with it, and
                // that is React itself: the file would be named for a few
                // kilobytes of icons and hold twice that of something else.
                includeDependenciesRecursively: false,
              },
            ],
          },
        },
      },
    },
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
