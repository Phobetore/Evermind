// For the tests only: the time budgets of the timed tests are the reference PC's, and this file
// scales them to the machine the tests run on. A runner of the CI two or three times slower than
// the PC failed them by a few milliseconds while the code was the same.
//
// Before the first test of a file that imports it, it times fixed workloads of the same kinds as
// the timed ones, and compares them with the time the same workloads take on the reference PC. The
// factor is never under 1: a faster machine is held to the PC's budgets, as before. It measures
// there, and not when a budget is first asked for, because the heap a test leaves behind (7 MB of
// image bytes, 200,000 keys) slowed the same walk by a third on the PC, which the PC's figure,
// taken in a fresh process, does not know of.
//
// The workloads never call this project's code: a slower layout or count of ours would slow the
// workload too, and the factor would hide the very slowness the tests are there to catch. They run
// the same libraries (the Markdown and HTML parsers, in their production builds) and the same kind
// of string walk, which the project does not change. Upgrading the parsers may change their time:
// measure the reference again then (see REFERENCE below).
import rehypeRaw from "rehype-raw";
import rehypeSanitize from "rehype-sanitize";
import remarkParse from "remark-parse";
import remarkRehype from "remark-rehype";
import { unified } from "unified";
import { beforeAll, expect } from "vitest";

/** The kind of work a budget times: laying a text out (renderPresentation, rpMarkdown: a count,
 *  then a parse through the Markdown and HTML parsers), or counting it alone (walking its
 *  characters and matching expressions, as the bounds, the images, the links and the styles do). */
export type Work = "layout" | "count";

/** The two workloads timed: a parse of a fixed honest text, a walk of a fixed long one. */
type Workload = "parse" | "count";

/** The time of each workload on the reference PC, in milliseconds: AMD Ryzen 7 7800X3D, Windows 11,
 *  Node 22.16, the machine quiet (9 % load, nothing else running). Measured on 15/11/2026 by
 *  measureWorkloads() as the tests make it, before the first test of each file: four runs of
 *  `npx vitest run --project timed`, 28 files. Parse 31.7 to 53.4 ms, 26 of 28 between 31.7 and
 *  38.5; count 12.0 to 14.5 ms, 27 of 28 between 12.0 and 13.1. The figure kept is the top of the
 *  usual ones, so that the PC finds a factor of 1, or a few hundredths. */
const REFERENCE: Record<Workload, number> = { parse: 37, count: 12.8 };

// The best of the runs, after the engine has compiled the workload: a run slowed by the collector
// or by a burst of another process says nothing of the machine's speed. The walk needs more runs
// before the engine settles on its fastest code: alone in a fresh process on the PC, after six
// runs, one process of twelve still took 16.8 ms at best; after twelve, none passed 14.6.
const WARM_UPS: Record<Workload, number> = { parse: 6, count: 12 };
const RUNS: Record<Workload, number> = { parse: 13, count: 15 };

/** An honest card text of some 40 kB: paragraphs with emphasis, code, links and a few tags, lists
 *  and quotes, as a card is written. Built the same way at each call. */
function referenceText(): string {
  const blocks: string[] = [];
  for (let n = 0; blocks.join("\n\n").length < 40_000; n++) {
    blocks.push(
      `## The keeper's log, night ${n}`,
      `She keeps the **lamp** lit for the ships, *always*, and counts them in the \`log\` before dawn. ` +
        `The <b>north shore</b> is quiet tonight; [the tide table](https://tides.example/${n}) says the water ` +
        `turns at ${n % 12} o'clock, and <span style="color: #c0a060">the old bell</span> rings once.`,
      `- rope, ${n} fathoms\n- a lantern with *new* glass\n- bread, salt and **tea**`,
      `> The sea keeps what it takes.\n> She writes it down anyway, line ${n}.`,
      `1. Climb the stairs.\n2. Trim the wick.\n3. Wait for the ${n % 7 === 0 ? "storm" : "boats"}.`,
    );
  }
  return blocks.join("\n\n");
}

/** A text of 2 MB to walk, of words, marks and blanks. */
function referenceWalk(): string {
  const line = "She keeps the [lamp] lit, *always*, `log` <b>bell</b> \\* 12 ships!\n";
  return line.repeat(Math.ceil(2_000_000 / line.length)).slice(0, 2_000_000);
}

const parseRun = (() => {
  let processor: ReturnType<typeof build> | undefined;
  let text = "";
  function build() {
    return unified().use(remarkParse).use(remarkRehype, { allowDangerousHtml: true }).use(rehypeRaw).use(rehypeSanitize);
  }
  return () => {
    processor ??= build();
    text ||= referenceText();
    return processor.runSync(processor.parse(text));
  };
})();

