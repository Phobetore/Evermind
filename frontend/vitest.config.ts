import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    // The root is there for devHosts.ts, which sits beside the Vite
    // configuration it serves rather than in src/.
    include: ["src/**/*.test.ts", "*.test.ts"],
  },
  resolve: {
    alias: { "@": fileURLToPath(new URL("./src", import.meta.url)) },
  },
});
