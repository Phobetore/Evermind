import { expect, type Page } from "@playwright/test";

// The time budgets of the browser tests are the reference PC's: a machine two or three times
// slower (a runner of the CI) would fail them while the page is the same. Each is scaled by how
// much slower than the PC this machine's browser lays a fixed text out, measured once a worker, on
// the blank page a test starts from, before the app is loaded. The factor is never under 1: a
// faster machine is held to the PC's budgets, as before. The workload is the browser's own work
// (parsing HTML, styling and laying it out), none of the app's code: a slower page of ours would
// not raise the factor and hide itself.

/** The best time of the workload in Chromium on the reference PC, in milliseconds: AMD Ryzen 7
 *  7800X3D, Windows 11, Playwright's headless Chromium, the machine quiet. Measured on 15/11/2026
 *  with the same workload in six freshly launched browsers, twelve runs each: 35 to 43 ms for the
 *  first, then 15.3 to 15.7 ms at best once three were done. The figure kept is a little above,
 *  so that the PC finds a factor of 1, or a few hundredths. */
const REFERENCE = 16;

const WARM_UPS = 3;
const RUNS = 9;

let factor: number | undefined;

/** How much slower than the reference PC this machine's browser lays out: 1 on the PC. */
export async function pageFactor(page: Page): Promise<number> {
  if (factor !== undefined) return factor;
  const best = await page.evaluate(
    ({ warmUps, runs }) => {
      const block =
        "<h3>The keeper's log</h3><p>She keeps the <b>lamp</b> lit for the ships, <i>always</i>, and counts them " +
        "in the <code>log</code> before dawn. The north shore is quiet tonight; <a href='#'>the tide table</a> " +
        "says the water turns at midnight, and <span style='color: #c0a060'>the old bell</span> rings once.</p>" +
        "<ul><li>rope, forty fathoms</li><li>a lantern with <em>new</em> glass</li><li>bread, salt and tea</li></ul>" +
        "<blockquote><p>The sea keeps what it takes. She writes it down anyway.</p></blockquote>";
      const html = block.repeat(Math.ceil(60_000 / block.length));
      const frame = document.createElement("div");
      frame.style.cssText = "position: absolute; top: 0; left: 0; width: 360px; visibility: hidden; font: 16px/1.5 sans-serif";
      document.body.append(frame);
      const times: number[] = [];
      for (let i = 0; i < warmUps + runs; i++) {
        const start = performance.now();
        frame.innerHTML = html;
        void frame.offsetHeight;
        frame.style.display = "none";
        void frame.offsetHeight;
        frame.style.display = "";
        void frame.offsetHeight;
        const time = performance.now() - start;
        if (i >= warmUps) times.push(time);
        frame.textContent = "";
      }
      frame.remove();
      return Math.min(...times);
    },
    { warmUps: WARM_UPS, runs: RUNS },
  );
  factor = Math.max(1, best / REFERENCE);
  console.info(`timed browser tests: factor ${factor.toFixed(2)} (reference workload ${best.toFixed(1)} ms here, ${REFERENCE} ms on the reference PC)`);
  return factor;
}

/** Fails when a time passes a budget of the reference PC, scaled to this machine. */
export function expectWithin(elapsed: number, budget: number, factorHere: number, what: string): void {
  const scaled = budget * factorHere;
  expect(elapsed, `${what}: ${Math.round(elapsed)} ms, budget ${budget} ms × factor ${factorHere.toFixed(2)} = ${Math.round(scaled)} ms`).toBeLessThan(scaled);
}