const countRun = (() => {
  let text = "";
  return () => {
    if (!text) {
      text = referenceWalk();
      text.charCodeAt(0);
    }
    // A walk of every character that keeps runs and depths, as layoutCost does, and expressions
    // over the whole text, as the measure of lengths does.
    let marks = 0;
    let run = 0;
    let longest = 0;
    let depth = 0;
    for (let i = 0; i < text.length; i++) {
      const code = text.charCodeAt(i);
      if (code === 0x5b) depth++;
      else if (code === 0x5d && depth > 0) depth--;
      if (code === 0x2a || code === 0x60 || code === 0x3c || code === 0x5c) {
        marks++;
        run++;
        if (run > longest) longest = run;
      } else run = 0;
    }
    // test() keeps no match: the time is the expression's, not the collector's.
    let words = 0;
    const word = /[A-Za-z]+/g;
    while (word.test(text)) words++;
    let tags = 0;
    const tag = /<\/?[a-z]+>/g;
    while (tag.test(text)) tags++;
    return marks + longest + depth + words + tags;
  };
})();

const RUNNERS: Record<Workload, () => unknown> = { parse: parseRun, count: countRun };

/** The best time of one run of each workload on this machine, in milliseconds, after warm-ups.
 *  Their runs alternate, spread over the second the measure takes: a burst of another process
 *  slows a few runs of each, not all the runs of one. */
function measureWorkloads(): Record<Workload, number> {
  const best: Record<Workload, number> = { parse: Infinity, count: Infinity };
  for (const workload of ["count", "parse"] as const) for (let i = 0; i < WARM_UPS[workload]; i++) RUNNERS[workload]();
  for (let i = 0; i < Math.max(RUNS.parse, RUNS.count); i++)
    for (const workload of ["count", "parse"] as const) {
      if (i >= RUNS[workload]) continue;
      const start = performance.now();
      RUNNERS[workload]();
      best[workload] = Math.min(best[workload], performance.now() - start);
    }
  return best;
}

let factors: Record<Workload, number> | undefined;
let measuredAt = -Infinity;

function measure(): Record<Workload, number> {
  const times = measureWorkloads();
  measuredAt = performance.now();
  const found = { parse: Math.max(1, times.parse / REFERENCE.parse), count: Math.max(1, times.count / REFERENCE.count) };
  for (const workload of ["count", "parse"] as const)
    console.info(
      `timed tests: ${workload} factor ${found[workload].toFixed(2)} (reference workload ` +
        `${times[workload].toFixed(1)} ms here, ${REFERENCE[workload]} ms on the reference PC)`,
    );
  return found;
}

function workloadFactors(): Record<Workload, number> {
  factors ??= measure();
  return factors;
}

/** After a time past its budget: the machine measured again, at most every five seconds, and the
 *  slower of the two measures kept. A machine shared with others (a runner of the CI, or the PC
 *  with something else at work) can slow for seconds after the measure at the start of the file;
 *  the budget then follows it. On a quiet machine the factor stays where it was, and so does the
 *  budget: a layout of ours grown slower is still caught, the workloads never running our code. */
function measureAgain(): void {
  const before = workloadFactors();
  if (performance.now() - measuredAt < 5_000) return;
  const now = measure();
  factors = { parse: Math.max(before.parse, now.parse), count: Math.max(before.count, now.count) };
}

/** Whether a time is within a budget of the reference PC scaled to this machine, the machine
 *  measured again first when it is not. */
export function within(elapsed: number, budget: number, work: Work): boolean {
  if (elapsed < scaled(work, budget)) return true;
  measureAgain();
  return elapsed < scaled(work, budget);
}

/** How much slower than the reference PC this machine does a kind of work: 1 on the PC and on a
 *  faster machine, 2.5 on one that takes two and a half times as long. Measured once a test file.
 *  A layout counts its text before it parses it, and many a timed layout ends at the count: its
 *  factor is the larger of the two. */
export function machineFactor(work: Work): number {
  const { count, parse } = workloadFactors();
  return work === "count" ? count : Math.max(count, parse);
}

beforeAll(() => {
  workloadFactors();
});

/** A budget of the reference PC, in milliseconds, scaled to this machine. */
export function scaled(work: Work, budget: number): number {
  return budget * machineFactor(work);
}

/** How a budget reads in a failure: the PC's, the factor, and what it came to here. */
export function budgetText(work: Work, budget: number): string {
  return `budget ${budget} ms × ${work} factor ${machineFactor(work).toFixed(2)} = ${scaled(work, budget).toFixed(0)} ms`;
}

/** Fails when a time passes the budget of the reference PC, scaled to this machine. */
export function expectWithin(elapsed: number, budget: number, work: Work, what?: string): void {
  within(elapsed, budget, work);
  const said = `${what ? what + ": " : ""}${elapsed.toFixed(1)} ms, ${budgetText(work, budget)}`;
  expect(elapsed, said).toBeLessThan(scaled(work, budget));
}
