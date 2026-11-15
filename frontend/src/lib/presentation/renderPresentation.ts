import type { Element, ElementContent, Properties, Root, RootContent, Text } from "hast";
import type { TableRow } from "mdast";
import { gfmStrikethroughFromMarkdown } from "mdast-util-gfm-strikethrough";
import { gfmTableFromMarkdown } from "mdast-util-gfm-table";
import { gfmStrikethrough } from "micromark-extension-gfm-strikethrough";
import { gfmTable } from "micromark-extension-gfm-table";
import rehypeRaw from "rehype-raw";
import rehypeSanitize from "rehype-sanitize";
import remarkParse from "remark-parse";
import remarkRehype, { defaultHandlers } from "remark-rehype";
import { type Processor, unified } from "unified";
import {
  ATTRIBUTE_NAMES_BOUND,
  COPIED_BOUND,
  INLINE_IMAGES_BOUND,
  INLINE_PIXEL_BUDGET,
  LAYOUT_BOUND,
  REBUILT_BOUND,
  SPAN_BUDGET,
  layoutRefusal,
} from "./bounds";
import { INLINE_IMAGE, imageSource } from "./images";
import { linkTarget, misleadingHost } from "./links";
import { boundDepth, modelDialect, noDefinitions } from "./markdown";
import { PRESENTATION_SCHEMA } from "./schema";
import { INHERITED_COLOR, cleanDeclarations, colorAlpha } from "./style";

export type RenderedPresentation =
  | { kind: "laid-out"; tree: Root; remoteHosts: string[] } // hosts of remote images, each once, in order
  | { kind: "plain"; reason: "tooLong" | "tooDense" | "failed" };

/** The payloads of the images written into a text, added up: what follows the comma of each
 *  match of INLINE_IMAGE. One pass: the expression repeats a single class, and cannot go back. */
function inlinePayloads(text: string): number {
  let total = 0;
  for (const found of text.matchAll(INLINE_IMAGE)) total += found[0].length - found[0].indexOf(",") - 1;
  return total;
}

/** The length the bound is measured on before any parsing: the text less the payload of each
 *  match of INLINE_IMAGE. Only a first, generous measure: after cardRules, the payloads of the
 *  sources it keeps as images are the only ones left out. */
export function layoutLength(text: string): number {
  return text.length - inlinePayloads(text);
}

/** The payloads layoutLength leaves out, added up: measured against INLINE_IMAGES_BOUND. */
export function inlineImagesLength(text: string): number {
  return inlinePayloads(text);
}

// The states of HTML's tokenizer a tag goes through (WHATWG HTML §13.2.5).
const TAG_NAME = 0;
const BEFORE_ATTRIBUTE_NAME = 1;
const ATTRIBUTE_NAME = 2;
const AFTER_ATTRIBUTE_NAME = 3;
const BEFORE_ATTRIBUTE_VALUE = 4;
const DOUBLE_QUOTED = 5;
const SINGLE_QUOTED = 6;
const UNQUOTED = 7;
const AFTER_QUOTED_VALUE = 8;
const SELF_CLOSING = 9;
const END = 10;
// Added to the state a step returns when the step starts an attribute name.
const NAME_STARTED = 16;
// The states an ordinary character moves out of; the others keep it as part of a name or value.
const MOVING =
  (1 << BEFORE_ATTRIBUTE_NAME) |
  (1 << AFTER_ATTRIBUTE_NAME) |
  (1 << BEFORE_ATTRIBUTE_VALUE) |
  (1 << AFTER_QUOTED_VALUE) |
  (1 << SELF_CLOSING);
// The characters that move a tag along, start one, or start or end what could hide one: blanks,
// quotes, "/", "<", "=", ">". Any other character changes nothing in the states that keep it.
const SPECIAL = new Uint8Array(65_536);
for (const code of [9, 10, 12, 13, 32, 34, 39, 47, 60, 61, 62]) SPECIAL[code] = 1;

function isTagBlank(code: number): boolean {
  return code === 9 || code === 10 || code === 12 || code === 13 || code === 32;
}

function isAsciiLetter(code: number): boolean {
  return (code >= 65 && code <= 90) || (code >= 97 && code <= 122);
}

/** One character through a tag's states, with HTML's reconsumes followed. */
function step(state: number, code: number): number {
  const blank = isTagBlank(code);
  switch (state) {
    case TAG_NAME:
      if (blank) return BEFORE_ATTRIBUTE_NAME;
      if (code === 47) return SELF_CLOSING;
      if (code === 62) return END;
      return TAG_NAME;
    case BEFORE_ATTRIBUTE_NAME:
      if (blank) return BEFORE_ATTRIBUTE_NAME;
      if (code === 47) return SELF_CLOSING;
      if (code === 62) return END;
      return ATTRIBUTE_NAME + NAME_STARTED;
    case ATTRIBUTE_NAME:
      if (blank) return AFTER_ATTRIBUTE_NAME;
      if (code === 47) return SELF_CLOSING;
      if (code === 62) return END;
      if (code === 61) return BEFORE_ATTRIBUTE_VALUE;
      return ATTRIBUTE_NAME;
    case AFTER_ATTRIBUTE_NAME:
      if (blank) return AFTER_ATTRIBUTE_NAME;
      if (code === 47) return SELF_CLOSING;
      if (code === 61) return BEFORE_ATTRIBUTE_VALUE;
      if (code === 62) return END;
      return ATTRIBUTE_NAME + NAME_STARTED;
    case BEFORE_ATTRIBUTE_VALUE:
      if (blank) return BEFORE_ATTRIBUTE_VALUE;
      if (code === 34) return DOUBLE_QUOTED;
      if (code === 39) return SINGLE_QUOTED;
      if (code === 62) return END;
      return UNQUOTED;
    case DOUBLE_QUOTED:
      return code === 34 ? AFTER_QUOTED_VALUE : DOUBLE_QUOTED;
    case SINGLE_QUOTED:
      return code === 39 ? AFTER_QUOTED_VALUE : SINGLE_QUOTED;
    case UNQUOTED:
      if (blank) return BEFORE_ATTRIBUTE_NAME;
      if (code === 62) return END;
      return UNQUOTED;
    case AFTER_QUOTED_VALUE:
      if (blank) return BEFORE_ATTRIBUTE_NAME;
      if (code === 47) return SELF_CLOSING;
      if (code === 62) return END;
      return ATTRIBUTE_NAME + NAME_STARTED;
    default: // SELF_CLOSING
      if (code === 62) return END;
      if (blank) return BEFORE_ATTRIBUTE_NAME;
      if (code === 47) return SELF_CLOSING;
      return ATTRIBUTE_NAME + NAME_STARTED;
  }
}

