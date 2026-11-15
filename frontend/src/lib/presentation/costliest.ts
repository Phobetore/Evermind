// A test helper: no file of the application imports it. The costly kinds of markup measured to
// set LAYOUT_COST_BOUND, so that the tests of the presentation and of the conversation lay out
// the worst of each at the largest size the bound lets through.
import { LAYOUT_BOUND, layoutRefusal } from "./bounds";

const lines = (motif: string) => (count: number) => Array(count).fill(motif).join("\n");
const numbered = (motif: (n: number) => string) => (count: number) =>
  Array.from({ length: count }, (_, n) => motif(n)).join("\n");

/** Filled with letters up to LAYOUT_BOUND characters, or left as it is when longer. */
function letters(text: string): string {
  return text + "a".repeat(Math.max(0, LAYOUT_BOUND - text.length));
}

/** Filled with words up to LAYOUT_BOUND characters, or left as it is when longer. */
function words(text: string): string {
  if (text.length >= LAYOUT_BOUND) return text;
  return text + " word".repeat(Math.ceil((LAYOUT_BOUND - text.length) / 5)).slice(0, LAYOUT_BOUND - text.length);
}

/** Filled with `unit` up to LAYOUT_BOUND characters between `count` openers and their closers. */
function around(open: string, close: string, unit: string) {
  return (count: number) => {
    const room = Math.max(0, LAYOUT_BOUND - count * (open.length + close.length));
    return open.repeat(count) + unit.repeat(Math.ceil(room / unit.length)).slice(0, room) + close.repeat(count);
  };
}

/** Filled with letters each followed by a tab up to LAYOUT_BOUND characters: a tab makes each
 *  character a piece of its own for the parser. */
function tabbed(text: string): string {
  const room = Math.max(0, LAYOUT_BOUND - text.length);
  return text + "a\t".repeat(Math.ceil(room / 2)).slice(0, room);
}

function backtickRuns(count: number): string {
  let runs = "";
  for (let n = 1; n <= count; n++) runs += "`".repeat(n) + " ";
  return runs;
}

function columns(count: number, cell: string): string {
  return "|" + Array(count).fill(cell).join("|") + "|";
}

/** Each costly kind of markup measured to set LAYOUT_COST_BOUND, as a function of how many times
 *  its motif is repeated (the list is in the test « the costliest markup of each kind… »). */
