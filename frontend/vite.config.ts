import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { fileURLToPath } from "node:url";
import { defineConfig, loadEnv } from "vite";

// The repository's .env is where people set their ports. It is read here, by
// the configuration, and nowhere else: `envPrefix` keeps its default, so none
// of it (the access password included) can end up in the built interface.
const repoRoot = fileURLToPath(new URL("..", import.meta.url));

export default defineConfig(({ mode }) => {
  const { PORT, EVERMIND_BACKEND_PORT } = loadEnv(mode, repoRoot, "");
  return {
    // Relative asset paths: the same build works at the root of the server
    // and inside a package that is served from somewhere else.
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
        "/api": "http://127.0.0.1:" + (EVERMIND_BACKEND_PORT || 8000),
      },
    },
  };
});