// The names this pass knows. Formatting names (HTML's list of formatting elements) and the names
// whose content parse5 reads as text are bits 0 to 23 of `low`; the names that end the scope of
// an element opened before them are the bits of `high`.
const FORMATTING_NAMES = ["a", "b", "big", "code", "em", "font", "i", "nobr", "s", "small", "strike", "strong", "tt", "u"];
const RAW_NAMES = ["iframe", "noembed", "noframes", "noscript", "plaintext", "script", "style", "textarea", "title", "xmp"];
const SCOPE_NAMES = ["applet", "caption", "marquee", "math", "object", "select", "svg", "table", "td", "template", "th"];
const RAW_FIRST = FORMATTING_NAMES.length;
const KNOWN = new Map<string, { low: number; high: number }>();
FORMATTING_NAMES.forEach((name, i) => KNOWN.set(name, { low: 1 << i, high: 0 }));
RAW_NAMES.forEach((name, i) => KNOWN.set(name, { low: 1 << (RAW_FIRST + i), high: 0 }));
SCOPE_NAMES.forEach((name, i) => KNOWN.set(name, { low: 0, high: 1 << i }));
const FORMATTING_MASK = (1 << RAW_FIRST) - 1;
const LONGEST_KNOWN = 9;

/** The candidates followed together in one state. */
interface Slot {
  active: boolean;
  names: number;
  attributeStart: number;
  start: boolean;
  low: number;
  high: number;
  several: boolean;
  firstLt: number;
  nameStart: number;
  // For an end candidate alone: nothing could hide it from parse5 at its "<"…
  clear: boolean;
  // …but the raw counters above 0 then, as bits.
  rawAtLt: number;
}

function emptySlot(): Slot {
  return { active: false, names: 0, attributeStart: 0, start: false, low: 0, high: 0, several: false, firstLt: 0, nameStart: 0, clear: false, rawAtLt: 0 };
}

function copySlot(target: Slot, source: Slot): void {
  target.active = true;
  target.names = source.names;
  target.attributeStart = source.attributeStart;
  target.start = source.start;
  target.low = source.low;
  target.high = source.high;
  target.several = source.several;
  target.firstLt = source.firstLt;
  target.nameStart = source.nameStart;
  target.clear = source.clear;
  target.rawAtLt = source.rawAtLt;
}

/** Two candidates in the same state after the same character have the same future. */
function mergeSlot(target: Slot, source: Slot): void {
  if (!target.active) {
    copySlot(target, source);
    return;
  }
  target.names = Math.max(target.names, source.names);
  target.attributeStart = Math.min(target.attributeStart, source.attributeStart);
  target.start = target.start || source.start;
  target.low |= source.low;
  target.high |= source.high;
  target.several = true;
  target.firstLt = Math.min(target.firstLt, source.firstLt);
  // Of names still being read, only the one from the latest "<" can be a known name.
  target.nameStart = Math.max(target.nameStart, source.nameStart);
  target.clear = false;
}

/** What the HTML parser (parse5, through rehype-raw) will do with the raw HTML it is handed, read
 *  before it reads any of it. Only upper bounds: whatever this pass cannot be sure of counts more,
 *  never less.
 *  `chunks`: the values of the `raw` nodes remark-rehype makes, in document order, read as one
 *  text: what parse5 reads, a container's markers already out of it (`> <b a0\n> a1>` hands it
 *  `<b a0\na1>`), a code span or an escaped "<" never in it, which is why this is not read on
 *  the text. `cells[i]`: the number of the table cell that Markdown made (a `td` or `th` of the
 *  tree, numbered from 0 in document order) holding chunk i, -1 outside any; all -1 when left
 *  out.
 *  Candidates. Every "<" followed by an ASCII letter, and every "</" followed by one, may start a
 *  tag (a candidate: a start candidate from "<", an end candidate from "</"). Which ones do
 *  depends on what the parser is in (a comment, a <style>, a <textarea>, an svg), which this
 *  pass does not follow: it follows every candidate at once, through the tag states of HTML's
 *  tokenizer (WHATWG HTML §13.2.5: tag name, before attribute name, attribute name, after
 *  attribute name, before attribute value, double-quoted, single-quoted and unquoted attribute
 *  value, after attribute value (quoted), self-closing start tag), each with its transitions as
 *  written there, a blank being tab, line feed, form feed, carriage return or space. A candidate
 *  enters "tag name" on the letter after "<" or "</"; it ends at the ">" that ends its tag in
 *  these states, or at the end of the text.
 *  A candidate's name: its characters from its letter to where it leaves "tag name", compared in
 *  lower case with the 35 names this pass knows, never read past nine characters: HTML's
 *  formatting names (a, b, big, code, em, font, i, nobr, s, small, strike, strong, tt, u), the
 *  names whose content parse5 reads as text (iframe, noembed, noframes, noscript, plaintext,
 *  script, style, textarea, title, xmp), and the names that end the scope of an element opened
 *  before them (applet, caption, marquee, math, object, select, svg, table, td, template, th).
 *  Its attribute text: from where it leaves "tag name" to its end, its ">" not included. Its
 *  names: how many attribute names it started (on entering "attribute name"), duplicates included.
 *  Merging. Two candidates in the same state after the same character have the same future: they
 *  go on as one slot, and end together. So at most ten slots are followed at once, in a fixed
 *  array (no allocation per character), and each character is read at most eleven times. A slot
 *  keeps, for all the candidates it holds: the larger count of names; the earliest point where
 *  one of them left "tag name" (its attribute text is the longest of theirs); whether one of them
 *  is a start candidate; the set of the known names among theirs, as bits; and whether it holds
 *  more than one. Two candidates still in "tag name" merge too, and leave it at the same
 *  character: of their names, only the one from the later "<" can be a known name (the others
 *  hold that "<"), so a slot in "tag name" reads its name from the letter of its latest "<".
 *  Doubt: what could hide an end candidate from parse5, followed at every character over all the
 *  chunks:
 *  - comment: from each "<!--" to the next "-->"; and from each "<![CDATA[" to the next "]]>";
 *  - bogus: from each other "<!", each "<?", and each "</" followed by neither an ASCII letter nor
 *    ">", to the next ">";
 *  - raw: one counter per name whose content is text: +1 at the end of a slot that holds a start
 *    candidate and that name; −1 (never under 0) at the end of a sure end candidate of that name
 *    (below);
 *  - depth: +1 at the end of a slot that holds a start candidate and a scope-ending name; it never
 *    comes down (an end tag of these names that parse5 ignores would let a count come down too
 *    early).
 *  An end candidate is sure when, at its "<", no slot is open, neither comment nor bogus holds,
 *  and no raw counter but its own name's is above 0; and, at its end, it is alone in its slot and
 *  ends at a ">". Any other end candidate lowers nothing.
 *  The counts. One stack per formatting name; each entry keeps its attribute length, the depth and
 *  the cell of its chunk when it was pushed. At the end of each slot (in the order slots end;
 *  slots ending together in the order of their first "<"):
 *  - a slot that holds a start candidate pushes an entry on the stack of each formatting name it
 *    holds;
 *  - a sure end candidate of a formatting name pops the last entry of its name, only when that
 *    entry was pushed at the current depth and in the cell of this chunk;
 *  - then `copied` adds the attribute lengths of all the entries of all the stacks, and `rebuilt`
 *    the number of these entries.
 *  Once more at the end of each chunk (a block Markdown makes there may rebuild once what is still
 *  open), `copied` and `rebuilt` add the same sums. `names`: the sum, over slots, of their names
 *  squared (parse5 compares each new name with every name the tag holds already, getTokenAttr: n
 *  names cost n²/2 comparisons). */