export const COSTLIEST: Record<string, (count: number) => string> = {
  // On a single line.
  "nested quotes": (n) => ">".repeat(n) + " x",
  "nested bullets": (n) => "- ".repeat(n) + "x",
  "nested numbers": (n) => "1. ".repeat(n) + "x",
  "nested mixed containers": (n) => "> - 1. ".repeat(n) + "x",
  // Lists by indentation.
  "a list indented line by line": numbered((i) => " ".repeat(2 * i) + "- a"),
  "a list indented line by line, blank lines between": (n) =>
    Array.from({ length: n }, (_, i) => " ".repeat(2 * i) + "- a").join("\n\n"),
  "lines of twelve bullets": lines("- ".repeat(12) + "a"),
  "lines of twelve bullets, blank lines between": (n) =>
    Array(n).fill("- ".repeat(12) + "a").join("\n\n"),
  // Unpaired emphasis.
  "a* repeated": (n) => "a* ".repeat(n),
  "a*b repeated": (n) => "a*b".repeat(n),
  "a**b repeated": (n) => "a**b".repeat(n),
  "a~~ repeated": (n) => "a~~ ".repeat(n),
  "openers then closers": (n) => "*a ".repeat(n) + "x" + " a*".repeat(n),
  // Brackets.
  "closing brackets": (n) => "]".repeat(n),
  "brackets opened then closed": (n) => "[".repeat(n) + "]".repeat(n),
  "unfinished links": (n) => "[a](".repeat(n),
  "unfinished references": (n) => "[a][".repeat(n),
  // Labels around a long span, which the parser goes over again at each "]": its blanks above all.
  "brackets around letters": around("[", "]", "a"),
  "brackets around words": around("[", "]", "word "),
  "brackets around tabbed letters": around("[", "]", "a\t"),
  "images around letters": around("![", "](a)", "a"),
  "images around words": around("![", "](a)", "word "),
  "images around tabbed letters": around("![", "](a)", "a\t"),
  // A "[" the parser never takes for a label's start, above its "]": that "]" closes a real "["
  // far below, over the whole span.
  "brackets over code spans, around tabbed letters": around("[", "`[`]", "a\t"),
  "brackets over code spans, around words": around("[", "`[`]", "word "),
  "brackets over autolinks, around tabbed letters": around("[", "<http://a.example/[>]", "a\t"),
  "brackets over autolinks, around words": around("[", "<http://a.example/[>]", "word "),
  "brackets over a tag's attribute, around tabbed letters": around("[", "<b x='['>]", "a\t"),
  "brackets over a tag's attribute, around words": around("[", "<b x='['>]", "word "),
  // Containers that go on over plain lines.
  "a quote then plain lines": (n) => "> a\n" + lines("b")(n),
  "a list item then plain lines": (n) => "- a\n" + lines("b")(n),
  // Tables.
  "a table of two columns": (n) => "|a|b|\n|-|-|\n" + lines("|c|d|")(n),
  "a square table": (n) =>
    [columns(n, "a"), columns(n, "-"), ...Array(n).fill(columns(n, "c"))].join("\n"),
  "a hundred columns over rows without pipes": (n) =>
    [columns(100, "a"), columns(100, "-"), ...Array(n).fill("x")].join("\n"),
  "many columns over a hundred rows without pipes": (n) =>
    [columns(n, "a"), columns(n, "-"), ...Array(100).fill("x")].join("\n"),
  // Blocks.
  "paragraphs": (n) => "a\n\n".repeat(n),
  "list items between blank lines": (n) => "- a\n\n".repeat(n),
  "headings": (n) => "# a\n\n".repeat(n),
  "inline tags": (n) => "a <b>b</b> ".repeat(n),
  // Lines of a single break, without a container: only what does not close on its line is
  // squared.
  "lines opening then lines closing": (n) => lines("*a")(n) + "\n" + lines("a*")(n),
  "lines of brackets opened then closed": (n) => lines("[")(n) + "\n" + lines("]")(n),
  "lines of a closing bracket": lines("]"),
  "lines of a backtick": lines("`a"),
  "lines of a tilde pair": lines("~~a"),
  "lines of an underscore": lines("_a"),
  "lines of two closing underscores": lines("a_ a_"),
  "lines of two closing stars": lines("xx a* a*"),
  "lines of an unfinished link": lines("[a]("),
  "lines of an unfinished reference": lines("[a]["),
  "lines of a pair then a closer": lines("*a* b*"),
  "lines of a star and a double star": lines("*a**b c"),
  "lines of a double star and a star": lines("**a* b"),
  "lines of a code span then a closer": lines("`*a` a*"),
  "lines of an escape then a closer": lines("\\*a* b"),
  "lines of punctuation pairs": lines("*.* *,* x"),
  "lines of three pairs": lines("*a* *b* *c*"),
  "lines of prose with one pair": lines(
    "She keeps the lighthouse on the north shore, *quietly* tending the lamp through every storm.",
  ),
  "lines of a bold label and an italic action": numbered(
    (n) => `**Trait ${n}:** she keeps the lamp lit, *quietly*, and never speaks of the wreck.`,
  ),
  "lines of a datasheet": numbered((n) => `**Age ${n}:** 25 | **Height:** 170 cm | *calm*`),
  // Pipes out of a table.
  "lines of pipes": lines("a | b | c | d | e | f"),
  "lines of a pair split by a pipe": lines("*a | b* c"),
  "lines of a pipe then an opener": lines("| *a"),
  "pipes on one line": (n) => "a | ".repeat(n),
  // HTML openers without their end.
  "comments without end": (n) => letters("x " + "<!--".repeat(n)),
  "instructions without end": (n) => letters("x " + "<?".repeat(n)),
  "cdata without end": (n) => letters("x " + "<![CDATA[".repeat(n)),
  "declarations without end": (n) => letters("x " + "<!A".repeat(n)),
  "comments without end, then a line of words": (n) => words("x " + "<!--".repeat(n) + "\n"),
  "instructions without end, then a line of words": (n) => words("x " + "<?".repeat(n) + "\n"),
  "cdata without end, then a line of words": (n) => words("x " + "<![CDATA[".repeat(n) + "\n"),
  "declarations without end, then a line of words": (n) => words("x " + "<!A".repeat(n) + "\n"),
  "lines of a comment without end, then words": (n) => words(lines("x <!-- y")(n) + "\n"),
  // Runs of backticks.
  "backtick runs of every length": (n) => words("x " + backtickRuns(n)),
  "backtick runs of every length, then a line of words": (n) => words("x " + backtickRuns(n) + "\n"),
  "ten backtick runs, then words": (n) => "x " + backtickRuns(10) + "word ".repeat(n),
  "single backticks, then words": (n) => words("x " + "` ".repeat(n)),
  // A backslash before a run: it opens one shorter, and no run of its own length closes it.
  "escaped backtick runs, then words": (n) => words("x " + "\\`` ".repeat(n)),
  "escaped backtick runs, then tabbed letters": (n) => tabbed("x " + "\\`` ".repeat(n)),
  "lines of a backtick, then words": (n) => words(lines("`a")(n) + "\n"),
  // Link titles without their ")".
  "titles without end": (n) => words("x " + "[a](b (".repeat(n)),
  "image titles without end": (n) => words("x " + "![a](b (".repeat(n)),
  "titles after an enclosed destination": (n) => words("x " + "[a](<b> (".repeat(n)),
  "titles on the next line": (n) => words("x " + "[a](b\n(".repeat(n)),
  "lines of a title without end, then words": (n) => words(lines("x [a](b (")(n) + "\n"),
};

/** The text of a kind at the largest count layoutRefusal lets through, found by bisection. */
export function largestLaidOut(kind: (count: number) => string): string {
  const fits = (count: number) => layoutRefusal(kind(count)) === null;
  if (!fits(1)) return kind(0);
  let low = 1;
  let high = 2;
  while (fits(high)) {
    low = high;
    high *= 2;
  }
  // low fits, high does not.
  while (high - low > 1) {
    const middle = Math.floor((low + high) / 2);
    if (fits(middle)) low = middle;
    else high = middle;
  }
  return kind(low);
}
