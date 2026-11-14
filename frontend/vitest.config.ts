import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["src/**/*.test.ts"],
  },
  resolve: {
    alias: { "@": fileURLToPath(new URL("./src", import.meta.url)) },
  },
  plugins: [
    {
      // The timed tests measure the code the browser runs. Without this, the tests would load the
      // development builds of micromark and its extensions, which check every step and parse four
      // times slower than the production builds the app ships.
      name: "production-builds",
      configResolved(config) {
        const shipped = (conditions: string[]) =>
          conditions.filter((condition) => condition !== "development|production" && condition !== "development");
        if (config.ssr.resolve) config.ssr.resolve.conditions = shipped(config.ssr.resolve.conditions ?? []);
        for (const environment of Object.values(config.environments))
          environment.resolve.conditions = shipped(environment.resolve.conditions);
      },
    },
  ],
});