export function rawTagCost(
  chunks: readonly string[],
  cells?: readonly number[],
): { names: number; copied: number; rebuilt: number } {
  const text = chunks.join("");
  let names = 0;
  let copied = 0;
  let rebuilt = 0;

  let slots = Array.from({ length: 10 }, emptySlot);
  let next = Array.from({ length: 10 }, emptySlot);
  const ending = Array.from({ length: 10 }, emptySlot);
  let endingCount = 0;
  const incoming = emptySlot();

  // The doubt.
  let comment = false;
  let commentFrom = 0;
  let cdata = false;
  let cdataFrom = 0;
  let bogus = false;
  const raw = new Array<number>(RAW_NAMES.length).fill(0);
  let rawMask = 0;
  let depth = 0;

  // The stacks of the formatting names.
  const stacks = FORMATTING_NAMES.map(() => [] as Array<{ length: number; depth: number; cell: number }>);
  let stackLength = 0;
  let stackCount = 0;

  const setRaw = (index: number, value: number) => {
    raw[index] = value;
    const bit = 1 << (RAW_FIRST + index);
    rawMask = value > 0 ? rawMask | bit : rawMask & ~bit;
  };

  /** The known name of a slot leaving "tag name" at `at`. */
  const nameAt = (slot: Slot, at: number) => {
    if (at - slot.nameStart <= LONGEST_KNOWN) {
      const known = KNOWN.get(text.slice(slot.nameStart, at).toLowerCase());
      if (known) {
        slot.low |= known.low;
        slot.high |= known.high;
      }
    }
    slot.attributeStart = at;
  };

  const finish = (slot: Slot, at: number, atGt: boolean, cell: number) => {
    const length = at - slot.attributeStart;
    names += slot.names * slot.names;
    if (slot.start) {
      for (let i = 0; i < FORMATTING_NAMES.length; i++) {
        if (slot.low & (1 << i)) {
          stacks[i].push({ length, depth, cell });
          stackLength += length;
          stackCount++;
        }
      }
      for (let i = 0; i < RAW_NAMES.length; i++) if (slot.low & (1 << (RAW_FIRST + i))) setRaw(i, raw[i] + 1);
      if (slot.high) depth++;
    } else if (!slot.several && atGt && slot.clear) {
      const ownRaw = slot.low & ~FORMATTING_MASK;
      if ((slot.rawAtLt & ~ownRaw) === 0) {
        for (let i = 0; i < FORMATTING_NAMES.length; i++) {
          if (!(slot.low & (1 << i))) continue;
          const stack = stacks[i];
          const last = stack[stack.length - 1];
          if (last && last.depth === depth && last.cell === cell) {
            stack.pop();
            stackLength -= last.length;
            stackCount--;
          }
        }
        for (let i = 0; i < RAW_NAMES.length; i++)
          if (ownRaw & (1 << (RAW_FIRST + i))) setRaw(i, Math.max(0, raw[i] - 1));
      }
    }
    copied += stackLength;
    rebuilt += stackCount;
  };

  const endTogether = (at: number, atGt: boolean, cell: number) => {
    // In the order of their first "<".
    for (let i = 1; i < endingCount; i++) {
      for (let j = i; j > 0 && ending[j].firstLt < ending[j - 1].firstLt; j--) {
        const swap = ending[j];
        ending[j] = ending[j - 1];
        ending[j - 1] = swap;
      }
    }
    for (let i = 0; i < endingCount; i++) {
      finish(ending[i], at, atGt, cell);
      ending[i].active = false;
    }
    endingCount = 0;
  };

  // The states that hold a slot, as bits.
  let occupied = 0;

  let position = 0;
  for (let chunk = 0; chunk < chunks.length; chunk++) {
    const cell = cells?.[chunk] ?? -1;
    const end = position + chunks[chunk].length;
    for (let g = position; g < end; g++) {
      const code = text.charCodeAt(g);

      // Most characters change nothing: inside a name or a value, or outside any tag.
      if ((occupied & MOVING) === 0 && !SPECIAL[code] && !(isAsciiLetter(code) && SPECIAL[text.charCodeAt(g - 1)]))
        continue;

      // The doubt that starts at a "<".
      if (code === 60) {
        const after = text.charCodeAt(g + 1);
        if (text.startsWith("<!--", g)) {
          comment = true;
          commentFrom = g + 4;
        } else if (text.startsWith("<![CDATA[", g)) {
          cdata = true;
          cdataFrom = g + 9;
        } else if (after === 33 || after === 63) bogus = true;
        else if (after === 47) {
          const third = text.charCodeAt(g + 2);
          if (!isAsciiLetter(third) && third !== 62) bogus = true;
        }
      }

      // A candidate whose name starts on this letter, and what holds at its "<".
      let candidate = 0; // 1: a start candidate, 2: an end candidate
      let lt = 0;
      let clear = false;
      if (isAsciiLetter(code)) {
        if (g >= 1 && text.charCodeAt(g - 1) === 60) {
          candidate = 1;
          lt = g - 1;
        } else if (g >= 2 && text.charCodeAt(g - 1) === 47 && text.charCodeAt(g - 2) === 60) {
          candidate = 2;
          lt = g - 2;
        }
        if (candidate === 2) {
          clear = !comment && !cdata && !bogus;
          for (let s = 0; s < 10 && clear; s++) if (slots[s].active) clear = false;
        }
      }

      // Every slot takes the character.
      let nextOccupied = 0;
      for (let s = 0; s < 10; s++) {
        const slot = slots[s];
        if (!slot.active) continue;
        const result = step(s, code);
        const state = result & 15;
        if (s === TAG_NAME && state !== TAG_NAME) nameAt(slot, g);
        if (result & NAME_STARTED) slot.names++;
        if (state === END) copySlot(ending[endingCount++], slot);
        else {
          mergeSlot(next[state], slot);
          nextOccupied |= 1 << state;
        }
        slot.active = false;
      }
      const swap = slots;
      slots = next;
      next = swap;
      occupied = nextOccupied;

      if (candidate !== 0) {
        incoming.active = true;
        incoming.names = 0;
        incoming.attributeStart = Number.POSITIVE_INFINITY;
        incoming.start = candidate === 1;
        incoming.low = 0;
        incoming.high = 0;
        incoming.several = false;
        incoming.firstLt = lt;
        incoming.nameStart = g;
        incoming.clear = clear;
        incoming.rawAtLt = rawMask;
        mergeSlot(slots[TAG_NAME], incoming);
        occupied |= 1 << TAG_NAME;
      }

      // The doubt that ends at a ">", then the slots that end there.
      if (code === 62) {
        if (comment && g - 2 >= commentFrom && text.charCodeAt(g - 1) === 45 && text.charCodeAt(g - 2) === 45)
          comment = false;
        if (cdata && g - 2 >= cdataFrom && text.charCodeAt(g - 1) === 93 && text.charCodeAt(g - 2) === 93)
          cdata = false;
        bogus = false;
      }
      if (endingCount > 0) endTogether(g, true, cell);
    }
    position = end;

    if (chunk === chunks.length - 1) {
      // The slots still open end with the text.
      for (let s = 0; s < 10; s++) {
        const slot = slots[s];
        if (!slot.active) continue;
        if (s === TAG_NAME) nameAt(slot, text.length);
        copySlot(ending[endingCount++], slot);
        slot.active = false;
      }
      occupied = 0;
      if (endingCount > 0) endTogether(text.length, false, cell);
    }
    copied += stackLength;
    rebuilt += stackCount;
  }
  return { names, copied, rebuilt };
}

