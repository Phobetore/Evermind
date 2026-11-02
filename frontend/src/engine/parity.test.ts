import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import * as defaults from "./defaults";
import { hasOriginalMacro, substitute, substituteOriginal } from "./macros";
import { pyLstrip, pyRstrip, pyStrip } from "./text";
import { estimateTokens } from "./tokens";

// The cases in parity/ at the root of the repository are the ones the Python
// engine runs too (backend/tests/test_parity.py): the Python is the reference,
// and `expected` is what it wrote.

interface ParityCase {
  fn: string;
  name: string;
  input: unknown;
  expected: unknown;
}

// The twin of FUNCTIONS in backend/tests/parity_cases.py: the same names, and
// each one adapts the case's input object to the arguments of the function.
const adapt =
  <I>(run: (input: I) => unknown) =>
  (input: unknown) =>
    run(input as I);

const FUNCTIONS: Record<string, (input: unknown) => unknown> = {
  substitute: adapt<{ text: string; char_name: string; user_name: string }>((i) =>
    substitute(i.text, i.char_name, i.user_name),
  ),
  substitute_original: adapt<{ text: string; original: string }>((i) =>
    substituteOriginal(i.text, i.original),
  ),
  has_original_macro: adapt<{ text: string }>((i) => hasOriginalMacro(i.text)),
  estimate_tokens: adapt<{ text: string }>((i) => estimateTokens(i.text)),
  py_strip: adapt<{ text: string }>((i) => pyStrip(i.text)),
  py_lstrip: adapt<{ text: string }>((i) => pyLstrip(i.text)),
  py_rstrip: adapt<{ text: string }>((i) => pyRstrip(i.text)),
  default_prompts: () => ({ ...defaults }),
};

const dir = fileURLToPath(new URL("../../../parity/", import.meta.url));
const files = readdirSync(dir)
  .filter((name) => name.endsWith(".json"))
  .sort();
const loaded = files.map((name) => ({
  name,
  cases: (JSON.parse(readFileSync(dir + name, "utf8")) as { cases: ParityCase[] }).cases,
}));

describe("the shared cases", () => {
  it("are found and read", () => {
    // A wrong path would otherwise run no case at all and pass.
    expect(files.length).toBeGreaterThanOrEqual(4);
    expect(loaded.reduce((n, file) => n + file.cases.length, 0)).toBeGreaterThanOrEqual(20);
  });

  it("name exactly the registered functions", () => {
    // Both ways: a case with no function, and a function that no case calls.
    const named = new Set(loaded.flatMap((file) => file.cases.map((c) => c.fn)));
    expect([...named].sort()).toEqual(Object.keys(FUNCTIONS).sort());
  });
});

for (const { name, cases } of loaded) {
  describe(name, () => {
    for (const c of cases) {
      it(`${c.fn}: ${c.name}`, () => {
        const run = FUNCTIONS[c.fn];
        expect(run, `no function registered for "${c.fn}"`).toBeDefined();
        expect(run(c.input)).toEqual(c.expected);
      });
    }
  });
}
