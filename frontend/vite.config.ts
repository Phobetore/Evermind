import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { hostname } from "node:os";
import { fileURLToPath } from "node:url";
import { defineConfig, loadEnv } from "vite";

// The repository's .env is where people set their ports and the names they open
// Evermind by, and the configuration takes only those from it. What Vite itself
// hands to the page is VITE_ names alone (`envPrefix` keeps its default), from
// the environment and the .env files in frontend/, never from this one, so
// nothing in the repository's file, the access password included, can end up in
// the built interface.
const repoRoot = fileURLToPath(new URL("..", import.meta.url));

// The host names, besides addresses and localhost (which Vite lets through by
// itself), that the API answers to without a password: this computer's name and
// its first label, each also with .local, and the names listed in
// EVERMIND_ALLOWED_HOSTS (see _known_host in backend/app/gate.py). Vite checks
// Host before a request reaches the API, so with `dev --lan` it would answer
// 403 to http://nas:3000 itself. It is a list, never `true`, so a website
// whose name was pointed at this computer still meets Vite's refusal.
function allowedHosts(listed: string): string[] {
  const machine = hostname().toLowerCase();
  const own = [machine, machine.split(".")[0]].filter(Boolean);
  const names = [...own, ...own.map((name) => name + ".local")];
  for (const entry of listed.split(",")) {
    // The API reads an entry as a name without port or final dot, and Vite
    // would take one that starts with a dot for every name under it.
    const name = entry.trim().toLowerCase().replace(/:\d+$/, "").replace(/\.$/, "");
    if (/^[\w-][\w.-]*$/.test(name)) names.push(name);
  }
  return [...new Set(names)];
}

export default defineConfig(({ mode }) => {
  const { PORT, EVERMIND_BACKEND_PORT, EVERMIND_ALLOWED_HOSTS } = loadEnv(mode, repoRoot, "");
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
      allowedHosts: allowedHosts(EVERMIND_ALLOWED_HOSTS || ""),
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