/** A bound passed inside the chain: the reason the page gives for showing the text plainly. */
class Refused extends Error {
  readonly reason: "tooLong" | "tooDense";
  constructor(reason: "tooLong" | "tooDense") {
    super(reason);
    this.reason = reason;
  }
}

type Parent = { children: Array<RootContent | ElementContent> };

/** The values of the raw nodes, in document order, each with the table cell Markdown made that
 *  holds it, weighed before parse5 reads any of them. A walk by a stack: the tree is not yet
 *  bounded in depth. */
function rawTagBound(found: Found) {
  return (tree: Root) => {
    const values: string[] = [];
    const cells: number[] = [];
    let cellCount = 0;
    const stack: Array<[RootContent, number]> = [];
    for (let i = tree.children.length - 1; i >= 0; i--) stack.push([tree.children[i], -1]);
    while (stack.length > 0) {
      const [node, cell] = stack.pop()!;
      if (node.type === "raw") {
        values.push(node.value);
        cells.push(cell);
        const start = node.position?.start.offset;
        if (start !== undefined) {
          found.rawStarts.push(start);
          found.rawValues.push(node.value);
        }
      } else if (node.type === "element") {
        // parse5 never lets an end tag written in a cell close an element opened before the table.
        const own = node.tagName === "td" || node.tagName === "th" ? cellCount++ : cell;
        for (let i = node.children.length - 1; i >= 0; i--) stack.push([node.children[i], own]);
      }
    }
    if (values.length === 0) return;
    const cost = rawTagCost(values, cells);
    if (cost.names > ATTRIBUTE_NAMES_BOUND || cost.copied > COPIED_BOUND || cost.rebuilt > REBUILT_BOUND)
      throw new Refused("tooDense");
  };
}

/** The characters of every property of the tree, counted before the sanitizer, the style filter,
 *  the links and the page read them: the elements parse5 rebuilt share their strings in memory,
 *  but each reader would go over every copy. */
function copiedAttributes(bound: number) {
  return (tree: Root) => {
    let total = 0;
    const stack: RootContent[] = [...tree.children];
    while (stack.length > 0) {
      const node = stack.pop()!;
      if (node.type !== "element") continue;
      for (const value of Object.values(node.properties)) {
        if (typeof value === "string") total += value.length;
        else if (Array.isArray(value)) for (const item of value) total += String(item).length + 1;
      }
      if (total > bound) throw new Refused("tooLong");
      for (const child of node.children) stack.push(child);
    }
  };
}

interface MarkdownNode {
  type: string;
  value?: string;
  children?: MarkdownNode[];
}

/** Each line ending in a text node becomes a break, as SillyTavern's and Agnai's
 *  simpleLineBreaks do: a long « about » written line by line would otherwise show as one block
 *  of lines run together. Code and written HTML are not text nodes, and keep theirs. A walk by a
 *  stack: the tree is not yet bounded in depth. */
function lineBreaks(tree: MarkdownNode): void {
  const stack: MarkdownNode[] = [tree];
  while (stack.length > 0) {
    const parent = stack.pop()!;
    const children = parent.children;
    if (!children) continue;
    let changed = false;
    const next: MarkdownNode[] = [];
    for (const child of children) {
      if (child.type === "text" && child.value !== undefined && /[\r\n]/.test(child.value)) {
        changed = true;
        child.value.split(/\r\n|\r|\n/).forEach((piece, i) => {
          if (i > 0) next.push({ type: "break" });
          if (piece !== "") next.push({ type: "text", value: piece });
        });
      } else {
        next.push(child);
        if (child.children) stack.push(child);
      }
    }
    if (changed) parent.children = next;
  }
}

/** CommonMark, tables, strikethrough and single line breaks, nothing else: what the card sites
 *  show (SillyTavern's showdown with tables, strikethrough and simpleLineBreaks, without
 *  automatic links nor task lists). Not remark-gfm whole: its automatic links search addresses
 *  by an expression that goes over the text again at each punctuation mark, and its footnotes
 *  write an English heading into the card's frame. */
function dialect(this: Processor) {
  const data = this.data() as { micromarkExtensions?: unknown[]; fromMarkdownExtensions?: unknown[] };
  if (!data.micromarkExtensions) data.micromarkExtensions = [];
  if (!data.fromMarkdownExtensions) data.fromMarkdownExtensions = [];
  data.micromarkExtensions.push(gfmTable(), gfmStrikethrough());
  data.fromMarkdownExtensions.push(gfmTableFromMarkdown(), gfmStrikethroughFromMarkdown());
  noDefinitions.call(this);
  return lineBreaks;
}

