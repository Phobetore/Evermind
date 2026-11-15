import { expect, test } from "vitest";
import { LAYOUT_BOUND, LAYOUT_COST_BOUND, PLAIN_PART, layoutCost, layoutRefusal, plainCuts, plainPart } from "./bounds";

function timed<T>(run: () => T): [T, number] {
  const start = performance.now();
  const result = run();
  return [result, performance.now() - start];
}

test("a long plain text is cut into parts, never inside a character", () => {
  const whole = "a".repeat(PLAIN_PART);
  expect(plainPart(whole, 0)).toEqual({ part: whole, count: 1 });
  expect(plainPart(whole + "b", 0).count).toBe(2);
  expect(plainPart(whole + "b", 1).part).toBe("b");

  // The two halves of an emoji fall on either side of the cut.
  const straddling = "a".repeat(PLAIN_PART - 1) + "😀" + "z";
  const first = plainPart(straddling, 0);
  const second = plainPart(straddling, 1);
  expect(first.count).toBe(2);
  expect(first.part).toBe("a".repeat(PLAIN_PART - 1));
  expect(second.part.startsWith("😀")).toBe(true);
  expect(first.part + second.part).toBe(straddling);

  // An index past the last gives the last.
  expect(plainPart(straddling, 9).part).toBe(second.part);

  // The parts are found in one walk, in time; then a part is had without walking again.
  const huge = "x".repeat(15 * 1024 * 1024);
  // repeat() makes a rope that the first read flattens, megabytes copied in one go: done before
  // the clock starts, so that only the walk is timed.
  huge.charCodeAt(0);
  const [cuts, walked] = timed(() => plainCuts(huge));
  expect(walked).toBeLessThan(500);
  const [part, elapsed] = timed(() => plainPart(huge, 70, cuts));
  expect(part.part.length).toBe(PLAIN_PART);
  expect(elapsed).toBeLessThan(5);
});

test("a plain part ends sooner where the browser would lay it out slowly", () => {
  // Measured in Chromium on 15/11: 100,000 characters changing direction at each one, 3.2 s;
  // Thai without a space, 2.1 s; Korean on one line, 3.4 s plain. Each part stays in the budget.
  const thai = "สวัสดีครับยินดีต้อนรับสู่ประภาคาร";
  for (const [name, text] of [
    ["changes of direction", "aא".repeat(100_000)],
    ["digits in a right-to-left text", "1א".repeat(100_000)],
    ["Thai without a space", thai.repeat(Math.ceil(200_000 / thai.length))],
    ["Korean on one line", "등대지기는 등불을 켠다 ".repeat(15_000)],
  ]) {
    const cuts = plainCuts(text);
    expect(cuts.length, name).toBeGreaterThan(2);
    let joined = "";
    for (let i = 0; i < cuts.length; i++) {
      const { part } = plainPart(text, i, cuts);
      expect(layoutCost(part) <= LAYOUT_COST_BOUND * 1.01 || part.length < PLAIN_PART, name).toBe(true);
      joined += part;
    }
    expect(joined, name).toBe(text);
  }
  // A cut is never inside a character: here before a Thai vowel sign that belongs to its letter.
  const marked = "กั".repeat(150_000);
  for (const cut of plainCuts(marked).slice(1)) expect(marked.charCodeAt(cut), String(cut)).not.toBe(0x0e31);
  // Latin, Greek and Cyrillic cost nothing more: one part.
  expect(plainCuts("The keeper of the lamp. Хранитель маяка. ".repeat(4_000))).toEqual([0]);
});

