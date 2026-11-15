import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

// The files whose tests hold the layout to a time budget. Run beside the other files, they shared
// the processor with them, and a budget of 100 ms was passed now and then by the load of the
// others, not by the code they time: they run after all the rest, one file at a time. Their budgets
// are the reference PC's, scaled to the machine they run on (src/lib/presentation/timedBudget.ts).
const TIMED = [
  "src/lib/presentation/renderPresentation.test.ts",
  "src/lib/presentation/bounds.test.ts",
  "src/lib/presentation/images.test.ts",
  "src/lib/presentation/links.test.ts",
  "src/lib/presentation/style.test.ts",
  "src/lib/presentation/notes.test.ts",
  "src/components/chat/RpText.test.ts",
];

export default defineConfig({
  test: {
    environment: "node",
    projects: [
      { extends: true, test: { name: "unit", include: ["src/**/*.test.ts"], exclude: TIMED, sequence: { groupOrder: 0 } } },
      {
        extends: true,
        test: { name: "timed", include: TIMED, fileParallelism: false, sequence: { groupOrder: 1 } },
      },
    ],
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