interface Found {
  remoteHosts: string[];
  keptPayload: number;
  /** The raw HTML handed to parse5, each value with the offset parse5 counts its characters from,
   *  in document order: where an attribute can be read as it was written. */
  rawStarts: number[];
  rawValues: string[];
}

// Below this, a text is barely seen and can carry a hidden message (decision 1).
const FAINTEST = 0.3;
// On the narrowest screen aimed at (360 px), the page's margins and the frame leave 278 px.
const COLUMN = 278;
// The most the sides of nested boxes may take from that column, left and right together.
const SIDES_BOUND = 128;
// A column narrower holds fewer than fifteen characters.
const NARROWEST = 120;
// What an inline box may paint above or below its line: what an ordinary highlight spills.
const INLINE_SPILL = 4;
// Within a hair of the bound, a product of opacities still counts as reaching it.
const EPSILON = 1e-9;

const INLINE_TAGS = new Set(["span", "a", "b", "strong", "i", "em", "u", "s", "del", "small", "mark", "code", "sub", "sup"]);
const HEADINGS: Record<string, string> = { h1: "h3", h2: "h4", h3: "h5", h4: "h6", h5: "h6", h6: "h6" };
const ALIGNS = new Set(["left", "right", "center", "justify"]);
const BORDER_WIDTHS: Record<string, number> = { thin: 1, medium: 3, thick: 5 };
const BORDER_STYLES = new Set(["none", "solid", "dashed", "dotted", "double"]);

interface Context {
  alpha: number;
  opacity: number;
  sides: number;
  width: number;
  lists: number;
  pre: boolean;
  code: boolean;
  mark: boolean;
}

function pixels(word: string): number {
  if (word in BORDER_WIDTHS) return BORDER_WIDTHS[word];
  const number = parseFloat(word);
  return Number.isNaN(number) ? 0 : number;
}

/** Top, right, bottom and left of a shorthand of 1 to 4 values, in px. */
function fourSides(value: string): [number, number, number, number] {
  const words = value.split(/\s+/).map(pixels);
  const [top, right = top, bottom = top, left = right] = words;
  return [top, right, bottom, left];
}

/** The width of a border shorthand: its own, or medium for a style written without one. */
function borderWidth(value: string): number {
  const words = value.split(/\s+/);
  for (const word of words) if (word in BORDER_WIDTHS || /^\d/.test(word)) return pixels(word);
  return words.some((word) => BORDER_STYLES.has(word)) ? BORDER_WIDTHS.medium : 0;
}

/** Left plus right of a declaration that takes from the text's column; null for any other. */
function sideWidth(name: string, value: string): number | null {
  switch (name) {
    case "margin":
    case "padding":
    case "border-width": {
      const [, right, , left] = fourSides(value);
      return right + left;
    }
    case "margin-left":
    case "margin-right":
    case "padding-left":
    case "padding-right":
      return pixels(value);
    case "border":
      return 2 * borderWidth(value);
    case "border-left":
    case "border-right":
      return borderWidth(value);
    default:
      return null;
  }
}

/** The larger of top and bottom of a declaration an inline box would paint over the lines
 *  around it; null for any other. */
function spill(name: string, value: string): number | null {
  switch (name) {
    case "padding":
    case "border-width": {
      const [top, , bottom] = fourSides(value);
      return Math.max(top, bottom);
    }
    case "padding-top":
    case "padding-bottom":
      return pixels(value);
    case "border":
    case "border-top":
    case "border-bottom":
      return borderWidth(value);
    default:
      return null;
  }
}

/** The text of a link as the eye reads it: its text nodes joined, and the alt of each image
 *  between spaces, in order; and whether it holds an image. */
function linkText(link: Element): { text: string; picture: boolean } {
  let text = "";
  let picture = false;
  const stack: ElementContent[] = [...link.children].reverse();
  while (stack.length > 0) {
    const node = stack.pop()!;
    if (node.type === "text") text += node.value;
    else if (node.type === "element") {
      if (node.tagName === "img") {
        picture = true;
        if (typeof node.properties.alt === "string") text += " " + node.properties.alt + " ";
      }
      for (let i = node.children.length - 1; i >= 0; i--) stack.push(node.children[i]);
    }
  }
  return { text, picture };
}

/** The style of an element, filtered for its place in the tree; the context its children get. */
function placeStyle(element: Element, context: Context): Context {
  const tag = element.tagName;
  const inner: Context = { ...context };
  // The indentations our own stylesheet gives: to the first three lists or quotes of the path,
  // in any mix, and to the first pre, code and mark.
  let indent = 0;
  if ((tag === "ul" || tag === "ol" || tag === "blockquote") && inner.lists < 3) {
    indent += tag === "blockquote" ? 16 : 24;
    inner.lists++;
  }
  if (tag === "pre" && !inner.pre) {
    indent += 24;
    inner.pre = true;
  }
  if (tag === "code" && !inner.code) {
    indent += 8;
    inner.code = true;
  }
  if (tag === "mark" && !inner.mark) {
    indent += 4;
    inner.mark = true;
  }
  inner.sides += indent;

  const style = element.properties.style;
  if (typeof style !== "string") {
    delete element.properties.style;
    return inner;
  }
  const declarations = cleanDeclarations(style);
  const dropped = new Set<number>();

  // The readability of the text: an opacity, then a colour, against what the ancestors set.
  const opacityAt = declarations.findIndex(([name]) => name === "opacity");
  if (opacityAt >= 0) {
    const value = declarations[opacityAt][1];
    const opacity = value.endsWith("%") ? parseFloat(value) / 100 : parseFloat(value);
    if (inner.alpha * inner.opacity * opacity < FAINTEST - EPSILON) dropped.add(opacityAt);
    else inner.opacity *= opacity;
  }
  const colorAt = declarations.findIndex(([name]) => name === "color");
  if (colorAt >= 0) {
    const value = declarations[colorAt][1];
    // A colour that takes its parent's is that same faint colour: the count goes on.
    if (!INHERITED_COLOR.has(value)) {
      const alpha = value === "initial" ? 1 : colorAlpha(value);
      if (alpha * inner.opacity < FAINTEST - EPSILON) dropped.add(colorAt);
      else inner.alpha = alpha;
    }
  }

  const display = declarations.find(([name]) => name === "display")?.[1];
  const inline = tag !== "img" && (display === "inline" || (display === undefined && INLINE_TAGS.has(tag)));
  // A table scrolls sideways in its own box: its cells cut no text.
  const cell = tag === "td" || tag === "th";

  declarations.forEach(([name, value], index) => {
    if (dropped.has(index)) return;
    if (inline) {
      const painted = spill(name, value);
      if (painted !== null && painted > INLINE_SPILL) {
        dropped.add(index);
        return;
      }
    }
    if (!cell) {
      const taken = sideWidth(name, value);
      if (taken !== null) {
        if (inner.sides + taken > SIDES_BOUND) {
          dropped.add(index);
          return;
        }
        inner.sides += taken;
      }
    }
    if (tag !== "img" && (name === "width" || name === "max-width") && value !== "auto") {
      const width = value.endsWith("%")
        ? (inner.width * parseFloat(value)) / 100
        : Math.min(inner.width, parseFloat(value));
      if (width < NARROWEST) {
        dropped.add(index);
        return;
      }
      inner.width = width;
    }
  });

  const written: string[] = [];
  declarations.forEach(([name, value], index) => {
    if (dropped.has(index)) return;
    // Our stylesheet's max-width: 100% comes after the card's inline style: never wider than the
    // box.
    if (name === "max-width" && value.endsWith("px")) written.push(`max-width: min(100%, ${value})`);
    else written.push(`${name}: ${value}`);
    // A flex row of a hundred children would shrink each to a letter and cut the last ones.
    if (name === "display" && value === "flex") written.push("flex-wrap: wrap");
  });
  if (written.length > 0) element.properties.style = written.join("; ");
  else delete element.properties.style;
  return inner;
}