test("the cost of a text is counted without parsing it", () => {
  expect(layoutCost("a")).toBe(500);
  expect(layoutCost("*a*")).toBe(1_500);
  expect(layoutCost("> a")).toBe(1_503);
  expect(layoutCost(">>> a")).toBe(3_519);
  expect(layoutCost("- a\n  - b")).toBe(4_014);
  expect(layoutCost("- a\n\t- b")).toBe(4_014);
  expect(layoutCost("a\n\nb")).toBe(1_500);
  expect(layoutCost("a\r\nb")).toBe(1_000);
  expect(layoutCost("<b>&amp;\\")).toBe(2_000);
  expect(layoutCost("1. a")).toBe(1_503);
  expect(layoutCost("1986. a")).toBe(1_503);
  expect(layoutCost("1234567890. a")).toBe(500);
  expect(layoutCost("* * *")).toBe(3_519);

  // Tables, and the cells a row does not write.
  expect(layoutCost("|a|b|\n|-|-|\n|c|d|")).toBe(6_108);
  expect(layoutCost("|a|b|\n|-|-|\nx")).toBe(6_054);

  // Pipes out of a table.
  expect(layoutCost("a | b\nc | d")).toBe(1_000);
  expect(layoutCost("a | b\n:-|-")).toBe(2_008);
  expect(layoutCost("a | b\n---")).toBe(1_000);
  expect(layoutCost("**Age 0:** 25 | **Height:** 170 cm | *calm*")).toBe(5_500);

  // The browser's own layout of other scripts: a change of direction, the square of a block's
  // characters of other scripts than the simplest, a dictionary run.
  expect(layoutCost("aאa")).toBe(1_501);
  expect(layoutCost("a א a")).toBe(625);
  expect(layoutCost("Age 25, height 170")).toBe(500);
  expect(layoutCost("א 12 א")).toBe(625);
  expect(layoutCost("ไทย")).toBe(501);
  expect(layoutRefusal("aא".repeat(50_000))).toBe("tooDense");
  expect(layoutRefusal("สวัสดีครับ".repeat(10_000))).toBe("tooDense");
  expect(layoutRefusal("등대지기는 등불을 켠다 ".repeat(7_000))).toBe("tooDense");
  // A long text in another script, in paragraphs, is laid out.
  expect(layoutRefusal(("שלום עולם של המגדלור ".repeat(50) + "\n\n").repeat(90))).toBeNull();
  expect(layoutRefusal(("灯台守の物語はここから始まる。".repeat(100) + "\n\n").repeat(60))).toBeNull();

  // An indentation counts only the lists still open.
  expect(layoutCost(" ".repeat(60) + "b")).toBe(500);
  expect(layoutCost("- a\n\n" + " ".repeat(60) + "b")).toBe(3_506);

  // Lines squared under a container only.
  expect(layoutCost(Array(300).fill("a*").join("\n"))).toBe(480_000);
  expect(layoutCost(Array(300).fill("> a*").join("\n"))).toBe(960_600);
  expect(layoutCost("> a\n" + Array(300).fill("a*").join("\n"))).toBe(662_703);

  // The pairs of a line.
  expect(layoutCost(Array(300).fill("*a*").join("\n"))).toBe(450_000);
  expect(layoutCost("**a** *b*")).toBe(3_500);
  expect(layoutCost("*a*, b")).toBe(1_500);
  expect(layoutCost("~~a~~")).toBe(2_500);
  expect(layoutCost("a* a*")).toBe(1_506);
  expect(layoutCost("*a* b*")).toBe(2_004);
  expect(layoutCost("_a_ *b")).toBe(2_004);
  expect(layoutCost("`*a` a*")).toBe(2_534);
  expect(layoutCost("\\*a* b")).toBe(2_006);

  // Runs of backticks; after a backslash, a run opens one shorter, and two may then wait together.
  expect(layoutCost("x ` `` ``` word")).toBe(3_606);
  expect(layoutCost("x \\`` \\`` y")).toBe(3_540);

  // A label, at its "]": its characters from its "[", and far more its blanks; twice for an image.
  expect(layoutCost("[a\tb]")).toBe(1_508);
  expect(layoutCost("![a\tb](c)")).toBe(1_509);

  // HTML openers.
  expect(layoutCost("<!-- a")).toBe(1_002);
  expect(layoutCost("<!-- a --> b")).toBe(1_003);
  expect(layoutCost("x <!-- a\nb\n\nc")).toBe(2_503);
  expect(layoutCost("<?x a ?> <![CDATA[ b ]]> <!DOCTYPE c> d")).toBe(4_036);

  // Link titles.
  expect(layoutCost("[a](b (c d e f")).toBe(1_511);
  expect(layoutCost("[a](b (c) d e f")).toBe(1_508);
  expect(layoutCost("[a](b (c\\) d")).toBe(2_010);
  expect(layoutCost("[a](b\n(c d")).toBe(2_011);
  expect(layoutCost("x (c d e f")).toBe(500);

  // Each is counted in time, however long.
  let runs = "";
  for (let n = 1; runs.length < 2_000_000; n++) runs += "`".repeat(n) + " ";
  for (const text of [
    "a".repeat(8 * 1024 * 1024),
    Array(4_000_000).fill("a").join("\n"),
    "<!--".repeat(2_000_000),
    runs,
    "[a](b " + " (".repeat(1_000_000),
    "![\t".repeat(1_000_000) + "]".repeat(1_000_000),
    "\\`` ".repeat(1_000_000),
  ]) {
    const [, elapsed] = timed(() => layoutCost(text));
    expect(elapsed).toBeLessThan(500);
  }

  expect(layoutRefusal("a".repeat(LAYOUT_BOUND + 1))).toBe("tooLong");
  expect(layoutRefusal(">".repeat(5_000))).toBe("tooDense");
  expect(layoutRefusal("a")).toBeNull();
  expect(layoutRefusal("a".repeat(200_000), 0)).toBeNull();
}, 30_000);