/** The value of an attribute as the card wrote it in the start tag of an element parse5 made, or
 *  null when that tag cannot be found or does not carry it. hastscript has already turned a width
 *  or a span into a number with Number(), which reads "1e3", "0x10" or " 7 " as numbers a browser
 *  reads otherwise; only the written text tells them apart. parse5 counts an element's offset from
 *  the start of the raw value that holds it, so the tag is read there, never in the Markdown text,
 *  where a quote's or a list's own marks would shift it. The first of two attributes of one name
 *  wins, as in parse5; a character reference is left undecoded, and is not digits. */
function writtenAttribute(found: Found, element: Element, name: string): string | null {
  const offset = element.position?.start.offset;
  if (offset === undefined) return null;
  let low = 0;
  let high = found.rawStarts.length - 1;
  let at = -1;
  while (low <= high) {
    const middle = (low + high) >> 1;
    if (found.rawStarts[middle] <= offset) {
      at = middle;
      low = middle + 1;
    } else high = middle - 1;
  }
  if (at < 0) return null;
  const html = found.rawValues[at];
  let i = offset - found.rawStarts[at];
  if (html.charCodeAt(i) !== 60) return null;
  const nameStart = ++i;
  while (i < html.length && !isTagBlank(html.charCodeAt(i)) && html[i] !== "/" && html[i] !== ">") i++;
  const tag = html.slice(nameStart, i).toLowerCase();
  // parse5 makes an img of <image>.
  if (tag !== element.tagName && !(tag === "image" && element.tagName === "img")) return null;
  while (i < html.length) {
    const code = html.charCodeAt(i);
    if (isTagBlank(code) || code === 47) {
      i++;
      continue;
    }
    if (code === 62) return null;
    const start = i++;
    while (i < html.length && !isTagBlank(html.charCodeAt(i)) && !"/>=".includes(html[i])) i++;
    const attribute = html.slice(start, i).toLowerCase();
    while (i < html.length && isTagBlank(html.charCodeAt(i))) i++;
    let value = "";
    if (html[i] === "=") {
      i++;
      while (i < html.length && isTagBlank(html.charCodeAt(i))) i++;
      const quote = html[i];
      if (quote === '"' || quote === "'") {
        const end = html.indexOf(quote, i + 1);
        if (end < 0) return null;
        value = html.slice(i + 1, end);
        i = end + 1;
      } else {
        const valueStart = i;
        while (i < html.length && !isTagBlank(html.charCodeAt(i)) && html[i] !== ">") i++;
        value = html.slice(valueStart, i);
      }
    }
    if (attribute === name) return value;
  }
  return null;
}

/** A width, a height or a span kept only when written in digits alone, the only form HTML reads
 *  as the number it shows. */
function wholeNumber(found: Found, element: Element, name: string): number | null {
  const written = writtenAttribute(found, element, name);
  return written !== null && /^\d+$/.test(written) ? Number(written) : null;
}

// The longest number, sign included, a list's marker shows whole in the room the stylesheet
// gives it (24px of indent, and the frame's padding or the indent of the lists and quotes around
// it): "99." and "-9." fit, "100." may not, "123456789." loses its first digits to the frame.
const MARKER_DIGITS = 2;

/** The number HTML reads in a list's start attribute: blanks, a sign, digits, the rest ignored;
 *  1 when there are none or they do not fit the browser's integer. */
function listStart(found: Found, list: Element): number {
  const written = writtenAttribute(found, list, "start");
  const start = list.properties.start;
  // A list of Markdown has no tag to read: its start is the number it was given.
  const value = written ?? (start === undefined || start === null ? "" : String(start));
  const match = /^[\t\n\f\r ]*([+-]?\d+)/.exec(value);
  const parsed = match ? Number(match[1]) : typeof start === "number" ? start : 1;
  return Number.isInteger(parsed) && Math.abs(parsed) <= 2_147_483_647 ? parsed : 1;
}

/** An ordered list whose numbers are longer than its marker's room shows them as each item's own
 *  text, without markers (numbered-list): drawn in the margin, "123456789." would lose its first
 *  digits to the frame, and the author's text would be cut. Its items are those the browser
 *  counts: down its tree, not into a list of their own. Each element is read by one list only. */
function numberLongList(found: Found, list: Element) {
  const items: Element[] = [];
  const stack: ElementContent[] = [...list.children].reverse();
  while (stack.length > 0) {
    const node = stack.pop()!;
    if (node.type !== "element" || node.tagName === "ol" || node.tagName === "ul") continue;
    if (node.tagName === "li") items.push(node);
    for (let i = node.children.length - 1; i >= 0; i--) stack.push(node.children[i]);
  }
  if (items.length === 0) return;
  const start = listStart(found, list);
  const last = start + items.length - 1;
  if (Math.max(String(start).length, String(last).length) <= MARKER_DIGITS) return;
  list.properties.className = ["numbered-list"];
  items.forEach((item, index) => numberItem(item, `${start + index}.`));
}

// The longest text a heading keeps its look for, in code points: about two lines of a phone at
// heading size. Cards often write whole paragraphs behind `##` or `###`: laid out as headings they
// are walls of bold text, and a heading of 600 characters fills a phone's screen.
const HEADING_LONGEST = 120;

const SOURCE_HEADINGS = new Set(["h1", "h2", "h3", "h4", "h5", "h6"]);

/** Each heading whose own text is longer than HEADING_LONGEST becomes a paragraph, its words and
 *  attributes kept: a paragraph to the eye and to a screen reader. One walk after the tree's end
 *  adds up each element's length, capped past the longest, so that headings nested in headings
 *  (an HTML presentation can write them) are never counted again. Run before the headings are
 *  renamed. */
function longHeadingsAsParagraphs(tree: Root): void {
  const lengths = new Map<Element, number>();
  const stack: Array<[RootContent | ElementContent, boolean]> = [];
  for (const child of tree.children) stack.push([child, false]);
  while (stack.length > 0) {
    const [node, done] = stack.pop()!;
    if (node.type !== "element") continue;
    if (!done) {
      stack.push([node, true]);
      for (const child of node.children) stack.push([child, false]);
      continue;
    }
    let length = 0;
    for (const child of node.children) {
      if (length > HEADING_LONGEST) break;
      if (child.type === "text") {
        // Code points: a pair of surrogates is one letter.
        const iterator = child.value[Symbol.iterator]();
        while (length <= HEADING_LONGEST && !iterator.next().done) length++;
      } else if (child.type === "element") length += lengths.get(child) ?? 0;
    }
    lengths.set(node, Math.min(length, HEADING_LONGEST + 1));
    if (SOURCE_HEADINGS.has(node.tagName) && length > HEADING_LONGEST) node.tagName = "p";
  }
}

/** The card's own rules, on the tree already sanitized, in one walk that knows the ancestors. */
function cardRules(found: Found) {
  return (tree: Root) => {
    boundDepth()(tree);
    longHeadingsAsParagraphs(tree);
    const appOrigin = globalThis.location?.origin;
    const unwrap = new Set<Element>();
    const seenHosts = new Set<string>();
    let pixelsKept = 0;

    const root: Context = {
      alpha: 1,
      opacity: 1,
      sides: 0,
      width: COLUMN,
      lists: 0,
      pre: false,
      code: false,
      mark: false,
    };
    // The cells of each table, and the slots their spans cover, added up: a span is bounded alone,
    // but thousands of them make a grid the browser's layout takes minutes over.
    const grids = new Map<Element, { cells: Element[]; slots: number }>();
    const stack: Array<[RootContent | ElementContent, Context, Element | null]> = [];
    for (let i = tree.children.length - 1; i >= 0; i--) stack.push([tree.children[i], root, null]);
    while (stack.length > 0) {
      const [node, context, outer] = stack.pop()!;
      if (node.type !== "element") continue;
      const element = node;
      const properties: Properties = element.properties;
      let inner = context;

      if (element.tagName === "a") {
        const target = linkTarget(properties.href, appOrigin);
        if (target === null) {
          // Its text stays, in its parent's place.
          unwrap.add(element);
          for (let i = element.children.length - 1; i >= 0; i--) stack.push([element.children[i], context, outer]);
          continue;
        }
        properties.href = target;
        const { text, picture } = linkText(element);
        const misleading = misleadingHost(text, target);
        if (misleading) {
          properties.dataReal = misleading.real;
          if (misleading.shown !== null) properties.dataShown = misleading.shown;
        } else if (picture) {
          // A picture does not show where it leads, and is never underlined: the link asks first,
          // whatever text stands beside it.
          const url = new URL(target);
          properties.dataReal =
            url.protocol === "mailto:" ? url.pathname.slice(url.pathname.lastIndexOf("@") + 1) : url.hostname;
          properties.dataPicture = "true";
        }
      }

      if (element.tagName in HEADINGS) element.tagName = HEADINGS[element.tagName];
      if (element.tagName === "ol") numberLongList(found, element);

      inner = placeStyle(element, context);

      if (element.tagName === "img") {
        for (const name of ["width", "height"]) {
          if (properties[name] === undefined) continue;
          const value = wholeNumber(found, element, name);
          if (value === null) delete properties[name];
          else properties[name] = value;
        }
        const src = properties.src;
        const source = imageSource(src);
        if (source.kind === "remote" && !seenHosts.has(source.host)) {
          seenHosts.add(source.host);
          found.remoteHosts.push(source.host);
        }
        if ((source.kind === "inline" || source.kind === "tooLarge") && typeof src === "string")
          found.keptPayload += src.length - src.indexOf(",") - 1;
        if (source.kind === "inline") {
          const cost = source.width * source.height * (source.progressive ? 2.5 : 1);
          if (pixelsKept + cost > INLINE_PIXEL_BUDGET) properties.dataOverBudget = "true";
          else pixelsKept += cost;
        }
      }

      if (properties.align !== undefined) {
        const align = typeof properties.align === "string" ? properties.align.toLowerCase() : "";
        if (ALIGNS.has(align)) properties.align = align;
        else delete properties.align;
      }
      for (const name of ["colSpan", "rowSpan"]) {
        if (properties[name] === undefined) continue;
        // A cell spread over a million columns freezes the layout.
        const value = wholeNumber(found, element, name.toLowerCase());
        if (value === null || value < 1 || value > 100) delete properties[name];
        else properties[name] = value;
      }
      const table = element.tagName === "table" ? element : outer;
      if (table !== null && (element.tagName === "td" || element.tagName === "th")) {
        const grid = grids.get(table) ?? { cells: [], slots: 0 };
        grids.set(table, grid);
        grid.cells.push(element);
        grid.slots += Number(properties.colSpan ?? 1) * Number(properties.rowSpan ?? 1);
      }

      for (let i = element.children.length - 1; i >= 0; i--) stack.push([element.children[i], inner, table]);
    }

    // Past the budget, a table keeps its cells, side by side, without their spans.
    for (const { cells, slots } of grids.values()) {
      if (slots <= SPAN_BUDGET) continue;
      for (const cell of cells) {
        delete cell.properties.colSpan;
        delete cell.properties.rowSpan;
      }
    }

    // The links that lead nowhere give their place to their content, and each table gets the box
    // that scrolls sideways on a phone.
    const parents: Parent[] = [tree];
    while (parents.length > 0) {
      const parent = parents.pop()!;
      let changed = false;
      const next: Array<RootContent | ElementContent> = [];
      const pending: Array<RootContent | ElementContent> = [...parent.children].reverse();
      while (pending.length > 0) {
        const node = pending.pop()!;
        if (node.type === "element" && unwrap.has(node)) {
          changed = true;
          for (let i = node.children.length - 1; i >= 0; i--) pending.push(node.children[i]);
          continue;
        }
        if (node.type === "element" && node.tagName === "table") {
          changed = true;
          next.push({ type: "element", tagName: "div", properties: { className: ["card-table"] }, children: [node] });
          parents.push(node);
          continue;
        }
        next.push(node);
        if (node.type === "element") parents.push(node);
      }
      if (changed) parent.children = next;
    }
  };
}

/** Never throws: a bound passed inside the chain gives its own reason, anything else that goes
 *  wrong is "failed", and the page shows the text plainly. */
export function renderPresentation(text: string): RenderedPresentation {
  try {
    const length = layoutLength(text);
    const refusal = layoutRefusal(text, length);
    if (refusal !== null) return { kind: "plain", reason: refusal };
    if (text.length - length > INLINE_IMAGES_BOUND) return { kind: "plain", reason: "tooLong" };

    const found: Found = { remoteHosts: [], keptPayload: 0, rawStarts: [], rawValues: [] };
    const processor = unified()
      .use(remarkParse)
      .use(dialect)
      .use(remarkRehype, { allowDangerousHtml: true })
      .use(rawTagBound, found)
      .use(rehypeRaw)
      .use(copiedAttributes, text.length + LAYOUT_BOUND)
      .use(rehypeSanitize, PRESENTATION_SCHEMA)
      .use(cardRules, found);
    const tree = processor.runSync(processor.parse(text)) as Root;
    // Measured again after the parse: only the payloads of the sources kept as images are left
    // out, and a text node of megabytes never reaches React.
    if (text.length - found.keptPayload > LAYOUT_BOUND) return { kind: "plain", reason: "tooLong" };
    return { kind: "laid-out", tree, remoteHosts: found.remoteHosts };
  } catch (error) {
    if (error instanceof Refused) return { kind: "plain", reason: error.reason };
    return { kind: "plain", reason: "failed" };
  }
}

// Below the h3 that names each field of what the model reads.
const MODEL_HEADINGS: Record<string, string> = { h1: "h4", h2: "h5", h3: "h6", h4: "h6", h5: "h6", h6: "h6" };

// The number written before an item of an ordered list and its "." or ")", read where the item
// starts.
const ITEM_NUMBER = /\d{1,9}[.)]/y;

/** Writes `number` at the head of a list item, as its own text: in the item's first paragraph
 *  when it has one, so that the number stays on its line. */
function numberItem(item: Element, number: string) {
  const text: Text = { type: "text", value: number + " " };
  const first = item.children.find((child) => child.type !== "text" || child.value.trim() !== "");
  if (first?.type === "element" && first.tagName === "p") first.children.unshift(text);
  else item.children.unshift(text);
}

/** Each table among these children in a box of its own that scrolls sideways, as a
 *  presentation's (cardRules): the frame hides what overflows it, and the last columns of a table
 *  wider than a phone would be text the model reads that the person could not reach. */
function boxTables<T extends RootContent | ElementContent>(children: T[], boxes: Set<Element>): T[] {
  return children.map((child) => {
    if (child.type !== "element" || child.tagName !== "table") return child;
    const box: Element = { type: "element", tagName: "div", properties: { className: ["card-table"] }, children: [child] };
    boxes.add(box);
    return box as T;
  });
}

/** The headings of the model's text, under its field's; each item of an ordered list numbered as
 *  it is written, as the item's own text (the layout would count on from the first, and show 2
 *  where the model reads 7; and its marker, drawn in the margin, would lose its first digits to
 *  the frame);
 *  each table in a box that scrolls; then its depth bounded. A walk by a stack: the tree is not
 *  yet bounded in depth. */
function modelTree() {
  return (tree: Root, file: { value: unknown }) => {
    const source = String(file.value);
    // A box holds its table already: boxing it again would never end.
    const boxes = new Set<Element>();
    longHeadingsAsParagraphs(tree);
    tree.children = boxTables(tree.children, boxes);
    const stack: RootContent[] = [...tree.children];
    while (stack.length > 0) {
      const node = stack.pop()!;
      if (node.type !== "element") continue;
      if (!boxes.has(node)) node.children = boxTables(node.children, boxes);
      if (node.tagName in MODEL_HEADINGS) node.tagName = MODEL_HEADINGS[node.tagName];
      if (node.tagName === "ol") {
        // Drawn without markers (model-list): the number is the item's own text.
        node.properties.className = ["model-list"];
        for (const item of node.children) {
          if (item.type !== "element" || item.tagName !== "li") continue;
          ITEM_NUMBER.lastIndex = item.position?.start.offset ?? -1;
          const written = ITEM_NUMBER.lastIndex >= 0 ? ITEM_NUMBER.exec(source) : null;
          if (!written) continue;
          numberItem(item, written[0]);
        }
      }
      for (const child of node.children) stack.push(child);
    }
    boundDepth()(tree);
  };
}

/** Every cell a row of the model's text writes is laid out. The layout would stop each row at
 *  the delimiter row's count and drop the cells after it: text the model reads that the person
 *  would not. Only the longer rows are widened, each to its own count: padding every row to the
 *  longest would draw rows × columns cells, which the layout's cost does not count. */
const allCells: typeof defaultHandlers.tableRow = (state, node: TableRow, parent) => {
  if (parent?.type === "table" && node.children.length > (parent.align ?? []).length) {
    const align = [...(parent.align ?? [])];
    while (align.length < node.children.length) align.push(null);
    return defaultHandlers.tableRow(state, node, { ...parent, align });
  }
  return defaultHandlers.tableRow(state, node, parent);
};

/** A text the model reads (a field of a card's definition), laid out as Markdown alone: the
 *  presentation's dialect without HTML, links nor images, which stay written as they are, the
 *  sanitizer behind it all the same. Bounded as a presentation is; never throws. */
export function renderModelText(text: string): RenderedPresentation {
  try {
    // A presentation's bounds, but no image is ever drawn from this text: a data: payload is
    // text like any other, and its whole length counts (text.length, layoutRefusal's default), as
    // it does after a presentation's parse.
    const refusal = layoutRefusal(text);
    if (refusal !== null) return { kind: "plain", reason: refusal };
    const processor = unified()
      .use(remarkParse)
      .use(dialect)
      .use(modelDialect)
      .use(remarkRehype, { handlers: { tableRow: allCells } })
      .use(rehypeSanitize, PRESENTATION_SCHEMA)
      .use(modelTree);
    // The text goes along as the file: modelTree reads each list item's number in it.
    const tree = processor.runSync(processor.parse(text), text) as Root;
    return { kind: "laid-out", tree, remoteHosts: [] };
  } catch {
    return { kind: "plain", reason: "failed" };
  }
}
